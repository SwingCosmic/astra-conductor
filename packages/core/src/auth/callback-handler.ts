import { AppError } from "../errors.js";

export interface OAuthCallbackHttpRequest {
  pathname: string;
  query: URLSearchParams;
}

export interface OAuthCallbackHttpResponse {
  status: number;
  body: string;
}

export interface OAuthCallbackHandler {
  completion: Promise<string>;
  handleRequest(request: OAuthCallbackHttpRequest): OAuthCallbackHttpResponse;
  fail(error: unknown): void;
}

export interface OAuthCallbackHandlerOptions {
  label: string;
  callbackPath: string;
  expectedState: () => string;
  timeoutMs?: number;
  signal: AbortSignal;
}

const DEFAULT_CALLBACK_TIMEOUT_MS = 15 * 60 * 1000;

function callbackPage(success: boolean): string {
  const title = success ? "授权已完成" : "授权失败";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>可以关闭此窗口并返回 PolyQuota。</p></body></html>`;
}

/**
 * OAuth 回调处理器：请求→响应决策、状态校验、超时与取消都在这里，
 * 不做任何 I/O。监听 socket 由宿主经 StartOAuthCallbackServer 端口启动，
 * 并把每个请求交回 handleRequest。
 */
export function createOAuthCallbackHandler(
  options: OAuthCallbackHandlerOptions,
): OAuthCallbackHandler {
  const { label, callbackPath, expectedState, signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  let settled = false;
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: unknown) => void = () => undefined;
  const completion = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void completion.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = (): void => {
    clearTimeout(timeout);
  };
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    stopTimer();
    rejectCode(
      error instanceof AppError
        ? error
        : new AppError("network", `无法监听 ${label} 授权回调端口`, false, { cause: error }),
    );
  };
  timeout = setTimeout(
    () => fail(new AppError("authentication", `${label} 浏览器授权已超时`)),
    timeoutMs,
  );
  signal.addEventListener("abort", () => fail(new AppError("authentication", "授权已取消")), {
    once: true,
  });
  return {
    completion,
    fail,
    handleRequest(request) {
      if (request.pathname !== callbackPath) {
        return { status: 404, body: "" };
      }
      const code = request.query.get("code");
      const state = request.query.get("state");
      const success = Boolean(code && expectedState() && state === expectedState());
      if (!success) {
        fail(new AppError("authentication", `${label} 浏览器授权回调无效`));
        return { status: 400, body: callbackPage(false) };
      }
      if (code && !settled) {
        settled = true;
        stopTimer();
        resolveCode(code);
      }
      return { status: 200, body: callbackPage(true) };
    },
  };
}
