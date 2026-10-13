import { describe, expect, it, vi, type Mock } from "vitest";
import {
  CredentialVault,
  MemoryStorage,
  ProviderRegistry,
  computeCompositeRemaining,
  providerCatalog,
  type Account,
  type CredentialCipherPort,
  type ProviderContribution,
  type RefreshOutcome,
  type UsageSnapshot,
} from "@astra-conductor/core/internal";
import {
  parseSnapshot,
  type PolyQuotaChangedEvent,
  type PolyQuotaSnapshot,
} from "@astra-conductor/polyquota-contract";
import type { AuthCoordinator } from "@astra-conductor/core/internal";
import { PolyQuotaApplicationService } from "../src/polyquota-application-service.js";
import type { PollingService } from "../src/polling-service.js";
import { RefreshScheduler } from "../src/refresh-scheduler.js";

const account: Account = {
  id: "account-1",
  provider: "codex",
  offeringId: "codex",
  authMethod: "cli-import",
  stableIdentity: "codex:test",
  displayName: "Test account",
  maskedIdentifier: "te***@example.test",
  enabled: true,
  credentialState: "available",
  publicMetadata: {},
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
};

const refreshOutcome: Extract<RefreshOutcome, { status: "updated" }> = {
  status: "updated",
  accountId: account.id,
  snapshot: {
    accountId: account.id,
    plan: "plus",
    overallRemainingPercentage: 80,
    groups: [],
    extras: [],
    resetCredits: null,
    fetchedAt: "2026-09-27T00:01:00.000Z",
  },
  notifications: [],
};

/** 从真实目录派生的测试注册表：用量/账号 facet 为桩，glm 可注入兑换桩。 */
function testRegistry(redeemResetCredit?: Mock): ProviderRegistry {
  const contributions = providerCatalog.map(
    (descriptor): ProviderContribution => ({
      descriptor,
      account: {
        providerId: descriptor.provider,
        supportedMethods: [
          ...new Set(
            descriptor.offerings.flatMap((offering) =>
              offering.authMethods.map((method) => method.method),
            ),
          ),
        ],
        startAuth: async () => {
          throw new Error("not used in this test");
        },
      },
      usage: {
        providerId: descriptor.provider,
        fetchUsage: async () => {
          throw new Error("not used in this test");
        },
        ...(descriptor.provider === "glm" && redeemResetCredit
          ? { redeemResetCard: redeemResetCredit }
          : {}),
      },
    }),
  );
  return new ProviderRegistry(contributions);
}

function createService(savedAccount: Account = account, redeemResetCredit?: Mock) {
  const storage = new MemoryStorage();
  storage.accounts.save(savedAccount);
  storage.snapshots.save(refreshOutcome.snapshot);
  const cipher: CredentialCipherPort = {
    isAvailable: vi.fn().mockResolvedValue(true),
    encrypt: vi.fn(),
    decrypt: vi.fn().mockResolvedValue({
      plaintext: JSON.stringify({
        version: 1,
        accountId: savedAccount.id,
        provider: savedAccount.provider,
        authMethod: savedAccount.authMethod,
        expiresAt: null,
        secrets: { apiKey: "private-key" },
      }),
      shouldReEncrypt: false,
    }),
  };
  storage.credentials.save({
    accountId: savedAccount.id,
    encryptionVersion: 1,
    ciphertext: Buffer.from("encrypted"),
    updatedAt: savedAccount.updatedAt,
  });
  const events: PolyQuotaChangedEvent[] = [];
  const polling = {
    refresh: vi.fn().mockResolvedValue(refreshOutcome),
    refreshAll: vi.fn().mockResolvedValue([refreshOutcome]),
    refreshCredentials: vi.fn(),
  } as unknown as PollingService;
  const auth = { cancel: vi.fn() } as unknown as AuthCoordinator;
  const detectProxyStatus = vi.fn().mockResolvedValue({ proxyMode: "system", proxyAddress: null });
  const service = new PolyQuotaApplicationService(
    storage,
    new CredentialVault(storage, cipher),
    polling,
    auth,
    {
      publishChanged: (event) => events.push(event),
      registry: testRegistry(redeemResetCredit),
      detectProxyStatus,
      now: () => new Date("2026-09-27T00:02:00.000Z"),
    },
  );
  const scheduler = new RefreshScheduler(
    (source) => service.executeRefreshBatch(source),
    () => service.schedulerChanged(),
    () => new Date("2026-09-27T00:02:00.000Z"),
    { set: () => 1, clear: () => undefined },
  );
  service.attachScheduler(scheduler);
  scheduler.start(service.getSettings());
  return { service, storage, polling, scheduler, events, redeemResetCredit, detectProxyStatus };
}

