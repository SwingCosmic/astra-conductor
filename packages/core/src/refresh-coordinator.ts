import { AppError, toPublicError, type PublicErrorDto } from "./errors.js";
import type {
  Account,
  CredentialEnvelope,
  NotificationCandidate,
  UsageSnapshot,
} from "./models.js";
import type { ClockPort, LoggerPort, StoragePort } from "./ports.js";
import { CredentialVault } from "./credential-vault.js";
import { CodexAdapter, silentLogger } from "./codex-adapter.js";

export type RefreshOutcome =
  | {
      status: "updated";
      accountId: string;
      snapshot: UsageSnapshot;
      notifications: NotificationCandidate[];
    }
  | { status: "skipped"; accountId: string }
  | { status: "failed"; accountId: string; error: PublicErrorDto };

function notificationCandidates(snapshot: UsageSnapshot): NotificationCandidate[] {
  return snapshot.groups.flatMap((group) =>
    group.quotas.flatMap((quota) => {
      const remaining = quota.remainingPercentage;
      if (remaining === null || remaining > 20) return [];
      return [
        {
          accountId: snapshot.accountId,
          quotaKey: `${group.key}:${quota.key}`,
          title: quota.title,
          level: remaining <= 5 ? "critical" : "warning",
          remainingPercentage: remaining,
          resetAt: quota.resetAt,
        } satisfies NotificationCandidate,
      ];
    }),
  );
}

export class RefreshCoordinator {
  private readonly inFlight = new Map<string, Promise<RefreshOutcome>>();

  constructor(
    private readonly storage: StoragePort,
    private readonly vault: CredentialVault,
    private readonly codex: CodexAdapter,
    private readonly clock: ClockPort = { now: () => new Date() },
    private readonly logger: LoggerPort = silentLogger,
  ) {}

  refresh(accountId: string): Promise<RefreshOutcome> {
    const running = this.inFlight.get(accountId);
    if (running) return running;
    const operation = this.run(accountId).finally(() => this.inFlight.delete(accountId));
    this.inFlight.set(accountId, operation);
    return operation;
  }

  async refreshAll(): Promise<RefreshOutcome[]> {
    return Promise.all(this.storage.accounts.list().map((account) => this.refresh(account.id)));
  }

  private async run(accountId: string): Promise<RefreshOutcome> {
    const started = this.clock.now().getTime();
    const account = this.storage.accounts.get(accountId);
    if (!account) {
      return {
        status: "failed",
        accountId,
        error: toPublicError(new AppError("validation", "Account does not exist")),
      };
    }
    if (!account.enabled) return { status: "skipped", accountId };
    try {
      let envelope = await this.vault.load(account.id);
      const refreshed = await this.codex.refreshCredentials(account, envelope);
      envelope = refreshed.envelope;
      if (refreshed.changed) await this.persistCredentials(account, envelope);

      let snapshot: UsageSnapshot;
      try {
        snapshot = await this.codex.fetchUsage(account, envelope);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "authentication") throw error;
        const forced = await this.codex.refreshCredentials(account, envelope, true);
        envelope = forced.envelope;
        if (forced.changed) await this.persistCredentials(account, envelope);
        snapshot = await this.codex.fetchUsage(account, envelope);
      }
      this.storage.snapshots.save(snapshot);
      this.storage.accounts.setCredentialState(account.id, "available", snapshot.fetchedAt);
      this.logger.info("Account usage refreshed", {
        provider: account.provider,
        account: account.maskedIdentifier,
        stage: "usage",
        durationMs: this.clock.now().getTime() - started,
      });
      return {
        status: "updated",
        accountId,
        snapshot,
        notifications: notificationCandidates(snapshot),
      };
    } catch (error) {
      if (error instanceof AppError && error.code === "secure-storage") {
        this.storage.accounts.setCredentialState(
          account.id,
          "locked",
          this.clock.now().toISOString(),
        );
      }
      const publicError = toPublicError(error);
      this.logger.error("Account refresh failed", {
        provider: account.provider,
        account: account.maskedIdentifier,
        stage: "usage",
        durationMs: this.clock.now().getTime() - started,
        code: publicError.code,
      });
      return { status: "failed", accountId, error: publicError };
    }
  }

  private async persistCredentials(account: Account, envelope: CredentialEnvelope): Promise<void> {
    const encrypted = await this.vault.seal(account, envelope);
    const timestamp = this.clock.now().toISOString();
    this.storage.transaction(() => {
      this.storage.credentials.save(encrypted);
      this.storage.accounts.save({
        ...account,
        credentialState: "available",
        updatedAt: timestamp,
      });
    });
  }
}
