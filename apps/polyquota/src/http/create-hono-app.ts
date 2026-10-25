import { AppError } from "@astra-conductor/core/internal";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ContractValidationError,
  POLYQUOTA_SCHEMA_VERSION,
  parseAccountId,
  parseSessionId,
  parseSetAccountEnabledRequest,
  parseRedeemResetCreditRequest,
  parseSettings,
  parseStartAuthRequest,
} from "@astra-conductor/polyquota-contract";
import type { PolyQuotaRuntime } from "../runtime/start-runtime.js";
import { eventStream } from "./event-stream.js";
import { errorStatus, publicError } from "./public-error.js";

function invalid(): never {
  throw new ContractValidationError("Invalid request body");
}

async function body(context: Context, keys?: readonly string[]): Promise<Record<string, unknown>> {
  const text = await context.req.text();
  if (!text) return {};
  if (!/^application\/json(?:\s*;|$)/i.test(context.req.header("content-type") ?? "")) invalid();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (keys && Object.keys(record).some((key) => !keys.includes(key))) invalid();
  return record;
}

export function createHonoApp(runtime: PolyQuotaRuntime): Hono {
  const app = new Hono();
  const service = runtime.application;
  app.use(
    "*",
    bodyLimit({
      maxSize: 65_536,
      onError: (c) =>
        c.json(
          {
            ok: false,
            error: { code: "validation", message: "Request body is too large", retryable: false },
          },
          400,
        ),
    }),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (runtime.state !== "ready")
      return c.json(
        {
          ok: false,
          error: { code: "service-unavailable", message: "服务正在停止", retryable: true },
        },
        503,
      );
    await next();
  });
  app.onError((error, c) => {
    const converted = publicError(error);
    return c.json({ ok: false, error: converted }, errorStatus(converted));
  });
  app.notFound((c) =>
    c.json(
      { ok: false, error: { code: "not-found", message: "接口不存在", retryable: false } },
      404,
    ),
  );
  const route = (
    method: "GET" | "POST",
    path: string,
    operation: (c: Context) => unknown | Promise<unknown>,
  ): void => {
    app.on(method, path, async (c) => {
      const value = await runtime.track(async () => {
        if (method === "GET") await body(c, []);
        return operation(c);
      });
      return c.json({ ok: true, value: value === undefined ? null : value });
    });
  };
  const empty = (c: Context) => body(c, []);
  route("GET", "/v1/status", () => ({
    state: runtime.state,
    schemaVersion: POLYQUOTA_SCHEMA_VERSION,
    instanceId: service.instanceId,
    revision: service.getRevision(),
  }));
  route("GET", "/v1/host/capabilities", () => runtime.host.capabilities);
  route("POST", "/v1/host/window/show", async (c) => {
    await empty(c);
    if (!runtime.host.capabilities.desktop)
      throw new AppError("desktop-unavailable", "当前宿主不提供桌面窗口");
    runtime.host.showWindow();
  });
  route("GET", "/v1/polyquota/snapshot", () => service.getSnapshot());
  app.get("/v1/polyquota/events", async (c) => {
    await empty(c);
    return eventStream(runtime, c.req.raw.signal);
  });
  route("POST", "/v1/polyquota/accounts/:accountId/set-enabled", async (c) => {
    const accountId = parseAccountId(c.req.param("accountId"));
    const request = parseSetAccountEnabledRequest({ ...(await body(c, ["enabled"])), accountId });
    service.setAccountEnabled(request.accountId, request.enabled);
  });
  for (const action of ["delete", "refresh"] as const)
    route("POST", `/v1/polyquota/accounts/:accountId/${action}`, async (c) => {
      const accountId = parseAccountId(c.req.param("accountId"));
      await empty(c);
      return action === "delete"
        ? service.deleteAccount(accountId)
        : service.refreshAccount(accountId);
    });
  route("POST", "/v1/polyquota/accounts/refresh-all", async (c) => {
    await empty(c);
    return service.refreshAll();
  });
  route("POST", "/v1/polyquota/credentials/refresh", async (c) =>
    service.refreshCredentials(parseAccountId((await body(c, ["accountId"])).accountId)),
  );
  route("POST", "/v1/polyquota/reset-credits/redeem", async (c) => {
    const request = parseRedeemResetCreditRequest(await body(c));
    return service.redeemResetCredit(request.accountId, request.redemption);
  });
  route("POST", "/v1/polyquota/auth/sessions/start", async (c) =>
    service.startAuth(parseStartAuthRequest(await body(c))),
  );
  route("GET", "/v1/polyquota/auth/sessions/:sessionId", (c) =>
    service.getAuthSession(parseSessionId(c.req.param("sessionId"))),
  );
  for (const action of ["finish", "cancel"] as const)
    route("POST", `/v1/polyquota/auth/sessions/:sessionId/${action}`, async (c) => {
      const id = parseSessionId(c.req.param("sessionId"));
      await empty(c);
      return action === "finish" ? service.finishAuth(id) : service.cancelAuth(id);
    });
  route("POST", "/v1/polyquota/settings/save", async (c) =>
    service.saveSettings(parseSettings(await body(c))),
  );
  route("GET", "/v1/polyquota/system-status", () => service.getSystemStatus());
  route("POST", "/v1/notifications/:notificationId/acknowledge", async (c) => {
    const id = parseSessionId(c.req.param("notificationId"));
    const { status } = await body(c, ["status"]);
    if (status !== "delivered" && status !== "failed" && status !== "denied") invalid();
    runtime.browserNotifications.acknowledge(id, status);
  });
  return app;
}