function remainingFromVisibleUsage(snapshot: PolyQuotaSnapshot) {
  return computeCompositeRemaining(
    snapshot.accounts.map((item) => ({
      enabled: item.enabled,
      provider: item.provider,
      offeringId: item.offeringId,
      snapshot: snapshot.usageByAccountId[item.id] ?? null,
    })),
  );
}

describe("PolyQuotaApplicationService", () => {
  it("returns one revisioned snapshot with matching account and usage keys", async () => {
    const { service } = createService();
    const snapshot = await service.getSnapshot();

    expect(snapshot.accounts.map((item) => item.id)).toEqual([account.id]);
    expect(Object.keys(snapshot.usageByAccountId)).toEqual([account.id]);
    expect(snapshot.usageByAccountId[account.id]?.plan).toBe("plus");
    expect(snapshot.settings).toEqual({
      pollingEnabled: true,
      pollingIntervalMinutes: 15,
      taskbarProgressEnabled: true,
    });
    expect(snapshot.compositeRemaining).toMatchObject({
      status: "incomplete",
      enabledAccountCount: 1,
      scoredAccountCount: 0,
    });
  });

  it("refreshes stored snapshots that predate the reset-credits schema exactly once", async () => {
    const legacySnapshot = {
      accountId: account.id,
      plan: "plus",
      overallRemainingPercentage: 80,
      groups: [],
      extras: [
        {
          key: "reset-credits",
          value: "2",
          items: [{ key: "weekly:0", kind: "weekly", expiresAt: null, actionToken: "c-1" }],
        },
      ],
      fetchedAt: "2026-09-26T00:00:00.000Z",
    } as unknown as UsageSnapshot;
    const { service, storage, polling, events } = createService();
    storage.snapshots.save(legacySnapshot);
    const baselineEvents = events.length;

    // 破坏性结构更新：旧结构快照不做投影适配，照常展示并立即触发一次刷新。
    const first = await service.getSnapshot();
    expect(first.usageByAccountId[account.id]?.resetCredits).toBeNull();
    expect(first.usageByAccountId[account.id]?.extras[0]?.key).toBe("reset-credits");
    expect(polling.refresh).toHaveBeenCalledTimes(1);
    expect(polling.refresh).toHaveBeenCalledWith(account.id);

    await service.getSnapshot();
    expect(polling.refresh).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.slice(baselineEvents).some((event) => event.reasons.includes("usage"))).toBe(
      true,
    );
  });

  it("emits a snapshot the desktop preload parser accepts, including the live provider catalog", async () => {
    const { service, storage } = createService(account);
    storage.snapshots.save({
      ...refreshOutcome.snapshot,
      groups: [
        {
          key: "default",
          displayName: null,
          quotas: [
            {
              key: "session",
              displayName: null,
              windowSeconds: 18_000,
              used: 0,
              total: 100,
              remaining: 100,
              remainingPercentage: 100,
              resetAt: null,
              unlimited: false,
            },
            {
              key: "weekly",
              displayName: null,
              windowSeconds: 604_800,
              used: 0,
              total: 100,
              remaining: 100,
              remainingPercentage: 100,
              resetAt: null,
              unlimited: false,
            },
          ],
        },
      ],
    });
    const snapshot = structuredClone(await service.getSnapshot());
    expect(() => parseSnapshot(snapshot)).not.toThrow();
    expect(parseSnapshot(snapshot).compositeRemaining.status).toBe("complete");
    expect(parseSnapshot(snapshot).providers.length).toBeGreaterThan(0);
  });

  it("computes composite remaining from enabled account snapshots", async () => {
    const { service, storage } = createService();
    storage.snapshots.save({
      ...refreshOutcome.snapshot,
      groups: [
        {
          key: "default",
          displayName: null,
          quotas: [
            {
              key: "session",
              displayName: null,
              windowSeconds: 18_000,
              used: 20,
              total: 100,
              remaining: 80,
              remainingPercentage: 80,
              resetAt: null,
              unlimited: false,
            },
            {
              key: "weekly",
              displayName: null,
              windowSeconds: 604_800,
              used: 50,
              total: 100,
              remaining: 50,
              remainingPercentage: 50,
              resetAt: null,
              unlimited: false,
            },
          ],
        },
      ],
    });

    await expect(service.getSnapshot()).resolves.toMatchObject({
      compositeRemaining: {
        status: "complete",
        sessionScore: 80,
        weeklyScore: 50,
        remaining: 50,
        band: "attention",
        sessionBand: "healthy",
        weeklyBand: "attention",
        enabledAccountCount: 1,
        scoredAccountCount: 1,
      },
    });
  });

  it("recomputes R from all stored snapshots on startup and after one account refresh", async () => {
    const second: Account = {
      ...account,
      id: "account-2",
      stableIdentity: "codex:second",
      displayName: "Second account",
    };
    const { service, storage } = createService();
    storage.accounts.save(second);
    const quotas = (
      session: number,
      weekly: number,
      fetchedAt: string,
      accountId: string,
    ): (typeof refreshOutcome)["snapshot"] => ({
      accountId,
      plan: "plus",
      overallRemainingPercentage: Math.min(session, weekly),
      fetchedAt,
      extras: [],
      resetCredits: null,
      groups: [
        {
          key: "default",
          displayName: null,
          quotas: [
            {
              key: "session",
              displayName: null,
              windowSeconds: 18_000,
              used: 100 - session,
              total: 100,
              remaining: session,
              remainingPercentage: session,
              resetAt: null,
              unlimited: false,
            },
            {
              key: "weekly",
              displayName: null,
              windowSeconds: 604_800,
              used: 100 - weekly,
              total: 100,
              remaining: weekly,
              remainingPercentage: weekly,
              resetAt: null,
              unlimited: false,
            },
          ],
        },
      ],
    });
    storage.snapshots.save(quotas(80, 40, "2026-09-26T00:00:00.000Z", account.id));
    storage.snapshots.save(quotas(20, 90, "2026-09-26T00:00:00.000Z", second.id));

    await expect(service.getSnapshot()).resolves.toMatchObject({
      compositeRemaining: {
        status: "complete",
        sessionScore: 50,
        weeklyScore: 65,
        remaining: 50,
        scoredAccountCount: 2,
      },
    });

    storage.snapshots.save(quotas(100, 100, "2026-09-27T00:02:00.000Z", account.id));
    await expect(service.getSnapshot()).resolves.toMatchObject({
      compositeRemaining: {
        status: "complete",
        sessionScore: 60,
        weeklyScore: 95,
        remaining: 60,
        scoredAccountCount: 2,
      },
    });
  });

  it("derives R from visible enabled-account usage and stays stable across repeated reads", async () => {
    const second: Account = {
      ...account,
      id: "account-2",
      stableIdentity: "codex:second",
      displayName: "Second account",
    };
    const { service, storage } = createService();
    storage.accounts.save(second);
    storage.snapshots.save({
      ...refreshOutcome.snapshot,
      groups: [
        {
          key: "default",
          displayName: null,
          quotas: [
            {
              key: "session",
              displayName: null,
              windowSeconds: 18_000,
              used: 20,
              total: 100,
              remaining: 80,
              remainingPercentage: 80,
              resetAt: null,
              unlimited: false,
            },
            {
              key: "weekly",
              displayName: null,
              windowSeconds: 604_800,
              used: 60,
              total: 100,
              remaining: 40,
              remainingPercentage: 40,
              resetAt: null,
              unlimited: false,
            },
          ],
        },
      ],
    });
    storage.snapshots.save({
      accountId: second.id,
      plan: "plus",
      overallRemainingPercentage: 20,
      extras: [],
      resetCredits: null,
      fetchedAt: "2026-09-26T00:00:00.000Z",
      groups: [
        {
          key: "default",
          displayName: null,
          quotas: [
            {
              key: "session",
              displayName: null,
              windowSeconds: 18_000,
              used: 80,
              total: 100,
              remaining: 20,
              remainingPercentage: 20,
              resetAt: null,
              unlimited: false,
            },
            {
              key: "weekly",
              displayName: null,
              windowSeconds: 604_800,
              used: 10,
              total: 100,
              remaining: 90,
              remainingPercentage: 90,
              resetAt: null,
              unlimited: false,
            },
          ],
        },
      ],
    });

    const first = await service.getSnapshot();
    const secondRead = await service.getSnapshot();
    expect(first.compositeRemaining).toEqual(remainingFromVisibleUsage(first));
    expect(secondRead.compositeRemaining).toEqual(first.compositeRemaining);
    expect(first.compositeRemaining).toMatchObject({
      remaining: 50,
      sessionScore: 50,
      weeklyScore: 65,
      scoredAccountCount: 2,
    });

    service.setAccountEnabled(second.id, false);
    const afterDisable = await service.getSnapshot();
    expect(afterDisable.compositeRemaining).toEqual(remainingFromVisibleUsage(afterDisable));
    expect(afterDisable.compositeRemaining).toMatchObject({
      remaining: 40,
      sessionScore: 80,
      weeklyScore: 40,
      enabledAccountCount: 1,
      scoredAccountCount: 1,
    });

    service.deleteAccount(account.id);
    const afterDelete = await service.getSnapshot();
    expect(afterDelete.compositeRemaining).toEqual(remainingFromVisibleUsage(afterDelete));
    expect(afterDelete.compositeRemaining.status).toBe("empty");
    expect(afterDelete.compositeRemaining.remaining).toBeNull();
  });

  it("answers system status by invoking the injected on-demand proxy detector", async () => {
    const { service, detectProxyStatus } = createService();

    await expect(service.getSystemStatus()).resolves.toEqual({
      proxyMode: "system",
      proxyAddress: null,
    });
    expect(detectProxyStatus).toHaveBeenCalledOnce();
  });

  it("publishes one coalesced invalidation after committed account changes", async () => {
    const { service, events } = createService();
    service.setAccountEnabled(account.id, false);
    service.deleteAccount(account.id);
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0]!.reasons).toEqual(expect.arrayContaining(["accounts", "usage", "operations"]));
    const snapshot = await service.getSnapshot();
    expect(snapshot.accounts).toEqual([]);
    expect(snapshot.usageByAccountId).toEqual({});
  });

  it("routes manual refresh-all through one scheduler batch and publishes the result", async () => {
    const { service, polling, events } = createService();
    const first = service.refreshAll("manual");
    const second = service.refreshAll("tray");
    const [left, right] = await Promise.all([first, second]);
    await Promise.resolve();

    expect(polling.refreshAll).toHaveBeenCalledOnce();
    expect(left).toEqual(right);
    expect(left.source).toBe("manual");
    expect(new Set(events.flatMap((event) => event.reasons))).toEqual(
      new Set(["accounts", "usage", "operations", "scheduler"]),
    );
  });

  it("uses an itemized reset credit and reconciles a stale provider refresh", async () => {
    const glmAccount: Account = {
      ...account,
      provider: "glm",
      offeringId: "bigmodel-coding-plan",
      authMethod: "api-key",
      stableIdentity: "coding-plan:china:test",
    };
    const redeemResetCredit = vi.fn().mockResolvedValue(undefined);
    const { service, storage, polling } = createService(glmAccount, redeemResetCredit);
    const staleSnapshot: Extract<RefreshOutcome, { status: "updated" }> = {
      ...refreshOutcome,
      accountId: glmAccount.id,
      snapshot: {
        ...refreshOutcome.snapshot,
        accountId: glmAccount.id,
        resetCredits: {
          kind: "itemized",
          items: [
            { id: "record-1", type: "five-hour", expiresAt: null },
            { id: "record-2", type: "weekly", expiresAt: null },
          ],
        },
      },
    };
    vi.mocked(polling.refresh).mockResolvedValueOnce(staleSnapshot);

    await expect(
      service.redeemResetCredit(glmAccount.id, { kind: "item", itemId: "record-1" }),
    ).resolves.toEqual({
      status: "redeemed",
      accountId: glmAccount.id,
      refreshStatus: "updated",
      remainingResetCredits: 1,
    });
    expect(redeemResetCredit).toHaveBeenCalledWith(
      glmAccount,
      expect.objectContaining({ secrets: { apiKey: "private-key" } }),
      { kind: "item", itemId: "record-1" },
    );
    expect(polling.refresh).toHaveBeenCalledWith(glmAccount.id);
    expect(storage.snapshots.get(glmAccount.id)?.resetCredits).toEqual({
      kind: "itemized",
      items: [{ id: "record-2", type: "weekly", expiresAt: null }],
    });

    vi.mocked(polling.refresh).mockResolvedValueOnce(staleSnapshot);
    const laterRefresh = await service.refreshAccount(glmAccount.id);
    expect(laterRefresh.status).toBe("updated");
    if (laterRefresh.status !== "updated") throw new Error("Expected updated refresh");
    expect(laterRefresh.snapshot.resetCredits).toEqual({
      kind: "itemized",
      items: [{ id: "record-2", type: "weekly", expiresAt: null }],
    });
  });

  it("treats aggregate redemption as server-authoritative without local deduction", async () => {
    const glmAccount: Account = {
      ...account,
      provider: "glm",
      offeringId: "bigmodel-coding-plan",
      authMethod: "api-key",
      stableIdentity: "coding-plan:china:aggregate",
    };
    const redeemResetCredit = vi.fn().mockResolvedValue(undefined);
    const { service, storage, polling } = createService(glmAccount, redeemResetCredit);
    const aggregateSnapshot: Extract<RefreshOutcome, { status: "updated" }> = {
      ...refreshOutcome,
      accountId: glmAccount.id,
      snapshot: {
        ...refreshOutcome.snapshot,
        accountId: glmAccount.id,
        resetCredits: { kind: "aggregate", totals: [{ type: "banked", total: 3 }] },
      },
    };
    vi.mocked(polling.refresh).mockImplementationOnce(async () => {
      // 模拟真实 PollingService：服务端刷新结果落库后再返回。
      storage.snapshots.save(aggregateSnapshot.snapshot);
      return aggregateSnapshot;
    });

    await expect(service.redeemResetCredit(glmAccount.id, { kind: "aggregate" })).resolves.toEqual({
      status: "redeemed",
      accountId: glmAccount.id,
      refreshStatus: "updated",
      remainingResetCredits: null,
    });
    expect(redeemResetCredit).toHaveBeenCalledWith(
      glmAccount,
      expect.objectContaining({ secrets: { apiKey: "private-key" } }),
      { kind: "aggregate" },
    );
    // 聚合计数以服务端刷新为准：不本地扣减、不过滤。
    expect(storage.snapshots.get(glmAccount.id)?.resetCredits).toEqual({
      kind: "aggregate",
      totals: [{ type: "banked", total: 3 }],
    });
  });

  it("rejects redemption for providers without a redemption protocol", async () => {
    const { service } = createService(account);

    await expect(
      service.redeemResetCredit(account.id, { kind: "aggregate" }),
    ).rejects.toMatchObject({ code: "validation" });
  });
});
