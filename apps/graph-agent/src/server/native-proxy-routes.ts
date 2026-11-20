import { Hono } from "hono";
import { nativeChatPaths, type NativeChatProtocol } from "@astra-conductor/contract/graph-agent";
import { AppError } from "@astra-conductor/core/internal";
import { errorStatus, publicError } from "@astra-conductor/core/http";
import { UpstreamStatus, type NativeInput } from "./native-proxy.js";
import type { GraphServices } from "./services.js";

const base = "/api/v1/graph-agent/proxy";
const maxNativeChatBytes = 4 * 1024 * 1024;
const invalid = (message: string) => new AppError("validation", message);
function header(headers: Headers, name: string) {
  const value = headers.get("X-GraphAgent-" + name);
  if (!value || !/^[!-~]{1,256}$/.test(value)) throw invalid("缺少有效的绑定上下文");
  return value;
}
async function readChat(request: Request, protocol: NativeChatProtocol) {
  if (
    new URL(request.url).search ||
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    throw invalid("原生聊天接口需要 JSON 请求");
  if (Number(request.headers.get("content-length")) > maxNativeChatBytes)
    throw invalid("请求体超过大小限制");
  const reader = request.body?.getReader();
  if (!reader) throw invalid("缺少原生请求体");
  let count = 0;
  const pieces: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > maxNativeChatBytes) {
        await reader.cancel();
        throw invalid("请求体超过大小限制");
      }
      pieces.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.length;
  }
  let body: Record<string, unknown>;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    body = JSON.parse(text);
  } catch {
    throw invalid("原生 JSON 请求无效");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.model !== "string" ||
    !body.model ||
    (body.stream !== undefined && typeof body.stream !== "boolean") ||
    (protocol === "openai-responses"
      ? !(typeof body.input === "string" || Array.isArray(body.input))
      : !Array.isArray(body.messages))
  )
    throw invalid("缺少所选协议要求的型号或输入");
  return { body, bytes: bytes.buffer };
}

function fault(family: string, error: unknown) {
  const safe = publicError(error);
  const status = error instanceof UpstreamStatus ? error.status : errorStatus(safe);
  const type =
    status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found_error"
          : status === 429
            ? "rate_limit_error"
            : status < 500
              ? "invalid_request_error"
              : "api_error";
  const detail = {
    type: (error instanceof UpstreamStatus && error.nativeType) || type,
    message: safe.message,
  };
  const headers = new Headers({ "cache-control": "no-store" });
  if (error instanceof UpstreamStatus && error.retryAfter)
    headers.set("retry-after", error.retryAfter);
  if (status === 304) return new Response(null, { status, headers });
  return Response.json(
    family === "anthropic" ? { type: "error", error: detail } : { error: detail },
    { status, headers },
  );
}
export function createNativeProxyRoutes(services: GraphServices) {
  const app = new Hono();
  const respond = async (
    request: Request,
    family: "openai" | "anthropic",
    protocol?: NativeChatProtocol,
  ) => {
    try {
      const h = request.headers;
      const context = { instanceId: header(h, "Instance-Id"), contextId: header(h, "Context-Id") };
      const input: NativeInput = protocol
        ? {
            ...context,
            protocol,
            expectedSettingsRevision: header(h, "Settings-Revision"),
            expectedBindingRevision: header(h, "Binding-Revision"),
            ...(await readChat(request, protocol)),
          }
        : {
            ...context,
            family,
            accountId: header(h, "Account-Id"),
            revision: header(h, "Family-Binding-Revision"),
            query: new URL(request.url).searchParams,
          };
      return await services.chat.proxy(input, h, request.signal, services.track);
    } catch (error) {
      return fault(family, error);
    }
  };
  for (const protocol of Object.keys(nativeChatPaths) as NativeChatProtocol[])
    app.post(nativeChatPaths[protocol], (c) =>
      respond(c.req.raw, protocol === "anthropic-messages" ? "anthropic" : "openai", protocol),
    );
  for (const family of ["openai", "anthropic"] as const) {
    app.get(base + "/" + family + "/v1/models", (c) => respond(c.req.raw, family));
    app.all(base + "/" + family + "/*", () =>
      fault(family, new AppError("not-found", "未知协议端点")),
    );
  }
  app.all(base + "/*", () => fault("openai", new AppError("not-found", "未知协议族")));
  return app;
}
