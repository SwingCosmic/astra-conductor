import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BrokerError } from "@astra-conductor/credentials";
import {
  ContractValidationError,
  parseAccountId,
  parseCommandContext,
  parseCredentialExportRequest,
  parseSessionId,
  parseStartAuthRequest,
  type CommandContext,
  type StartAuthRequest,
  type PublicError,
} from "@astra-conductor/contract/common";
import { AppError, toPublicError } from "../errors.js";

type Awaitable<T> = T | Promise<T>;
export interface ProviderHttpService {
  getSnapshot(): Awaitable<unknown>;
  startAuth(request: StartAuthRequest): Awaitable<unknown>;
  getAuthSession(sessionId: string): Awaitable<unknown>;
  finishAuth(sessionId: string): Awaitable<unknown>;
  cancelAuth(sessionId: string): Awaitable<unknown>;
  setAccountEnabled(accountId: string, enabled: boolean): Awaitable<unknown>;
  deleteAccount(accountId: string, expectedRecordRevision?: string): Awaitable<unknown>;
  refreshCredentials(accountId: string): Awaitable<unknown>;
}
export interface CredentialHttpService {
  getStatus(): Awaitable<unknown>;
  selectDirectory?(): Awaitable<unknown>;
  install?(): Awaitable<unknown>;
  uninstall?(): Awaitable<unknown>;
  exportCredentials?(vaultDirectory: string): Awaitable<unknown>;
  resumeExport?(): Awaitable<unknown>;
  restartExport?(vaultDirectory: string): Awaitable<unknown>;
  acknowledgeDelivery?(): Awaitable<unknown>;
  cancelExport?(): Awaitable<unknown>;
  cancel?(): Awaitable<unknown>;
  enableShared?(): Awaitable<unknown>;
  returnToPrivate?(acceptIndependentRefreshRisk: boolean): Awaitable<unknown>;
  rejoinShared?(migrationKey: string): Awaitable<unknown>;
  verifyImport?(vaultDirectory: string, migrationKey: string): Awaitable<unknown>;
  confirmImport?(previewId: string): Awaitable<unknown>;
  cancelImport?(): Awaitable<unknown>;
  retry?(): Awaitable<unknown>;
}
export interface CommonRouteOptions {
  assertContext(context: CommandContext): void;
  track?<T>(operation: () => Awaitable<T>): Promise<T>;
}

function invalid(): never {
  throw new ContractValidationError("Invalid request body");
}
export async function readJsonBody(
  c: Context,
  keys?: readonly string[],
): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text) return {};
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) invalid();
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
async function command(c: Context, options: CommonRouteOptions, keys: readonly string[]) {
  const { instanceId, contextId, ...request } = await readJsonBody(c, [
    ...keys,
    "instanceId",
    "contextId",
  ]);
  options.assertContext(parseCommandContext({ instanceId, contextId }));
  return request;
}
function routes(options: CommonRouteOptions) {
  const app = new Hono();
  const route = (
    method: "GET" | "POST",
    path: string,
    operation: (c: Context) => Awaitable<unknown>,
  ) => {
    app.on(method, path, async (c) => {
      const execute = async () => {
        if (method === "GET") await readJsonBody(c, []);
        return operation(c);
      };
      const value = await (options.track ? options.track(execute) : execute());
      return c.json({ ok: true, value: value === undefined ? null : value });
    });
  };
  return { app, route };
}

