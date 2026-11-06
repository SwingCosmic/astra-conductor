import { createServer, type Socket } from "node:net";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrokerClient, canonical } from "../src/index.js";

const suite = process.platform === "win32" ? describe : describe.skip;
function frame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  const size = Buffer.alloc(4);
  size.writeInt32LE(bytes.length);
  return Buffer.concat([size, bytes]);
}
suite("broker named pipe authentication", () => {
  for (const validProof of [true, false])
    it(
      validProof
        ? "uses the Windows pipe address and exchanges authenticated sequential requests"
        : "refuses business requests when the server proof is forged",
      async () => {
        const identity = {
          vaultId: randomUUID(),
          ownerSid: "S-1-5-21-1001",
          clientId: "test-client",
          instanceId: "test-instance",
          accessToken: Buffer.alloc(32, 8).toString("base64url"),
        };
        const suffix = createHash("sha256")
          .update(`${identity.ownerSid}:${identity.vaultId}`)
          .digest("base64url");
        const slash = String.fromCharCode(92);
        const pipe =
          slash + slash + "." + slash + "pipe" + slash + `astra-credentials-v1-${suffix}`;
        let businessRequests = 0;
        let authenticated = false;
        const sockets = new Set<Socket>();
        const server = createServer((socket) => {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
          socket.on("error", () => undefined);
          const greeting = {
            protocolVersion: 1,
            vaultId: identity.vaultId,
            generation: "generation",
            nonce: Buffer.alloc(32, 3).toString("base64url"),
          };
          socket.write(frame(greeting));
          let buffer = Buffer.alloc(0);
          let hello: Record<string, unknown> | undefined;
          socket.on("data", (bytes: Buffer) => {
            buffer = Buffer.concat([buffer, bytes]);
            while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
              const length = buffer.readInt32LE(0);
              const value = JSON.parse(buffer.subarray(4, length + 4).toString()) as Record<
                string,
                unknown
              >;
              buffer = buffer.subarray(length + 4);
              if (!hello) {
                hello = value;
                const verifier = createHash("sha256").update(Buffer.alloc(32, 8)).digest();
                const proof = (role: string) =>
                  createHmac("sha256", verifier)
                    .update(
                      canonical([
                        "astra.pipe-auth.v1",
                        role,
                        1,
                        identity.vaultId,
                        "generation",
                        greeting.nonce,
                        identity.clientId,
                        identity.instanceId,
                        value.clientNonce,
                        false,
                      ]),
                    )
                    .digest("base64url");
                authenticated = value.proof === proof("client");
                socket.write(
                  frame({
                    proof: validProof ? proof("server") : Buffer.alloc(32).toString("base64url"),
                  }),
                );
              } else {
                businessRequests++;
                socket.write(
                  frame({
                    id: value.id,
                    ok: true,
                    result: { serviceStatus: "READY" },
                    error: null,
                  }),
                );
              }
            }
          });
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(pipe, resolve);
        });
        try {
          if (validProof) {
            const client = await BrokerClient.connect(identity);
            try {
              expect(await client.call("status")).toEqual({ serviceStatus: "READY" });
            } finally {
              client.close();
            }
          } else
            await expect(BrokerClient.connect(identity)).rejects.toThrow(
              "server-identity-mismatch",
            );
          expect(authenticated).toBe(true);
          expect(businessRequests).toBe(validProof ? 1 : 0);
        } finally {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
});
