import { Notification } from "electron";
import type {
  NotificationCandidate,
  RefreshCoordinator,
  RefreshOutcome,
  StoragePort,
} from "@llm-usage/core/internal";

const DEFAULT_INTERVAL_MINUTES = 15;

function shouldNotify(storage: StoragePort, candidate: NotificationCandidate): boolean {
  const previous = storage.notifications
    .list(candidate.accountId)
    .find((item) => item.quotaKey === candidate.quotaKey);
  return !previous || previous.resetAt !== candidate.resetAt || previous.level !== candidate.level;
}

export class PollingService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly storage: StoragePort,
    private readonly coordinator: RefreshCoordinator,
  ) {}

  start(): void {
    if (this.storage.settings.get("pollingEnabled") === false) return;
    const configured = this.storage.settings.get("pollingIntervalMinutes");
    const minutes = typeof configured === "number" ? configured : DEFAULT_INTERVAL_MINUTES;
    this.timer = setInterval(() => void this.refreshAll(), Math.max(5, minutes) * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(accountId: string): Promise<RefreshOutcome> {
    const outcome = await this.coordinator.refresh(accountId);
    this.notify(outcome);
    return outcome;
  }

  async refreshAll(): Promise<RefreshOutcome[]> {
    const outcomes = await this.coordinator.refreshAll();
    for (const outcome of outcomes) this.notify(outcome);
    return outcomes;
  }

  private notify(outcome: RefreshOutcome): void {
    if (outcome.status !== "updated") return;
    const account = this.storage.accounts.get(outcome.accountId);
    if (!account) return;
    for (const candidate of outcome.notifications) {
      if (!shouldNotify(this.storage, candidate)) continue;
      new Notification({
        title: `${account.displayName} · ${candidate.title}`,
        body: `剩余额度 ${candidate.remainingPercentage.toFixed(0)}%`,
      }).show();
      this.storage.notifications.save({
        accountId: candidate.accountId,
        quotaKey: candidate.quotaKey,
        resetAt: candidate.resetAt,
        level: candidate.level,
        lastNotifiedAt: new Date().toISOString(),
      });
    }
  }
}
