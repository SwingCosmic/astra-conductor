import { Notification, type Event } from "electron";
import type {
  CredentialRefreshOutcome,
  NotificationCandidate,
  RefreshCoordinator,
  RefreshOutcome,
  StoragePort,
} from "@astra-conductor/core/internal";

const NOTIFICATION_DELIVERY_TIMEOUT_MS = 3_000;

export interface SystemNotificationOptions {
  title: string;
  body: string;
}

export interface SystemNotificationPort {
  deliver(options: SystemNotificationOptions): Promise<boolean>;
}

class ElectronSystemNotificationPort implements SystemNotificationPort {
  async deliver(options: SystemNotificationOptions): Promise<boolean> {
    if (!Notification.isSupported()) return false;
    return new Promise((resolve) => {
      let settled = false;
      let notification: Notification | null = null;
      const finish = (delivered: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        notification?.removeListener("show", onShow);
        notification?.removeListener("failed", onFailed);
        notification = null;
        resolve(delivered);
      };
      const onShow = (): void => finish(true);
      const onFailed = (_event: Event, error: string): void => {
        console.warn("System notification delivery failed", error);
        finish(false);
      };
      const timeout = setTimeout(() => {
        console.warn("System notification delivery was not confirmed");
        finish(false);
      }, NOTIFICATION_DELIVERY_TIMEOUT_MS);
      try {
        notification = new Notification(options);
        notification.once("show", onShow);
        notification.once("failed", onFailed);
        notification.show();
      } catch (error) {
        console.warn(
          "System notification delivery failed",
          error instanceof Error ? error.message : "unknown error",
        );
        finish(false);
      }
    });
  }
}

function shouldNotify(storage: StoragePort, candidate: NotificationCandidate): boolean {
  const previous = storage.notifications
    .list(candidate.accountId)
    .find((item) => item.quotaKey === candidate.quotaKey);
  return (
    !previous ||
    !previous.deliveryConfirmed ||
    previous.resetAt !== candidate.resetAt ||
    previous.level !== candidate.level
  );
}

export class PollingService {
  private readonly pendingNotifications = new Set<string>();
  private readonly activeOperations = new Set<Promise<unknown>>();

  constructor(
    private readonly storage: StoragePort,
    private readonly coordinator: RefreshCoordinator,
    private readonly systemNotifications: SystemNotificationPort = new ElectronSystemNotificationPort(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async stopAndDrain(): Promise<void> {
    while (this.activeOperations.size) {
      await Promise.allSettled([...this.activeOperations]);
    }
  }

  refresh(accountId: string): Promise<RefreshOutcome> {
    return this.track(this.performRefresh(accountId));
  }

  private async performRefresh(accountId: string): Promise<RefreshOutcome> {
    const outcome = await this.coordinator.refresh(accountId);
    await this.notify(outcome);
    return outcome;
  }

  refreshCredentials(accountId: string): Promise<CredentialRefreshOutcome> {
    return this.track(this.coordinator.refreshCredentials(accountId));
  }

  refreshAll(): Promise<RefreshOutcome[]> {
    return this.track(this.performRefreshAll());
  }

  private async performRefreshAll(): Promise<RefreshOutcome[]> {
    const outcomes = await this.coordinator.refreshAll();
    await Promise.all(outcomes.map((outcome) => this.notify(outcome)));
    return outcomes;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    void operation.then(
      () => this.activeOperations.delete(operation),
      () => this.activeOperations.delete(operation),
    );
    return operation;
  }

  private async notify(outcome: RefreshOutcome): Promise<void> {
    if (outcome.status !== "updated") return;
    const account = this.storage.accounts.get(outcome.accountId);
    if (!account) return;
    const deliveries: Promise<void>[] = [];
    for (const candidate of outcome.notifications) {
      if (!shouldNotify(this.storage, candidate)) continue;
      const pendingKey = [
        candidate.accountId,
        candidate.quotaKey,
        candidate.resetAt ?? "",
        candidate.level,
      ].join("\0");
      if (this.pendingNotifications.has(pendingKey)) continue;
      this.pendingNotifications.add(pendingKey);
      deliveries.push(
        this.systemNotifications
          .deliver({
            title: account.displayName,
            body: `剩余额度 ${candidate.remainingPercentage.toFixed(0)}%`,
          })
          .then((delivered) => {
            if (!delivered) return;
            this.storage.notifications.save({
              accountId: candidate.accountId,
              quotaKey: candidate.quotaKey,
              resetAt: candidate.resetAt,
              level: candidate.level,
              lastNotifiedAt: this.now().toISOString(),
              deliveryConfirmed: true,
            });
          })
          .finally(() => this.pendingNotifications.delete(pendingKey)),
      );
    }
    await Promise.all(deliveries);
  }
}
