import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { NodeHttpService } from "../src/platform/node/http-service.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return address.port;
}

describe("owned Node HTTP transport", () => {
  it("accepts built-in Request objects with streaming body, headers, query and method", async () => {
    const upstream = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () =>
        response.end(
          JSON.stringify({
            method: request.method,
            path: request.url,
            header: request.headers["x-check"],
            body,
          }),
        ),
      );
    });
    const port = await listen(upstream);
    const http = new NodeHttpService({});
    try {
      const response = await http.fetch(
        new Request(`http://127.0.0.1:${port}/request?q=1`, {
          method: "POST",
          headers: { "X-Check": "preserved" },
          body: "中文",
        }),
      );
      expect(await response.json()).toEqual({
        method: "POST",
        path: "/request?q=1",
        header: "preserved",
        body: "中文",
      });
    } finally {
      await http.dispose();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("uses the real configured proxy and honours NO_PROXY without changing globals", async () => {
    const original = globalThis.fetch;
    const upstream = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ path: request.url }));
    });
    const upstreamPort = await listen(upstream);
    let tunnels = 0;
    const sockets = new Set<Duplex>();
    const proxy = createServer();
    proxy.on("connect", (request, socket, head) => {
      tunnels += 1;
      expect(request.url).toBe(`127.0.0.1:${upstreamPort}`);
      sockets.add(socket);
      const remote = connect(upstreamPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        socket.pipe(remote);
        remote.pipe(socket);
      });
      sockets.add(remote);
      socket.on("error", () => remote.destroy());
      remote.on("error", () => socket.destroy());
    });
    const proxyPort = await listen(proxy);
    const proxied = new NodeHttpService({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}` });
    const bypassed = new NodeHttpService({
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: "127.0.0.1",
    });
    try {
      expect(
        await (await proxied.fetch(`http://127.0.0.1:${upstreamPort}/through-proxy`)).json(),
      ).toEqual({ path: "/through-proxy" });
      expect(tunnels).toBe(1);
      expect(
        await (await bypassed.fetch(`http://127.0.0.1:${upstreamPort}/direct`)).json(),
      ).toEqual({ path: "/direct" });
      expect(tunnels).toBe(1);
      expect(globalThis.fetch).toBe(original);
    } finally {
      await Promise.all([proxied.dispose(), bypassed.dispose()]);
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
    }
  });

  it("aborts active requests on shutdown and rejects unsupported proxy schemes", async () => {
    const upstream = createServer(() => undefined);
    const port = await listen(upstream);
    const http = new NodeHttpService({});
    try {
      const pending = http.fetch(`http://127.0.0.1:${port}/pending`);
      const rejected = expect(pending).rejects.toThrow();
      http.abort();
      await rejected;
      expect(() => new NodeHttpService({ HTTPS_PROXY: "socks5://127.0.0.1:1080" })).toThrow(
        "HTTP/HTTPS",
      );
    } finally {
      await http.dispose();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
