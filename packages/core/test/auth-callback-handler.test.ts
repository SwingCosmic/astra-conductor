import { describe, expect, it } from "vitest";
import { AppError, createOAuthCallbackHandler } from "../src/internal.js";

function makeHandler(
  options: { state?: () => string; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  let state = "";
  const controller = new AbortController();
  const handler = createOAuthCallbackHandler({
    label: "codex",
    callbackPath: "/auth/callback",
    expectedState: options.state ?? (() => state),
    timeoutMs: options.timeoutMs ?? 60_000,
    signal: options.signal ?? controller.signal,
  });
  return { handler, controller, setState: (value: string) => (state = value) };
}

function request(query: string, pathname = "/auth/callback") {
  return { pathname, query: new URLSearchParams(query) };
}

describe("oauth callback handler", () => {
  it("answers 404 for a different path and keeps the completion pending", async () => {
    const { handler, setState } = makeHandler();
    setState("st-1");

    const response = handler.handleRequest(request("code=c-1&state=st-1", "/other"));
    expect(response.status).toBe(404);
    const result = await Promise.race([
      handler.completion,
      new Promise((r) => setTimeout(r, 20, "pending")),
    ]);
    expect(result).toBe("pending");
  });

  it("resolves the code after a valid state and answers the success page", async () => {
    const { handler, setState } = makeHandler();
    setState("st-1");

    const response = handler.handleRequest(request("code=c-1&state=st-1"));
    expect(response.status).toBe(200);
    expect(response.body).toContain("授权已完成");
    await expect(handler.completion).resolves.toBe("c-1");
  });

  it("rejects with the invalid-callback error and answers the failure page on a state mismatch", async () => {
    const { handler, setState } = makeHandler();
    setState("st-1");

    const response = handler.handleRequest(request("code=c-1&state=st-2"));
    expect(response.status).toBe(400);
    expect(response.body).toContain("授权失败");
    await expect(handler.completion).rejects.toThrow("codex 浏览器授权回调无效");
  });

  it("rejects when the callback has no code", async () => {
    const { handler, setState } = makeHandler();
    setState("st-1");

    const response = handler.handleRequest(request("state=st-1"));
    expect(response.status).toBe(400);
    await expect(handler.completion).rejects.toThrow("codex 浏览器授权回调无效");
  });

  it("rejects when the state was never set", async () => {
    const { handler } = makeHandler();

    const response = handler.handleRequest(request("code=c-1&state=st-1"));
    expect(response.status).toBe(400);
    await expect(handler.completion).rejects.toThrow("codex 浏览器授权回调无效");
  });

  it("ignores later requests once settled", async () => {
    const { handler, setState } = makeHandler();
    setState("st-1");

    handler.handleRequest(request("code=c-1&state=st-1"));
    const second = handler.handleRequest(request("code=c-2&state=st-1"));
    expect(second.status).toBe(200);
    await expect(handler.completion).resolves.toBe("c-1");
  });

  it("times out with the provider label in the message", async () => {
    const { handler } = makeHandler({ timeoutMs: 10 });

    await expect(handler.completion).rejects.toThrow("codex 浏览器授权已超时");
  });

  it("rejects with the cancellation error when the signal aborts", async () => {
    const { handler, controller } = makeHandler();

    controller.abort();
    await expect(handler.completion).rejects.toThrow("授权已取消");
  });

  it("wraps raw host failures as network errors and passes AppError through", async () => {
    const { handler } = makeHandler();

    handler.fail(new Error("socket hang up"));
    await expect(handler.completion).rejects.toThrow("无法监听 codex 授权回调端口");
  });

  it("passes an AppError through fail unchanged", async () => {
    const { handler } = makeHandler();

    handler.fail(new AppError("network", "custom failure"));
    await expect(handler.completion).rejects.toThrow("custom failure");
  });

  it("ignores fail calls after settling", async () => {
    const { handler, setState } = makeHandler();
    setState("st-1");

    handler.handleRequest(request("code=c-1&state=st-1"));
    handler.fail(new Error("late socket error"));
    await expect(handler.completion).resolves.toBe("c-1");
  });
});
