import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraphServices } from "../../server/services.js";
import { createGraphHonoApp } from "../../server/create-hono-app.js";
import { claimGraphProfile } from "../storage.js";
import { createGraphBrokerHost } from "../broker-host.js";
import { startOAuthCallbackServer } from "../callback-server.js";
import { graphUiResource } from "../resources.js";

export interface GraphServerOptions {
  port?: number;
  directory?: string;
  env?: NodeJS.ProcessEnv;
}

/** Formal Web host: business state is local; credential payloads only come from broker. */
export async function startGraphServer(options: GraphServerOptions = {}) {
  const env = options.env ?? process.env;
  const port = options.port ?? Number(env.GRAPH_AGENT_PORT ?? 4878);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid GraphAgent port");
  const directory = path.resolve(
    options.directory ??
      env.GRAPH_AGENT_DATA_DIR ??
      path.join(homedir(), ".astra-conductor", "graph-agent-web"),
  );
  const release = claimGraphProfile(directory);
  const controller = new AbortController();
  let services: Awaited<ReturnType<typeof createGraphServices>>;
  try {
    if (!!env.GRAPH_AGENT_BROKER_VAULT !== !!env.GRAPH_AGENT_BROKER_CLIENT_ID)
      throw new Error("GraphAgent broker vault and client id must be configured together");
    const brokerBinding =
      env.GRAPH_AGENT_BROKER_VAULT && env.GRAPH_AGENT_BROKER_CLIENT_ID
        ? {
            vaultDirectory: path.resolve(env.GRAPH_AGENT_BROKER_VAULT),
            clientId: env.GRAPH_AGENT_BROKER_CLIENT_ID,
          }
        : undefined;
    services = await createGraphServices({
      directory,
      host: createGraphBrokerHost(directory, true),
      http: {
        fetch: (input, init) => {
          const request = new Request(input, init);
          return fetch(request, {
            signal: AbortSignal.any([
              request.signal,
              controller.signal,
              AbortSignal.timeout(30_000),
            ]),
          });
        },
      },
      files: { readText: (filename) => readFile(filename, "utf8") },
      callbackServer: { start: startOAuthCallbackServer },
      authorization: { present: async () => "awaiting-user" },
      brokerBinding,
    });
  } catch (error) {
    release();
    throw error;
  }
  const app = createGraphHonoApp(services);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  let server: ReturnType<typeof serve>;
  try {
    server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const listening = serve(
        {
          overrideGlobalObjects: false,
          hostname: "127.0.0.1",
          port,
          fetch: (request) => {
            const url = new URL(request.url);
            const origin = request.headers.get("origin");
            if (
              url.hostname !== "127.0.0.1" ||
              request.headers.get("host") !== url.host ||
              (origin !== null && origin !== url.origin) ||
              request.headers.get("sec-fetch-site") === "cross-site"
            )
              return new Response(null, { status: 403 });
            if (url.pathname.startsWith("/api/")) return app.fetch(request);
            if (request.method !== "GET" && request.method !== "HEAD")
              return new Response(null, { status: 405 });
            return graphUiResource(path.join(root, "ui/dist"), url.pathname);
          },
        },
        () => resolve(listening),
      );
      listening.once("error", reject);
    });
  } catch (error) {
    await services.stop();
    release();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("GraphAgent has no listening address");
  let stopping: Promise<void> | undefined;
  return {
    app,
    services,
    directory,
    url: `http://127.0.0.1:${address.port}`,
    stop(): Promise<void> {
      stopping ??= (async () => {
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        controller.abort();
        try {
          await services.stop();
        } finally {
          if ("closeAllConnections" in server) server.closeAllConnections();
          await closed;
          release();
        }
      })();
      return stopping;
    },
  };
}
