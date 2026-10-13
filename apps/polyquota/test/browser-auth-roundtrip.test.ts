import { describe, expect, it } from "vitest";
import {
  AuthCoordinator,
  CredentialVault,
  MemoryStorage,
  ProviderRegistry,
  createProviderContributions,
  type CredentialCipherPort,
  type StartOAuthCallbackServer,
} from "@astra-conductor/core/internal";
import { startOAuthCallbackServer } from "../src/auth/callback-server.js";

const now = new Date("2026-09-30T08:00:00.000Z");

/**
 * 与 main.ts 相同的组装方式：注册表 + 全量 provider contribution / vault /
 * storage / 回调监听端口 / 协调器。只有三个替身：令牌端点 fetch 走脚本，
 * openExternal 记录授权 URL 而不是打开浏览器，clock 固定不变。
 */
describe("browser auth roundtrip (antigravity chain)", () => {
  it("completes a full browser authorization from callback to a saved account", async () => {
    const storage = new MemoryStorage();
    const cipher: CredentialCipherPort = {
      isAvailable: async () => true,
      encrypt: async (plaintext) => new TextEncoder().encode(plaintext),
      decrypt: async (ciphertext) => ({
        plaintext: new TextDecoder().decode(ciphertext),
        shouldReEncrypt: false,
      }),
    };
    const vault = new CredentialVault(storage, cipher);
    const openedUrls: string[] = [];
    let callbackPort = 0;
    const recordingListener: StartOAuthCallbackServer = async (options) => {
      const listener = await startOAuthCallbackServer(options);
      callbackPort = listener.port;
      return listener;
    };
    const coordinator = new AuthCoordinator(
      new ProviderRegistry(
        createProviderContributions({
          http: {
            fetch: async (input, init) => {
              const url = String(input);
              if (url.includes("oauth2.googleapis.com/token")) {
                return Response.json({
                  access_token: "access",
                  refresh_token: "refresh",
                  expires_in: 3600,
                });
              }
              if (url.includes("userinfo")) {
                return Response.json({ email: "user@example.test" });
              }
              if (url.includes("loadCodeAssist")) {
                void init;
                return Response.json({
                  cloudaicompanionProject: { id: "project-1" },
                  currentTier: { id: "PRO", name: "Pro" },
                });
              }
              return new Response(null, { status: 404 });
            },
          },
          browser: {
            openExternal: async (url) => {
              openedUrls.push(url);
            },
          },
          callbackServer: { start: recordingListener },
          storage,
          vault,
          clock: { now: () => now },
        }),
      ),
    );

    const result = await coordinator.start("antigravity", "browser-oauth");
    if (result.status !== "pending") throw new Error("expected pending session");
    expect(result.interaction).toBe("browser-callback");
    expect(openedUrls).toHaveLength(1);

    const authorizationUrl = new URL(openedUrls[0]!);
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    const response = await fetch(
      `http://127.0.0.1:${callbackPort}/callback?code=code-1&state=${encodeURIComponent(state!)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("授权已完成");

    const account = await coordinator.finish(result.sessionId);
    expect(account).toMatchObject({
      provider: "antigravity",
      offeringId: "antigravity",
      authMethod: "browser-oauth",
      displayName: "user@example.test",
      publicMetadata: { projectId: "project-1", clientProfile: "ide" },
    });
    expect(storage.accounts.findByStableIdentity("antigravity", account.stableIdentity)).toEqual(
      expect.objectContaining({ id: account.id }),
    );
    await expect(coordinator.finish(result.sessionId)).rejects.toThrow("授权会话不存在");
  });
});
