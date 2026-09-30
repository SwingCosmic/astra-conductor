import { describe, expect, it, vi } from "vitest";
import {
  AuthCoordinator,
  type Account,
  type AuthFlowStart,
  type AuthMethod,
  type ProviderAuthFlow,
  type ProviderId,
} from "../src/internal.js";

const account: Account = {
  id: "account-1",
  provider: "codex",
  authMethod: "browser-oauth",
  stableIdentity: "personal:user-1",
  displayName: "user@example.test",
  maskedIdentifier: "us***@example.test",
  enabled: true,
  credentialState: "available",
  publicMetadata: {},
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};

const CODEX_METHODS: readonly AuthMethod[] = ["browser-oauth", "device-code", "cli-import"];
const GLM_METHODS: readonly AuthMethod[] = ["cli-import", "api-key"];

function fakeFlow(
  provider: ProviderId = "codex",
  supportedMethods: readonly AuthMethod[] = CODEX_METHODS,
): { flow: ProviderAuthFlow; finish: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } {
  const finish = vi.fn().mockResolvedValue(account);
  const cancel = vi.fn();
  const flow: ProviderAuthFlow = {
    provider,
    supportedMethods,
    start: async (method: AuthMethod): Promise<AuthFlowStart> => {
      if (method === "cli-import") return { status: "completed", account };
      if (method === "device-code") {
        return {
          status: "pending",
          interaction: "device-code",
          finish,
          cancel,
          userCode: "WDJB-MJHT",
          verificationUri: "https://example.test/verify",
        };
      }
      return { status: "pending", interaction: "browser-callback", finish, cancel };
    },
  };
  return { flow, finish, cancel };
}

function glmFlow(): {
  flow: ProviderAuthFlow;
  finish: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const finish = vi.fn().mockResolvedValue({ ...account, provider: "glm" });
  const cancel = vi.fn();
  const flow: ProviderAuthFlow = {
    provider: "glm",
    supportedMethods: GLM_METHODS,
    start: async () => ({ status: "completed", account: { ...account, provider: "glm" } }),
  };
  return { flow, finish, cancel };
}

describe("auth coordinator", () => {
  it("passes completed results straight through", async () => {
    const coordinator = new AuthCoordinator([fakeFlow().flow]);

    const result = await coordinator.start("codex", "cli-import");
    expect(result).toEqual({ status: "completed", account });
  });

  it("projects browser-callback sessions with a session id", async () => {
    const { flow } = fakeFlow();
    const coordinator = new AuthCoordinator([flow]);

    const result = await coordinator.start("codex", "browser-oauth");
    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(result.interaction).toBe("browser-callback");
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect("userCode" in result).toBe(false);
  });

  it("projects device-code sessions with the user code and verification uri", async () => {
    const { flow } = fakeFlow();
    const coordinator = new AuthCoordinator([flow]);

    const result = await coordinator.start("codex", "device-code");
    expect(result).toMatchObject({
      status: "pending",
      interaction: "device-code",
      userCode: "WDJB-MJHT",
      verificationUri: "https://example.test/verify",
    });
  });

  it("finishes through the stored handle and clears the session", async () => {
    const { flow, finish } = fakeFlow();
    const coordinator = new AuthCoordinator([flow]);
    const result = await coordinator.start("codex", "browser-oauth");
    if (result.status !== "pending") throw new Error("expected pending");

    await expect(coordinator.finish(result.sessionId)).resolves.toBe(account);
    expect(finish).toHaveBeenCalledOnce();
    await expect(coordinator.finish(result.sessionId)).rejects.toThrow("授权会话不存在或已经结束");
  });

  it("cancels through the stored handle and ignores unknown sessions", async () => {
    const { flow, cancel } = fakeFlow();
    const coordinator = new AuthCoordinator([flow]);

    expect(() => coordinator.cancel("missing")).not.toThrow();
    const result = await coordinator.start("codex", "browser-oauth");
    if (result.status !== "pending") throw new Error("expected pending");
    coordinator.cancel(result.sessionId);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels every session on cancelAll", async () => {
    const codex = fakeFlow();
    const grok = fakeFlow("grok-build" as ProviderId, CODEX_METHODS);
    const coordinator = new AuthCoordinator([codex.flow, grok.flow]);
    const first = await coordinator.start("codex", "browser-oauth");
    const second = await coordinator.start("grok-build", "browser-oauth");

    coordinator.cancelAll();
    expect(codex.cancel).toHaveBeenCalledOnce();
    expect(grok.cancel).toHaveBeenCalledOnce();
    if (first.status === "pending") {
      await expect(coordinator.finish(first.sessionId)).rejects.toThrow("授权会话不存在");
    }
    if (second.status === "pending") {
      await expect(coordinator.finish(second.sessionId)).rejects.toThrow("授权会话不存在");
    }
  });

  it("rejects unknown providers at start", async () => {
    const coordinator = new AuthCoordinator([glmFlow().flow]);

    await expect(coordinator.start("codex", "browser-oauth")).rejects.toThrow(
      "尚未实现服务商接入：codex",
    );
  });

  it("fails construction on duplicate flows", () => {
    expect(() => new AuthCoordinator([fakeFlow().flow, fakeFlow().flow])).toThrow(
      /duplicate auth flow: codex/,
    );
  });

  it("fails construction for providers missing from the catalog", () => {
    expect(() => new AuthCoordinator([fakeFlow("nope" as ProviderId, []).flow])).toThrow(
      /unknown provider: nope/,
    );
  });

  it("fails construction when a flow misses a catalog method", () => {
    const incomplete = fakeFlow("codex", ["browser-oauth", "device-code"]);
    expect(() => new AuthCoordinator([incomplete.flow])).toThrow(
      /missing catalog method: cli-import/,
    );
  });

  it("fails construction when a flow declares an uncatalogued method", () => {
    const extra = fakeFlow("codex", [...CODEX_METHODS, "api-key"]);
    expect(() => new AuthCoordinator([extra.flow])).toThrow(/uncatalogued method: api-key/);
  });
});
