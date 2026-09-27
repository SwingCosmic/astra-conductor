import { describe, expect, it, vi } from "vitest";
import {
  CredentialVault,
  MemoryStorage,
  type Account,
  type CredentialCipherPort,
  type RefreshOutcome,
} from "@astra-conductor/core/internal";
import type { PolyQuotaChangedEvent } from "@astra-conductor/polyquota-contract";
import { PolyQuotaApplicationService } from "../src/polyquota-application-service.js";
import type { AuthService } from "../src/auth-service.js";
import type { PollingService } from "../src/polling-service.js";
import { RefreshScheduler } from "../src/refresh-scheduler.js";

const account: Account = {
  id: "account-1",
  provider: "codex",
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
    fetchedAt: "2026-09-27T00:01:00.000Z",
  },
  notifications: [],
};

function createService(savedAccount: Account = account) {
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
  const redeemResetCredit = vi.fn().mockResolvedValue(undefined);
  const polling = {
    refresh: vi.fn().mockResolvedValue(refreshOutcome),
    refreshAll: vi.fn().mockResolvedValue([refreshOutcome]),
    refreshCredentials: vi.fn(),
  } as unknown as PollingService;
  const auth = { cancel: vi.fn() } as unknown as AuthService;
  const service = new PolyQuotaApplicationService(
    storage,
    new CredentialVault(storage, cipher),
    polling,
    auth,
    {
      publishChanged: (event) => events.push(event),
      redeemResetCredit,
      resolveProxy: vi.fn().mockResolvedValue("DIRECT"),
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
  return { service, storage, polling, scheduler, events, redeemResetCredit };
}

describe("PolyQuotaApplicationService", () => {
  it("returns one revisioned snapshot with matching account and usage keys", async () => {
    const { service } = createService();
    const snapshot = await service.getSnapshot();

    expect(snapshot.accounts.map((item) => item.id)).toEqual([account.id]);
    expect(Object.keys(snapshot.usageByAccountId)).toEqual([account.id]);
    expect(snapshot.usageByAccountId[account.id]?.plan).toBe("plus");
    expect(snapshot.settings).toEqual({ pollingEnabled: true, pollingIntervalMinutes: 15 });
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

  it("uses a selected reset credit and reconciles a stale provider refresh", async () => {
    const glmAccount: Account = {
      ...account,
      provider: "glm",
      authMethod: "api-key",
      stableIdentity: "coding-plan:china:test",
      publicMetadata: { region: "china" },
    };
    const { service, storage, polling, redeemResetCredit } = createService(glmAccount);
    const staleSnapshot: Extract<RefreshOutcome, { status: "updated" }> = {
      ...refreshOutcome,
      accountId: glmAccount.id,
      snapshot: {
        ...refreshOutcome.snapshot,
        accountId: glmAccount.id,
        extras: [
          {
            key: "reset-credits",
            value: "2",
            items: [
              {
                key: "five-hour:0",
                kind: "five-hour",
                expiresAt: null,
                actionToken: "record-1",
              },
              {
                key: "weekly:1",
                kind: "weekly",
                expiresAt: null,
                actionToken: "record-2",
              },
            ],
          },
        ],
      },
    };
    vi.mocked(polling.refresh).mockResolvedValueOnce(staleSnapshot);

    await expect(service.redeemResetCredit(glmAccount.id, "record-1")).resolves.toEqual({
      status: "redeemed",
      accountId: glmAccount.id,
      refreshStatus: "updated",
      remainingResetCredits: 1,
    });
    expect(redeemResetCredit).toHaveBeenCalledWith(
      glmAccount,
      expect.objectContaining({ secrets: { apiKey: "private-key" } }),
      "record-1",
    );
    expect(polling.refresh).toHaveBeenCalledWith(glmAccount.id);
    expect(storage.snapshots.get(glmAccount.id)?.extras).toEqual([
      {
        key: "reset-credits",
        value: "1",
        items: [
          {
            key: "weekly:1",
            kind: "weekly",
            expiresAt: null,
            actionToken: "record-2",
          },
        ],
      },
    ]);

    vi.mocked(polling.refresh).mockResolvedValueOnce(staleSnapshot);
    const laterRefresh = await service.refreshAccount(glmAccount.id);
    expect(laterRefresh.status).toBe("updated");
    if (laterRefresh.status !== "updated") throw new Error("Expected updated refresh");
    expect(laterRefresh.snapshot.extras[0]?.value).toBe("1");
    expect(laterRefresh.snapshot.extras[0]?.items?.map((item) => item.actionToken)).toEqual([
      "record-2",
    ]);
  });
});
