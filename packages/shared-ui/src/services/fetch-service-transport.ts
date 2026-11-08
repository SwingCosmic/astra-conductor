import {
  COMMON_SCHEMA_VERSION,
  type ApiOperation,
  type EventChannel,
  type IServiceTransport,
  type ServiceResult,
} from "@astra-conductor/contract/common";
import { readEventStream } from "./event-stream.js";

export interface FetchServiceTransportOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  eventsPath?: string;
  schemaVersion?: number;
  eventReadyTimeoutMs?: number;
}

function failure<T>(code: string, message: string): ServiceResult<T> {
  return { ok: false, error: { code, message, retryable: code === "transport" } };
}

export class FetchServiceTransport implements IServiceTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly lifetime = new AbortController();
  private readonly subscribers = new Set<{
    channel: EventChannel<unknown>;
    listener: (event: unknown) => void;
  }>();
  private readonly readyListeners = new Set<(result: ServiceResult<void>) => void>();
  private eventController: AbortController | null = null;
  private ready = false;
  private mismatch = false;

  constructor(private readonly options: FetchServiceTransportOptions) {
    this.fetchImpl = (options.fetchImpl ?? fetch).bind(globalThis);
    // Existing host entry points pass the API base; descriptors own the complete logical API path.
    this.baseUrl = options.baseUrl.replace(/\/$/, "").replace(/\/api$/, "");
  }

  async request<TInput, TOutput>(
    operation: ApiOperation<TInput, TOutput>,
    input: TInput,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ServiceResult<TOutput>> {
    if (this.lifetime.signal.aborted) return failure("transport", "服务连接已关闭");
    let validated: TInput;
    let path: string;
    let body: unknown;
    try {
      validated = operation.parseInput ? operation.parseInput(input) : input;
      path = operation.path(validated);
      if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid API path");
      body = operation.body?.(validated);
    } catch {
      return failure("validation", "请求参数格式无效");
    }
    try {
      const signal = AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(options.timeoutMs ?? operation.timeoutMs ?? 30_000),
        ...(options.signal ? [options.signal] : []),
      ]);
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: operation.method,
        cache: "no-store",
        signal,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      const result = (await response.json()) as ServiceResult<unknown>;
      if (!result || (result.ok !== true && result.ok !== false))
        return failure("transport", "服务响应无效");
      if (!result.ok) {
        if (
          !result.error ||
          typeof result.error.code !== "string" ||
          typeof result.error.message !== "string" ||
          typeof result.error.retryable !== "boolean"
        )
          return failure("transport", "服务响应无效");
        return result;
      }
      if (!response.ok || !("value" in result)) return failure("transport", "服务响应无效");
      if (operation.voidResult) {
        if (result.value !== null) return failure("transport", "服务响应无效");
        return { ok: true, value: undefined as TOutput };
      }
      try {
        return {
          ok: true,
          value: operation.parseOutput
            ? operation.parseOutput(result.value)
            : (result.value as TOutput),
        };
      } catch {
        return failure("contract-mismatch", "服务通信协议版本不一致");
      }
    } catch {
      return failure("transport", "无法连接应用服务");
    }
  }

  subscribe<TEvent>(channel: EventChannel<TEvent>, listener: (event: TEvent) => void): () => void {
    if (this.lifetime.signal.aborted) return () => {};
    const subscription = {
      channel: channel as EventChannel<unknown>,
      listener: listener as (event: unknown) => void,
    };
    this.subscribers.add(subscription);
    this.ensureEvents();
    return () => {
      this.subscribers.delete(subscription);
    };
  }

  waitForEvents(): Promise<ServiceResult<void>> {
    if (this.lifetime.signal.aborted)
      return Promise.resolve(failure("transport", "服务连接已关闭"));
    if (this.mismatch)
      return Promise.resolve(failure("contract-mismatch", "服务通信协议版本不一致"));
    if (this.ready) return Promise.resolve({ ok: true, value: undefined });
    this.ensureEvents();
    return new Promise((resolve) => {
      const done = (result: ServiceResult<void>): void => {
        clearTimeout(timer);
        this.readyListeners.delete(done);
        resolve(result);
      };
      const timer = setTimeout(
        () => done(failure("transport", "事件流尚未就绪，请检查后端连接")),
        this.options.eventReadyTimeoutMs ?? 5_000,
      );
      this.readyListeners.add(done);
    });
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.eventController?.abort();
    this.eventController = null;
    this.ready = false;
    this.subscribers.clear();
    this.completeReady(failure("transport", "服务连接已关闭"));
  }

  private completeReady(result: ServiceResult<void>): void {
    for (const listener of [...this.readyListeners]) listener(result);
  }

  private ensureEvents(): void {
    if (this.eventController || this.lifetime.signal.aborted || this.mismatch) return;
    this.eventController = new AbortController();
    void this.connect(this.eventController.signal);
  }

  private async connect(signal: AbortSignal): Promise<void> {
    let attempts = 0;
    while (!signal.aborted && !this.mismatch) {
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}${this.options.eventsPath ?? "/api/v1/events"}`,
          { signal, cache: "no-store" },
        );
        await readEventStream(
          response,
          ({ type, data }) => {
            if (signal.aborted) return;
            const event: unknown = JSON.parse(data);
            if (type === "ready") {
              if (
                !event ||
                typeof event !== "object" ||
                (event as { schemaVersion?: unknown }).schemaVersion !==
                  (this.options.schemaVersion ?? COMMON_SCHEMA_VERSION)
              ) {
                this.mismatch = true;
                this.completeReady(failure("contract-mismatch", "服务通信协议版本不一致"));
                throw new Error("Service contract mismatch");
              }
              this.ready = true;
              attempts = 0;
              this.completeReady({ ok: true, value: undefined });
            }
            for (const { channel, listener } of [...this.subscribers]) {
              if ((type === channel.type || type === "ready") && channel.accepts(event)) {
                try {
                  listener(channel.parse(event, type === "ready"));
                } catch {
                  /* A consumer cannot stop the shared event stream. */
                }
              }
            }
          },
          signal,
        );
      } catch {
        /* Read-only event reconnect; mutations are never replayed. */
      }
      this.ready = false;
      if (signal.aborted || this.mismatch) return;
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(
          finish,
          Math.min(30_000, 1_000 * 2 ** Math.min(attempts++, 5)) * (0.8 + Math.random() * 0.4),
        );
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
}
