import { createConnection, type Socket } from "node:net";
import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BrokerError, canonical, id, object, parseJson, requireValue, unb64 } from "./format.js";

export interface BrokerIdentity {
  vaultId: string;
  ownerSid: string;
  clientId: string;
  accessToken: string;
  instanceId: string;
}
class Frames {
  private buffer = Buffer.alloc(0);
  private failed = false;
  private waiting?: {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };
  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 2 * 1024 * 1024 + 4) return this.fail();
      this.deliver();
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      this.fail(
        ["ENOENT", "EACCES", "EPIPE", "ECONNREFUSED"].includes(error.code ?? "")
          ? `broker-pipe-${error.code!.toLowerCase()}`
          : "broker-disconnected",
      ),
    );
    socket.on("close", () => this.fail());
  }
  private fail(code = "broker-disconnected"): void {
    this.failed = true;
    this.socket.destroy();
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.reject(new BrokerError(code));
      this.waiting = undefined;
    }
  }
  private deliver(): void {
    if (!this.waiting || this.buffer.length < 4) return;
    const length = this.buffer.readInt32LE(0);
    if (length <= 0 || length > 2 * 1024 * 1024) return this.fail();
    if (this.buffer.length < length + 4) return;
    const pending = this.waiting;
    this.waiting = undefined;
    clearTimeout(pending.timer);
    const bytes = this.buffer.subarray(4, length + 4);
    this.buffer = this.buffer.subarray(length + 4);
    try {
      pending.resolve(parseJson(bytes));
    } catch {
      pending.reject(new BrokerError("invalid-broker-data"));
      this.fail();
    }
  }
  read(timeout: number): Promise<unknown> {
    if (this.failed) return Promise.reject(new BrokerError("broker-disconnected"));
    requireValue(!this.waiting, "concurrent-read");
    return new Promise((resolve, reject) => {
      this.waiting = {
        resolve,
        reject,
        timer: setTimeout(() => this.fail("broker-request-timeout"), timeout),
      };
      this.deliver();
    });
  }
  write(value: unknown): void {
    const bytes = Buffer.from(canonical(value));
    requireValue(bytes.length <= 2 * 1024 * 1024, "message-too-large");
    const size = Buffer.alloc(4);
    size.writeInt32LE(bytes.length);
    this.socket.write(Buffer.concat([size, bytes]));
  }
}
/** One authenticated, sequential connection. No request is automatically replayed. */
export class BrokerClient {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly socket: Socket,
    private readonly frames: Frames,
  ) {}
  static async connect(identity: BrokerIdentity): Promise<BrokerClient> {
    id(identity.vaultId);
    id(identity.clientId);
    id(identity.instanceId);
    requireValue(/^S-1-\d+(?:-\d+)+$/.test(identity.ownerSid), "invalid-owner");
    requireValue(process.platform === "win32", "platform-feature-unavailable");
    const suffix = createHash("sha256")
      .update(`${identity.ownerSid}:${identity.vaultId}`)
      .digest("base64url");
    const socket = createConnection(String.raw`\\.\pipe\astra-credentials-v1-${suffix}`);
    const frames = new Frames(socket);
    let stage = "greeting";
    try {
      const greeting = object(await frames.read(5_000), [
        "protocolVersion",
        "vaultId",
        "generation",
        "nonce",
      ]);
      requireValue(
        greeting.protocolVersion === 1 && greeting.vaultId === identity.vaultId,
        "server-identity-mismatch",
      );
      id(greeting.generation);
      unb64(greeting.nonce, 32);
      const nonce = randomBytes(32).toString("base64url");
      const token = unb64(identity.accessToken, 32);
      const verifier = createHash("sha256").update(token).digest();
      token.fill(0);
      try {
        const proof = (role: string) =>
          createHmac("sha256", verifier)
            .update(
              canonical([
                "astra.pipe-auth.v1",
                role,
                1,
                identity.vaultId,
                greeting.generation,
                greeting.nonce,
                identity.clientId,
                identity.instanceId,
                nonce,
                false,
              ]),
            )
            .digest();
        frames.write({
          protocolVersion: 1,
          clientId: identity.clientId,
          instanceId: identity.instanceId,
          clientNonce: nonce,
          proof: proof("client").toString("base64url"),
          management: false,
        });
        stage = "welcome";
        const welcome = object(await frames.read(5_000), ["proof"]);
        requireValue(
          timingSafeEqual(unb64(welcome.proof, 32), proof("server")),
          "server-identity-mismatch",
        );
      } finally {
        verifier.fill(0);
      }
      return new BrokerClient(socket, frames);
    } catch (error) {
      socket.destroy();
      if (error instanceof BrokerError && error.code === "broker-disconnected")
        throw new BrokerError(`broker-handshake-${stage}-disconnected`);
      throw error;
    }
  }
  call(method: string, params: unknown = {}): Promise<unknown> {
    const run = async () => {
      const requestId = randomUUID();
      this.frames.write({ protocolVersion: 1, id: requestId, method, params });
      const response = object(await this.frames.read(30_000), ["id", "ok", "result", "error"]);
      requireValue(response.id === requestId, "response-id-mismatch");
      if (response.ok !== true) {
        const code = response.error;
        throw new BrokerError(
          typeof code === "string" && /^[a-z][a-z0-9-]{0,100}$/.test(code)
            ? code
            : "broker-request-failed",
        );
      }
      requireValue(response.error === null);
      return response.result;
    };
    const result = this.tail.then(run);
    this.tail = result.catch(() => undefined);
    return result;
  }
  close(): void {
    this.socket.destroy();
  }
}