/** Mount beside the product routes; middleware, lifecycle and SSE belong to the product app. */
export function createProviderRoutes(
  service: ProviderHttpService,
  options: CommonRouteOptions,
): Hono {
  const { app, route } = routes(options);
  route("GET", "/api/v1/providers", () => service.getSnapshot());
  route("POST", "/api/v1/auth/sessions/start", async (c) =>
    service.startAuth(
      parseStartAuthRequest(await command(c, options, ["offeringId", "method", "apiKey"])),
    ),
  );
  route("GET", "/api/v1/auth/sessions/:sessionId", (c) =>
    service.getAuthSession(parseSessionId(c.req.param("sessionId"))),
  );
  for (const action of ["finish", "cancel"] as const) {
    route("POST", `/api/v1/auth/sessions/:sessionId/${action}`, async (c) => {
      const id = parseSessionId(c.req.param("sessionId"));
      await command(c, options, []);
      return action === "finish" ? service.finishAuth(id) : service.cancelAuth(id);
    });
  }
  route("POST", "/api/v1/accounts/:accountId/set-enabled", async (c) => {
    const id = parseAccountId(c.req.param("accountId"));
    const request = await command(c, options, ["enabled"]);
    if (typeof request.enabled !== "boolean") invalid();
    return service.setAccountEnabled(id, request.enabled);
  });
  route("POST", "/api/v1/accounts/:accountId/delete", async (c) => {
    const id = parseAccountId(c.req.param("accountId"));
    const request = await command(c, options, ["expectedRecordRevision"]);
    if (
      typeof request.expectedRecordRevision !== "string" ||
      !request.expectedRecordRevision ||
      request.expectedRecordRevision.length > 128 ||
      /[\s\x00-\x1f]/.test(request.expectedRecordRevision)
    )
      invalid();
    return service.deleteAccount(id, request.expectedRecordRevision);
  });
  route("POST", "/api/v1/accounts/:accountId/refresh-credentials", async (c) => {
    const id = parseAccountId(c.req.param("accountId"));
    await command(c, options, []);
    return service.refreshCredentials(id);
  });
  return app;
}

export function createCredentialRoutes(
  service: CredentialHttpService,
  options: CommonRouteOptions,
): Hono {
  const { app, route } = routes(options);
  const unavailable = (): never => {
    throw new AppError("capability-unavailable", "当前宿主不提供此凭据操作");
  };
  const key = (value: unknown): string => {
    if (typeof value !== "string" || !/^acm1_[A-Za-z0-9_-]{43}$/.test(value)) invalid();
    return value;
  };
  route("GET", "/api/v1/credential-sharing/status", () => service.getStatus());
  const actions = {
    "select-directory": "selectDirectory",
    install: "install",
    uninstall: "uninstall",
    "acknowledge-delivery": "acknowledgeDelivery",
    "export/cancel": "cancelExport",
    "export/resume": "resumeExport",
    "enable-shared": "enableShared",
    "import/cancel": "cancelImport",
    retry: "retry",
  } as const;
  for (const [path, method] of Object.entries(actions))
    route("POST", `/api/v1/credential-sharing/${path}`, async (c) => {
      await command(c, options, []);
      const action =
        method === "cancelExport" ? (service.cancelExport ?? service.cancel) : service[method];
      return action ? action.call(service) : unavailable();
    });
  route("POST", "/api/v1/credential-sharing/export", async (c) => {
    const request = parseCredentialExportRequest(await command(c, options, ["vaultDirectory"]));
    return service.exportCredentials
      ? service.exportCredentials(request.vaultDirectory)
      : unavailable();
  });
  route("POST", "/api/v1/credential-sharing/export/restart", async (c) => {
    const request = parseCredentialExportRequest(await command(c, options, ["vaultDirectory"]));
    return service.restartExport ? service.restartExport(request.vaultDirectory) : unavailable();
  });
  route("POST", "/api/v1/credential-sharing/return-to-private", async (c) => {
    const request = await command(c, options, ["acceptIndependentRefreshRisk"]);
    if (request.acceptIndependentRefreshRisk !== true) invalid();
    return service.returnToPrivate ? service.returnToPrivate(true) : unavailable();
  });
  route("POST", "/api/v1/credential-sharing/rejoin-shared", async (c) => {
    const request = await command(c, options, ["migrationKey"]);
    return service.rejoinShared ? service.rejoinShared(key(request.migrationKey)) : unavailable();
  });
  route("POST", "/api/v1/credential-sharing/import/verify", async (c) => {
    const request = await command(c, options, ["vaultDirectory", "migrationKey"]);
    const { vaultDirectory } = parseCredentialExportRequest({
      vaultDirectory: request.vaultDirectory,
    });
    return service.verifyImport
      ? service.verifyImport(vaultDirectory, key(request.migrationKey))
      : unavailable();
  });
  route("POST", "/api/v1/credential-sharing/import/confirm", async (c) => {
    const request = await command(c, options, ["previewId"]);
    return service.confirmImport
      ? service.confirmImport(parseSessionId(request.previewId))
      : unavailable();
  });
  return app;
}

