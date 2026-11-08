import { Hono } from "hono";
import {
  createCredentialRoutes,
  createProviderRoutes,
  installCommonMiddleware,
} from "@astra-conductor/core/http";
import type { GraphServices } from "./services.js";

/** Both hosts mount the same common application and its single product event stream. */
export function createGraphHonoApp(services: GraphServices): Hono {
  const app = new Hono();
  installCommonMiddleware(app);
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
