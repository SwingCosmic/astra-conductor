import { Hono } from "hono";
import { graphModelOperations } from "@astra-conductor/contract/graph-agent";
import { maxModelPackBytes } from "./model-pack.js";
import {
  createCredentialRoutes,
  createProviderRoutes,
  installCommonMiddleware,
} from "@astra-conductor/core/http";
import { customProviderRoutes } from "./custom-provider-routes.js";
import { createGraphChatRoutes } from "./chat-routes.js";
import { createNativeProxyRoutes } from "./native-proxy-routes.js";
import { createModelRoutes } from "./model-routes.js";
import { createNewApiRoutes } from "./new-api-routes.js";
import type { GraphServices } from "./services.js";

/** Both hosts mount the same common application and its single product event stream. */
export function createGraphHonoApp(services: GraphServices): Hono {
  const app = new Hono();
  // Native routes apply the same body bound and return protocol-native errors.
  app.route("/", createNativeProxyRoutes(services));
  installCommonMiddleware(app, {
    [graphModelOperations.changeModelPack.routePath]: maxModelPackBytes + 4096,
  });
  app.use("*", async (c, next) => {
    if (services.stopped)
      return c.json(
        {
          ok: false,
          error: { code: "service-unavailable", message: "服务正在停止", retryable: true },
        },
        503,
      );
    await next();
  });
  const options = {
    assertContext: (context: Parameters<typeof services.providers.assertContext>[0]) =>
      services.providers.assertContext(context),
    track: services.track,
  };
  app.route("/", createProviderRoutes(services.providers, options));
  app.route("/", createCredentialRoutes(services.credentials, options));
  app.route("/", customProviderRoutes(services));
  app.route("/", createModelRoutes(services));
  app.route("/", createGraphChatRoutes(services));
  app.route("/", createNewApiRoutes(services));
  app.get("/api/v1/events", (c) => services.eventStream(c.req.raw.signal));
  app.get("/api/v1/status", (c) =>
    c.json({
      ok: true,
      value: {
        schemaVersion: 1,
        instanceId: services.providers.instanceId,
        revision: services.providers.getRevision(),
      },
    }),
  );
  app.notFound((c) =>
    c.json(
      { ok: false, error: { code: "not-found", message: "接口不存在", retryable: false } },
      404,
    ),
  );
  return app;
}
