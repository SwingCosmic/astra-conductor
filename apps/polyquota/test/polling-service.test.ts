import { describe, expect, it, vi } from "vitest";
import {
  MemoryStorage,
  type Account,
  type RefreshCoordinator,
  type RefreshOutcome,
} from "@astra-conductor/core/internal";
import { PollingService, type SystemNotificationPort } from "../src/polling-service.js";

const account: Account = {
  id: "account-1",
  provider: "glm",
  authMethod: "api-key",
  stableIdentity: "glm:account-1",
  displayName: "BigModel Coding Plan",
  maskedIdentifier: "a41a***x0sd",
  enabled: true,
  credentialState: "available",
  publicMetadata: { region: "china" },
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
};

const outcome: RefreshOutcome = {
  status: "updated",
  accountId: account.id,
  snapshot: {
    accountId: account.id,
    plan: "Pro",
    overallRemainingPercentage: 0,
    groups: [],
    extras: [],
    fetchedAt: "2026-09-25T12:00:00.000Z",
  },
  notifications: [
    {
      accountId: account.id,
      quotaKey: "default:session",
      displayName: "5 小时",
      windowSeconds: 18_000,
      level: "critical",
      remainingPercentage: 0,
      resetAt: "2026-09-25T15:00:00.000Z",
    },
  ],
};

function coordinator(): RefreshCoordinator {
  return {
    refresh: vi.fn().mockResolvedValue(outcome),
    refreshAll: vi.fn().mockResolvedValue([outcome]),
  } as unknown as RefreshCoordinator;
}

describe("PollingService notifications", () => {
  it("saves dedupe state only after the system confirms delivery", async () => {
    const storage = new MemoryStorage();
    storage.accounts.save(account);
    const notifications: SystemNotificationPort = {
      deliver: vi.fn().mockResolvedValue(false),
    };
    const polling = new PollingService(storage, coordinator(), notifications);

    await polling.refresh(account.id);
    await polling.refresh(account.id);

    expect(notifications.deliver).toHaveBeenCalledTimes(2);
    expect(storage.notifications.list(account.id)).toEqual([]);
  });

  it("deduplicates confirmed delivery but retries legacy unconfirmed state", async () => {
    const storage = new MemoryStorage();
    storage.accounts.save(account);
    storage.notifications.save({
      accountId: account.id,
      quotaKey: "default:session",
      resetAt: "2026-09-25T15:00:00.000Z",
      level: "critical",
      lastNotifiedAt: "2026-09-25T11:00:00.000Z",
      deliveryConfirmed: false,
    });
    const notifications: SystemNotificationPort = {
      deliver: vi.fn().mockResolvedValue(true),
    };
    const polling = new PollingService(
      storage,
      coordinator(),
      notifications,
      () => new Date("2026-09-25T12:30:00.000Z"),
    );

    await polling.refresh(account.id);
    await polling.refresh(account.id);

    expect(notifications.deliver).toHaveBeenCalledTimes(1);
    expect(storage.notifications.list(account.id)).toEqual([
      {
        accountId: account.id,
        quotaKey: "default:session",
        resetAt: "2026-09-25T15:00:00.000Z",
        level: "critical",
        lastNotifiedAt: "2026-09-25T12:30:00.000Z",
        deliveryConfirmed: true,
      },
    ]);
  });
});
