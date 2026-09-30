import { describe, expect, it, vi } from "vitest";
import {
  createOAuthCallbackHandler,
  type OAuthCallbackHandler,
} from "@astra-conductor/core/internal";
import { startOAuthCallbackServer } from "../src/auth/callback-server.js";

interface TestListener {
  handler: OAuthCallbackHandler;
  port: number;
  baseUrl: string;
  abort: () => void;
}

async function startListener(): Promise<TestListener> {
  let state = "";
  const controller = new AbortController();
  const handler = createOAuthCallbackHandler({
    label: "codex",
    callbackPath: "/auth/callback",
    expectedState: () => state,
    signal: controller.signal,
  });
  state = "st-1";
  const { port } = await startOAuthCallbackServer({
    label: "codex",
    host: "127.0.0.1",
    port: 0,
    handler,
  });
  return {
    handler,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    abort: () => controller.abort(),
  };
}

describe("oauth callback server (desktop port implementation)", () => {
  it("serves the success page and resolves the handler completion on a valid callback", async () => {
    const { handler, baseUrl } = await startListener();

    const response = await fetch(`${baseUrl}/auth/callback?code=c-1&state=st-1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("授权已完成");
    await expect(handler.completion).resolves.toBe("c-1");
  });

  it("serves the failure page and rejects the completion on a state mismatch", async () => {
    const { handler, baseUrl } = await startListener();

    const response = await fetch(`${baseUrl}/auth/callback?code=c-1&state=st-2`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("授权失败");
    await expect(handler.completion).rejects.toThrow("codex 浏览器授权回调无效");
  });

  it("answers 404 for a different path", async () => {
    const { baseUrl, abort } = await startListener();

    const response = await fetch(`${baseUrl}/other?code=c-1&state=st-1`);
    expect(response.status).toBe(404);
    abort();
  });

  it("releases the port once the completion settles", async () => {
    const { baseUrl } = await startListener();

    await fetch(`${baseUrl}/auth/callback?code=c-1&state=st-1`);
    await vi.waitFor(async () => {
      await expect(fetch(`${baseUrl}/auth/callback`)).rejects.toThrow();
    });
  });

  it("rejects when the port is already in use", async () => {
    const first = await startListener();
    const controller = new AbortController();
    const secondHandler = createOAuthCallbackHandler({
      label: "codex",
      callbackPath: "/auth/callback",
      expectedState: () => "st-1",
      signal: controller.signal,
    });

    await expect(
      startOAuthCallbackServer({
        label: "codex",
        host: "127.0.0.1",
        port: first.port,
        handler: secondHandler,
      }),
    ).rejects.toThrow();
    controller.abort();
    first.abort();
  });
});
