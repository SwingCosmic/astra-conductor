import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthCoordinator,
  ProviderRegistry,
  providerCatalog,
  type Account,
  type AuthFlowStart,
  type ProviderContribution,
} from "../src/internal.js";

const account: Account = {
  id: "account-session",
  provider: "codex",
  offeringId: "codex",
  authMethod: "device-code",
  stableIdentity: "session-user",
  displayName: "Session",
  maskedIdentifier: "s***",
  enabled: true,
  credentialState: "available",
  publicMetadata: {},
  createdAt: "2026-10-25T00:00:00Z",
  updatedAt: "2026-10-25T00:00:00Z",
};

function createCoordinator(start: () => Promise<AuthFlowStart>, retention = 1000) {
  const descriptor = providerCatalog.find((item) => item.provider === "codex")!;
  const contribution: ProviderContribution = {
    descriptor: { ...descriptor, capabilities: ["account"] },
    account: {
      providerId: "codex",
      supportedMethods: ["browser-oauth", "device-code", "cli-import"],
      startAuth: start,
    },
  };
  const present = vi.fn(async () => "awaiting-user" as const);
  const coordinator = new AuthCoordinator(new ProviderRegistry([contribution]), undefined, {
    authorization: { present },
    terminalRetentionMs: retention,
  });
  return { coordinator, present };
}

afterEach(() => vi.useRealTimers());

describe("retained auth sessions", () => {
  it("keeps concurrent presentations separate and queries never start device polling", async () => {
    let number = 0;
    const finish = vi.fn(async () => account);
    const { coordinator, present } = createCoordinator(async () => ({
      status: "pending",
      interaction: "device-code",
      userCode: `code-${++number}`,
      verificationUri: `https://device.test/${number}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      finish,
      cancel: vi.fn(),
    }));
    try {
      const [first, second] = await Promise.all([
        coordinator.start("codex", "device-code"),
        coordinator.start("codex", "device-code"),
      ]);
      if (first.status !== "pending" || second.status !== "pending")
        throw new Error("expected sessions");
      expect(first.sessionId).not.toBe(second.sessionId);
      expect(coordinator.getSession(first.sessionId).userCode).toBe("code-1");
      expect(coordinator.getSession(second.sessionId).userCode).toBe("code-2");
      expect(present.mock.calls).toHaveLength(2);
      expect(finish).not.toHaveBeenCalled();
      expect(
        await Promise.all([
          coordinator.finish(first.sessionId),
          coordinator.finish(first.sessionId),
        ]),
      ).toEqual([account, account]);
      expect(await coordinator.finish(first.sessionId)).toEqual(account);
      expect(finish).toHaveBeenCalledTimes(1);
      expect(coordinator.getSession(first.sessionId).status).toBe("completed");
      coordinator.cancel(first.sessionId);
      expect(coordinator.getSession(first.sessionId).status).toBe("completed");
    } finally {
      coordinator.cancelAll();
      await coordinator.drain();
    }
  });

  it("observes a callback completion before finish and preserves a committed result across cancellation", async () => {
    let complete!: (value: Account) => void;
    const completion = new Promise<Account>((resolve) => {
      complete = resolve;
    });
    const finish = vi.fn(() => completion);
    const { coordinator } = createCoordinator(async () => ({
      status: "pending",
      interaction: "browser-callback",
      authorizationUrl: "https://authorize.test/?state=public-state",
      completion,
      finish,
      cancel: vi.fn(),
    }));
    const result = await coordinator.start("codex", "browser-oauth");
    if (result.status !== "pending") throw new Error("expected session");
    coordinator.cancel(result.sessionId);
    complete(account);
    await completion;
    await Promise.resolve();
    expect(coordinator.getSession(result.sessionId).status).toBe("completed");
    expect(await coordinator.finish(result.sessionId)).toEqual(account);
    expect(finish).not.toHaveBeenCalled();
    coordinator.cancelAll();
    await coordinator.drain();
  });

  it("expires, cancels idempotently, and cleans retained results on schedule", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const { coordinator } = createCoordinator(async () => ({
      status: "pending",
      interaction: "device-code",
      userCode: "code",
      verificationUri: "https://device.test",
      expiresAt: new Date(Date.now() + 100).toISOString(),
      finish: vi.fn(),
      cancel,
    }));
    const result = await coordinator.start("codex", "device-code");
    if (result.status !== "pending") throw new Error("expected session");
    await vi.advanceTimersByTimeAsync(100);
    expect(coordinator.getSession(result.sessionId).status).toBe("expired");
    coordinator.cancel(result.sessionId);
    coordinator.cancel(result.sessionId);
    await expect(coordinator.finish(result.sessionId)).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(1000);
    expect(() => coordinator.getSession(result.sessionId)).toThrow("清理");
    coordinator.cancelAll();
    await coordinator.drain();
    expect(vi.getTimerCount()).toBe(0);
  });
});
