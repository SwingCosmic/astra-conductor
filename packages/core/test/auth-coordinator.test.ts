import { describe, expect, it, vi } from "vitest";
import {
  AuthCoordinator,
  ProviderRegistry,
  providerCatalog,
  type Account,
  type AuthFlowStart,
  type AuthMethod,
  type ProviderAuthFlow,
  type ProviderContribution,
  type ProviderId,
} from "../src/internal.js";

const account: Account = {
  id: "account-1",
  provider: "codex",
  offeringId: "codex",
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
    start: async (offeringId: string, method: AuthMethod): Promise<AuthFlowStart> => {
      if (offeringId !== provider && provider !== "glm") {
        throw new Error(`unexpected offering: ${offeringId}`);
      }
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

function glmFlow(): ProviderAuthFlow {
  return {
    provider: "glm",
    supportedMethods: GLM_METHODS,
    start: async () => ({
      status: "completed",
      account: { ...account, provider: "glm", offeringId: "zai-coding-plan" },
    }),
  };
}

/** 账号 facet 由 flow 包装而来；descriptor 取自真实目录并只声明 account 能力。 */
function contributionFromFlow(flow: ProviderAuthFlow): ProviderContribution {
  const descriptor = providerCatalog.find((item) => item.provider === flow.provider);
  if (!descriptor) throw new Error(`no catalog descriptor for ${flow.provider}`);
  return {
    descriptor: { ...descriptor, capabilities: ["account"] },
    account: {
      providerId: flow.provider,
      supportedMethods: flow.supportedMethods,
      startAuth: flow.start,
    },
  };
}

function coordinatorWith(flows: readonly ProviderAuthFlow[]): AuthCoordinator {
  return new AuthCoordinator(new ProviderRegistry(flows.map(contributionFromFlow)), undefined, {
    authorization: { present: async () => "awaiting-user" },
  });
}

describe("auth coordinator", () => {
  it("passes completed results straight through", async () => {
    const coordinator = coordinatorWith([fakeFlow().flow]);

    const result = await coordinator.start("codex", "cli-import");
    expect(result).toEqual({ status: "completed", account });
  });

  it("routes offerings of multi-offering providers to the same facet", async () => {
    const coordinator = coordinatorWith([glmFlow()]);

    const result = await coordinator.start("bigmodel-coding-plan", "api-key");
    expect(result).toEqual({
      status: "completed",
      account: { ...account, provider: "glm", offeringId: "zai-coding-plan" },
    });
  });

  it("projects browser-callback sessions with a session id", async () => {
    const coordinator = coordinatorWith([fakeFlow().flow]);

    const result = await coordinator.start("codex", "browser-oauth");
    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(result.interaction).toBe("browser-callback");
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect("userCode" in result).toBe(false);
  });

  it("projects device-code sessions with the user code and verification uri", async () => {
    const coordinator = coordinatorWith([fakeFlow().flow]);

    const result = await coordinator.start("codex", "device-code");
    expect(result).toMatchObject({
      status: "pending",
      interaction: "device-code",
      userCode: "WDJB-MJHT",
      verificationUri: "https://example.test/verify",
    });
  });

  it("finishes through the stored handle and retains an idempotent result", async () => {
    const { flow, finish } = fakeFlow();
    const coordinator = coordinatorWith([flow]);
    const result = await coordinator.start("codex", "browser-oauth");
    if (result.status !== "pending") throw new Error("expected pending");

    await expect(coordinator.finish(result.sessionId)).resolves.toBe(account);
    expect(finish).toHaveBeenCalledOnce();
    await expect(coordinator.finish(result.sessionId)).resolves.toBe(account);
  });

  it("cancels through the stored handle and ignores unknown sessions", async () => {
    const { flow, cancel } = fakeFlow();
    const coordinator = coordinatorWith([flow]);

    expect(() => coordinator.cancel("missing")).not.toThrow();
    const result = await coordinator.start("codex", "browser-oauth");
    if (result.status !== "pending") throw new Error("expected pending");
    coordinator.cancel(result.sessionId);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels every session on cancelAll", async () => {
    const codex = fakeFlow();
    const grok = fakeFlow("grok-build" as ProviderId, CODEX_METHODS);
    const coordinator = coordinatorWith([codex.flow, grok.flow]);
    const first = await coordinator.start("codex", "browser-oauth");
    const second = await coordinator.start("grok-build", "browser-oauth");

    coordinator.cancelAll();
    expect(codex.cancel).toHaveBeenCalledOnce();
    expect(grok.cancel).toHaveBeenCalledOnce();
    if (first.status === "pending") {
      await expect(coordinator.finish(first.sessionId)).rejects.toThrow("授权已取消");
    }
    if (second.status === "pending") {
      await expect(coordinator.finish(second.sessionId)).rejects.toThrow("授权已取消");
    }
  });

  it("rejects unknown offerings at start without guessing a provider", async () => {
    const coordinator = coordinatorWith([fakeFlow().flow]);

    await expect(coordinator.start("bigmodel-coding-plan", "api-key")).rejects.toThrow(
      "未知接入点：bigmodel-coding-plan",
    );
  });

  it("rejects methods the offering does not declare", async () => {
    const coordinator = coordinatorWith([fakeFlow().flow]);

    await expect(coordinator.start("codex", "api-key")).rejects.toThrow(
      "接入点 codex 不支持认证方式：api-key",
    );
  });

  it("rejects offerings whose provider has no account facet", async () => {
    const glmDescriptor = providerCatalog.find((item) => item.provider === "glm");
    if (!glmDescriptor) throw new Error("missing glm descriptor");
    const coordinator = new AuthCoordinator(
      new ProviderRegistry([{ descriptor: { ...glmDescriptor, capabilities: [] } }]),
    );

    await expect(coordinator.start("zai-coding-plan", "api-key")).rejects.toThrow(
      "尚未实现服务商接入：glm",
    );
  });

  it("fails construction when a facet misses a catalog method", () => {
    const incomplete = fakeFlow("codex", ["browser-oauth", "device-code"]);
    expect(() => coordinatorWith([incomplete.flow])).toThrow(/missing catalog method: cli-import/);
  });

  it("fails construction when a facet declares an uncatalogued method", () => {
    const extra = fakeFlow("codex", [...CODEX_METHODS, "api-key"]);
    expect(() => coordinatorWith([extra.flow])).toThrow(/uncatalogued method: api-key/);
  });
});