type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 501 | 502 | 503;
const brokerErrors: Record<string, readonly [HttpErrorStatus, string, boolean]> = {
  "access-denied": [403, "当前客户端没有此记录的访问权限", false],
  "record-access-denied": [403, "当前客户端没有此记录的访问权限", false],
  "broker-disconnected": [503, "凭据共享服务已断开，请重试连接", true],
  "broker-unavailable": [503, "凭据共享服务暂不可用，请重试连接", true],
  "component-incompatible": [409, "凭据共享组件版本不兼容，请检查安装状态", false],
  "protocol-incompatible": [409, "凭据共享服务通信协议不兼容", false],
  "api-incompatible": [409, "凭据共享服务尚不支持所需功能", false],
  "invalid-component-version": [409, "凭据共享组件版本信息无效", false],
  "invalid-migration-key": [400, "迁移密钥无效，请重新输入", false],
  "invalid-master-key": [400, "迁移密钥校验失败，请重新输入", false],
  "invalid-vault-directory": [400, "请选择有效的共享目录", false],
  "version-mismatch": [409, "共享版本已变更，请重新验证导入", false],
  "vault-identity-mismatch": [409, "所选目录与当前共享身份不一致", false],
  "operation-in-progress": [409, "凭据操作正在进行，请稍后重试", true],
  "import-not-ready": [409, "导入预览尚未就绪，请重新验证", false],
  "preview-expired": [409, "导入预览已过期，请重新验证", false],
  "import-preview-expired": [409, "导入预览已过期，请重新验证", false],
  "secure-storage-unavailable": [503, "当前宿主没有可用的安全存储", false],
  "ownership-not-transferred": [409, "共享凭据尚未完成接管", false],
};

/** Do not echo broker messages or arbitrary remote codes into the public API. */
export function publicError(error: unknown): PublicError {
  if (error instanceof ContractValidationError)
    return { code: "validation", message: error.message, retryable: false };
  if (error instanceof BrokerError) {
    const known = Object.hasOwn(brokerErrors, error.code) ? brokerErrors[error.code] : undefined;
    return known
      ? { code: error.code, message: known[1], retryable: known[2] }
      : {
          code: "credential-operation-failed",
          message: "凭据操作未能完成，请检查当前共享状态",
          retryable: false,
        };
  }
  const converted = toPublicError(error);
  return converted.code === "upstream" && converted.message === "Unexpected operation failure"
    ? { code: "internal", message: "操作未能完成", retryable: false }
    : converted;
}

export function errorStatus(error: PublicError): HttpErrorStatus {
  if (Object.hasOwn(brokerErrors, error.code)) return brokerErrors[error.code][0];
  const statuses: Record<string, HttpErrorStatus> = {
    validation: 400,
    authentication: 401,
    permission: 403,
    forbidden: 403,
    "not-found": 404,
    conflict: 409,
    "stale-context": 409,
    "capability-unavailable": 409,
    "credential-operation-failed": 409,
    "desktop-unavailable": 501,
    "rate-limit": 429,
    network: 502,
    upstream: 502,
    "secure-storage": 503,
    "service-unavailable": 503,
  };
  return Object.hasOwn(statuses, error.code) ? statuses[error.code] : 500;
}

/** Apply once before mounting common and product subapps. */
export function installCommonMiddleware(app: Hono): void {
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
    await next();
  });
  app.onError((error, c) => {
    const converted = publicError(error);
    return c.json({ ok: false, error: converted }, errorStatus(converted));
  });
}
