import { serve } from "@hono/node-server";
import { mkdirSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { CredentialCipherPort } from "@astra-conductor/core/internal";
import { createHonoApp } from "../../http/create-hono-app.js";
import { rewriteRequest, withPageBoundary } from "../../http/inbound-adapter.js";
import { startRuntime } from "../../runtime/start-runtime.js";
import { NodeHttpService } from "./http-service.js";
import { registerNodeServices } from "./register-node-services.js";

export interface ServerOptions {
  port?: number;
  dataDirectory?: string;
  origins?: readonly string[];
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  cipher?: CredentialCipherPort;
}

export async function startServer(options: ServerOptions = {}) {
  const env = options.env ?? process.env;
  const port = options.port ?? Number(env.POLYQUOTA_SERVER_PORT ?? 4877);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid server port");
  const directory = path.resolve(
    options.dataDirectory ??
      env.POLYQUOTA_SERVER_DATA ??
      path.join(homedir(), ".astra-conductor", "polyquota-server-dev"),
  );
  mkdirSync(directory, { recursive: true });
  const dataDirectory = realpathSync(directory);
  const forbidden = [
    env.APPDATA ? path.join(env.APPDATA, "AstraConductor", "PolyQuota") : undefined,
    env.POLYQUOTA_USER_DATA,
  ].filter((value): value is string => Boolean(value));
  if (
    forbidden.some(
      (value) =>
        (existsSync(value) ? realpathSync(value) : path.resolve(value)).toLowerCase() ===
        dataDirectory.toLowerCase(),
    )
  )
    throw new Error("Node server cannot open the desktop product data directory");
  const http = new NodeHttpService(env);
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  try {
    const available = options.cipher ? await options.cipher.isAvailable() : false;
    runtime = await startRuntime(
      (registry) =>
        registerNodeServices(registry, {
          dataDirectory,
          http,
          cipher: options.cipher,
          credentialsAvailable: available,
          env,
          homeDirectory: options.homeDirectory,
        }),
      () => http.abort(),
    );
  } catch (error) {
    await http.dispose();
    throw error;
  }
  const app = createHonoApp(runtime);
  const origins = new Set(options.origins ?? ["http://127.0.0.1:5173"]);
  let server: ReturnType<typeof serve>;
  try {
    server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const listening = serve(
        {
          overrideGlobalObjects: false,
          port,
          hostname: "127.0.0.1",
          fetch: (request) => {
            const url = new URL(request.url);
            if (url.hostname !== "127.0.0.1" || request.headers.get("host") !== url.host)
              return new Response(null, { status: 403 });
            return withPageBoundary(request, origins, () => {
              const rewritten = rewriteRequest(request, "/api");
              return rewritten ? app.fetch(rewritten) : new Response(null, { status: 404 });
            });
          },
        },
        () => resolve(listening),
      );
      listening.once("error", reject);
    });
  } catch (error) {
    await runtime.stop();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await runtime.stop();
    throw new Error("No listening address");
  }
  let stopping: Promise<void> | undefined;
  return {
    runtime,
    app,
    dataDirectory,
    url: `http://127.0.0.1:${address.port}/api`,
    stop(): Promise<void> {
      stopping ??= (async () => {
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        try {
          await runtime.stop();
        } finally {
          if ("closeAllConnections" in server) server.closeAllConnections();
          await closed;
        }
      })();
      return stopping;
    },
  };
}
