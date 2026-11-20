import {
  AppError,
  applyModelRouteQuery,
  modelAuthorization,
  modelDirectoryUrl,
  readModelJson,
  type Account,
  type ConnectionProviderSource,
  type CredentialEnvelope,
  type HttpPort,
  type ProviderOfferingModelPolicy,
} from "@astra-conductor/core/internal";
import {
  modelEndpointDescriptor,
  type CommandContext,
  type ModelRoute,
} from "@astra-conductor/contract/common";
import type { NativeChatProtocol, TestChatRequest } from "@astra-conductor/contract/graph-agent";
import { approvedProxyBytes } from "./native-proxy-body.js";

export interface NativeDirectory extends CommandContext {
  family: "openai" | "anthropic";
  accountId: string;
  revision: string;
  query: URLSearchParams;
}
export interface NativeChat extends Omit<TestChatRequest, "prompt"> {
  protocol: NativeChatProtocol;
  bytes: ArrayBuffer;
  body: Record<string, unknown>;
}
export type NativeInput = NativeDirectory | NativeChat;

export class UpstreamStatus extends AppError {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
    readonly nativeType?: string,
  ) {
    super(
      status === 401 ? "authentication" : "upstream",
      "上游接口请求失败（HTTP " + status + "）",
    );
  }
}

interface Transfer {
  http: HttpPort;
  account: Account;
  envelope: CredentialEnvelope;
  route: ModelRoute;
  policy?: ProviderOfferingModelPolicy;
  source?: ConnectionProviderSource;
  url: URL;
  modelId?: string;
  ruleHeaders?: Record<string, string>;
  signal: AbortSignal;
  requestSignal: AbortSignal;
  callId?: string;
  check(): void;
  open(response: Response): void;
  observe(value: unknown): void;
  finish(): void;
  abort(): void;
}

