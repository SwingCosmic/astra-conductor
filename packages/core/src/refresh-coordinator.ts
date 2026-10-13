import { AppError, toPublicError, type PublicErrorDto } from "./errors.js";
import type {
  Account,
  CredentialEnvelope,
  NotificationCandidate,
  UsageSnapshot,
} from "./models.js";
import type { ClockPort, LoggerPort, StoragePort } from "./ports.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { CredentialVault } from "./credential-vault.js";
import { silentLogger } from "./logger.js";

export type RefreshOutcome =
  | {
      status: "updated";
      accountId: string;
      snapshot: UsageSnapshot;
      notifications: NotificationCandidate[];
    }
  | { status: "skipped"; accountId: string }
  | { status: "failed"; accountId: string; error: PublicErrorDto };

export type CredentialRefreshOutcome =
  | {
      status: "updated" | "unchanged";
      accountId: string;
      tokenExpiresAt: string | null;
    }
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
          displayName: quota.displayName,
          windowSeconds: quota.windowSeconds,
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
  private readonly operationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: StoragePort,
    private readonly vault: CredentialVault,
    private readonly registry: ProviderRegistry,
    private readonly clock: ClockPort = { now: () => new Date() },
    private readonly logger: LoggerPort = silentLogger,
  ) {}

  refresh(accountId: string): Promise<RefreshOutcome> {
    const running = this.inFlight.get(accountId);
    if (running) return running;
    const operation = this.serialize(accountId, () => this.run(accountId)).finally(() =>
      this.inFlight.delete(accountId),
    );
    this.inFlight.set(accountId, operation);
    return operation;
  }

  refreshCredentials(accountId: string): Promise<CredentialRefreshOutcome> {
    return this.serialize(accountId, () => this.runCredentialRefresh(accountId));
  }

  async refreshAll(): Promise<RefreshOutcome[]> {
    return Promise.all(this.storage.accounts.list().map((account) => this.refresh(account.id)));
  }

  private serialize<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(accountId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.operationTails.set(accountId, tail);
    void tail.finally(() => {
      if (this.operationTails.get(accountId) === tail) this.operationTails.delete(accountId);
    });
    return result;
  }

  private async runCredentialRefresh(accountId: string): Promise<CredentialRefreshOutcome> {
    const account = this.storage.accounts.get(accountId);
    if (!account) {
      return {
        status: "failed",
        accountId,
        error: toPublicError(new AppError("validation", "Account does not exist")),
      };
    }
    try {
      const refresh = this.registry.getAccount(account.provider)?.refreshCredentials;
      if (!refresh) {
        throw new AppError("validation", `该账号类型没有主动刷新协议：${account.provider}`);
      }
      const current = await this.vault.load(account.id);
      const refreshed = await refresh(account, current, { force: true });
      if (refreshed.changed) await this.persistCredentials(account, refreshed.envelope);
      return {
        status: refreshed.changed ? "updated" : "unchanged",
        accountId,
        tokenExpiresAt: refreshed.envelope.expiresAt,
      };
    } catch (error) {
      if (error instanceof AppError && error.code === "secure-storage") {
        this.storage.accounts.setCredentialState(
          account.id,
          "locked",
          this.clock.now().toISOString(),
        );
      }
      return { status: "failed", accountId, error: toPublicError(error) };
    }
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
      const usage = this.registry.requireUsage(account.provider);
      const refresh = this.registry.getAccount(account.provider)?.refreshCredentials;
      let envelope = await this.vault.load(account.id);
      if (refresh) {
        const refreshed = await refresh(account, envelope, { force: false });
        envelope = refreshed.envelope;
        if (refreshed.changed) await this.persistCredentials(account, envelope);
      }

      let snapshot: UsageSnapshot;
      try {
        snapshot = await usage.fetchUsage(account, envelope);
      } catch (error) {
        if (!refresh || !(error instanceof AppError) || error.code !== "authentication") {
          throw error;
        }
        const forced = await refresh(account, envelope, { force: true });
        envelope = forced.envelope;
        if (forced.changed) await this.persistCredentials(account, envelope);
        snapshot = await usage.fetchUsage(account, envelope);
      }
      this.storage.transaction(() => {
        this.storage.snapshots.save(snapshot);
        this.storage.accounts.setCredentialState(account.id, "available", snapshot.fetchedAt);
      });
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