export function nativeDestination(
  input: NativeInput,
  account: Account,
  route: ModelRoute,
  path?: string,
  policy?: ProviderOfferingModelPolicy,
  source?: ConnectionProviderSource,
) {
  const chat = "bytes" in input;
  const relativePath = path ?? modelEndpointDescriptor(route.protocol).relativePath;
  const url = chat
    ? applyModelRouteQuery(new URL(route.baseUrl.replace(/\/+$/, "") + "/" + relativePath), route)
    : modelDirectoryUrl(account, route, policy, source);
  if (!chat) {
    const allowed =
      input.family === "anthropic" ? ["before_id", "after_id", "limit"] : ["after", "limit"];
    const fixed = new Set(url.searchParams.keys());
    for (const [key, value] of input.query) {
      if (
        !allowed.includes(key) ||
        fixed.has(key) ||
        url.searchParams.has(key) ||
        value.length > 512
      )
        throw new AppError("validation", "目录分页参数无效或已由供应商绑定");
      url.searchParams.append(key, value);
    }
  }
  return url;
}
export async function transferNative(input: NativeInput, options: Transfer) {
  const { account, envelope, route, source, signal, url, policy } = options;
  const chat = "bytes" in input;
  const outgoing = new Headers(options.ruleHeaders);
  for (const [key, value] of Object.entries(
    modelAuthorization(
      account,
      envelope,
      route,
      options.modelId,
      chat ? "chat" : "models",
      source,
      policy,
    ),
  ))
    outgoing.set(key, value);
  if (chat) outgoing.set("Content-Type", "application/json");
  outgoing.set(
    "Accept",
    chat && input.body.stream === true ? "text/event-stream, application/json" : "application/json",
  );
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await options.http.fetch(url, {
      method: chat ? "POST" : "GET",
      ...(chat && { body: input.bytes }),
      headers: outgoing,
      credentials: "omit",
      redirect: "manual",
      signal,
    });
  } catch {
    throw new AppError("network", "无法连接上游接口", true);
  }
  const secrets = Object.values(envelope.secrets).filter(
    (s): s is string => typeof s === "string" && !!s,
  );
  if (!response.ok) {
    const types = [
      "invalid_request_error",
      "authentication_error",
      "permission_error",
      "not_found_error",
      "request_too_large",
      "rate_limit_error",
      "insufficient_quota",
      "api_error",
      "server_error",
      "overloaded_error",
    ];
    let reported: string | undefined;
    if (response.headers.get("content-type")?.split(";")[0].trim() === "application/json") {
      try {
        const data = (await readModelJson(response, 16 * 1024, () => {
          throw new Error();
        })) as { error?: { type?: unknown } };
        if (
          typeof data?.error?.type === "string" &&
          types.includes(data.error.type) &&
          !secrets.some((s) => data.error!.type === s)
        )
          reported = data.error.type;
      } catch {
        /* Use the HTTP status when an upstream has no bounded native error. */
      }
    } else await response.body?.cancel().catch(() => {});
    const retry = response.headers.get("retry-after");
    throw new UpstreamStatus(
      response.status,
      retry &&
      (/^\d{1,9}$/.test(retry) || /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry)) &&
      !secrets.some((s) => retry.includes(s))
        ? retry
        : null,
      reported,
    );
  }
  const media = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const stream = media === "text/event-stream";
  if (!response.body || !(media === "application/json" || (chat && stream))) {
    await response.body?.cancel().catch(() => {});
    throw new AppError("upstream", "上游返回的媒体类型与协议不符");
  }
  const reader = response.body.getReader();
  const bytes = approvedProxyBytes(reader, stream, secrets, signal, (value) => {
    if (!chat) {
      const list = value as { data?: unknown; object?: unknown; has_more?: unknown } | null;
      if (
        !Array.isArray(list?.data) ||
        (input.family === "openai"
          ? list.object !== undefined && list.object !== "list"
          : typeof list.has_more !== "boolean")
      )
        throw new AppError("upstream", "上游响应不符合该协议族的模型目录格式");
    }
    options.observe(value);
  });
  const headers = new Headers({
    "content-type": media!,
    "cache-control": "no-store, no-transform",
  });
  if (options.callId) headers.set("X-GraphAgent-Call-Id", options.callId);
  // Writers, the credential callback and the mutation gate stay alive until the consumer
  // finishes or cancels. Report cancellation through the upstream reader even for mocked fetches.
  let resolve!: () => void, reject!: (error: unknown) => void;
  const done = new Promise<void>((ok, bad) => {
    resolve = ok;
    reject = bad;
  });
  void done.catch(() => {});
  let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancel = () => {
    if (
      options.requestSignal.aborted ||
      (signal.reason instanceof Error && signal.reason.name === "AbortError")
    ) {
      try {
        downstream?.close();
      } catch {
        /* The client already closed its reader. */
      }
    } else downstream?.error(new Error("模型响应已中止"));
    void reader.cancel().catch(() => {});
    reject(new AppError("network", "模型请求已取消或超时", true));
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (!stream) {
      // JSON is published only after the complete bounded entity passes inspection.
      const chunks: Uint8Array[] = [];
      for await (const chunk of bytes) chunks.push(chunk);
      signal.throwIfAborted();
      options.check();
      options.finish();
      options.open(new Response(Buffer.concat(chunks), { status: response.status, headers }));
      resolve();
    } else {
      options.check();
      options.open(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              start(controller) {
                downstream = controller;
              },
              async pull(controller) {
                try {
                  const part = await bytes.next();
                  signal.throwIfAborted();
                  options.check();
                  if (part.done) {
                    options.finish();
                    controller.close();
                    resolve();
                  } else controller.enqueue(part.value);
                } catch (err) {
                  controller.error(new Error("无法继续读取模型响应"));
                  reject(err);
                }
              },
              cancel() {
                options.abort();
              },
            },
            { highWaterMark: 0 },
          ),
          { status: response.status, headers },
        ),
      );
    }
    if (signal.aborted) cancel();
    await done;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
