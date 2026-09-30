import { randomUUID } from "node:crypto";
import {
  POLYQUOTA_SCHEMA_VERSION,
  type AuthStartResult,
  type CredentialRefreshOutcomeDto,
  type PolyQuotaChangedEvent,
  type PolyQuotaChangeReason,
  type PolyQuotaSnapshot,
  type PublicAccount,
  type PublicOperationKind,
  type PublicOperationState,
  type PublicProviderDescriptor,
  type PublicSystemStatus,
  type RedeemResetCreditOutcomeDto,
  type RefreshBatchOutcomeDto,
  type RefreshOutcomeDto,
  type Settings,
  type StartAuthRequest,
} from "@astra-conductor/polyquota-contract";
import {
  AppError,
  CredentialVault,
  toPublicAccount,
  toPublicUsage,
  type Account,
  type CredentialEnvelope,
  type CredentialRefreshOutcome,
  type RefreshOutcome,
  type StoragePort,
  type UsageSnapshot,
} from "@astra-conductor/core/internal";
import type { AuthService } from "./auth-service.js";
import type { PollingService } from "./polling-service.js";
import type { RefreshScheduler, RefreshSource } from "./refresh-scheduler.js";

export interface PolyQuotaApplicationServiceOptions {
  publishChanged: (event: PolyQuotaChangedEvent) => void;
  resolveProxy: () => Promise<string>;
  providerCatalog: readonly PublicProviderDescriptor[];
  redeemResetCredit: (
    account: Account,
    envelope: CredentialEnvelope,
    selectionToken: string,
  ) => Promise<void>;
  now?: () => Date;
}

function reconcileRedeemedResetCredit(
  snapshot: UsageSnapshot,
  selectionToken: string,
): { snapshot: UsageSnapshot; remainingResetCredits: number | null } {
  let changed = false;
  let remainingResetCredits: number | null = null;
  const extras = snapshot.extras.map((extra) => {
    if (extra.key !== "reset-credits" || !extra.items) return extra;
    const items = extra.items.filter((item) => item.actionToken !== selectionToken);
    changed ||= items.length !== extra.items.length;
    remainingResetCredits = items.length;
    return {
      ...extra,
      value: String(items.length),
      items,
    };
  });
  return {
    snapshot: changed ? { ...snapshot, extras } : snapshot,
    remainingResetCredits,
  };
}

export class PolyQuotaApplicationService {
  private revision = 0;
  private readonly operations = new Map<string, PublicOperationState>();
  private readonly pendingResetCreditUses = new Map<string, Set<string>>();
  private readonly pendingReasons = new Set<PolyQuotaChangeReason>();
  private publishQueued = false;
  private scheduler: RefreshScheduler | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly storage: StoragePort,
    private readonly vault: CredentialVault,
    private readonly polling: PollingService,
    private readonly auth: AuthService,
    private readonly options: PolyQuotaApplicationServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  attachScheduler(scheduler: RefreshScheduler): void {
    if (this.scheduler) throw new Error("Refresh scheduler is already attached");
    this.scheduler = scheduler;
  }

  getSettings(): Settings {
    const interval = this.storage.settings.get("pollingIntervalMinutes");
    return {
      pollingEnabled: this.storage.settings.get("pollingEnabled") !== false,
      pollingIntervalMinutes: typeof interval === "number" ? interval : 15,
    };
  }

  async getSnapshot(): Promise<PolyQuotaSnapshot> {
    for (;;) {
      const revision = this.revision;
      const accounts = this.storage.accounts
        .list()
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        );
      const usageByAccountId = Object.fromEntries(
        accounts.map((account) => {
          const snapshot = this.storage.snapshots.get(account.id);
          return [account.id, snapshot ? toPublicUsage(snapshot) : null];
        }),
      );
      const settings = this.getSettings();
      const operations = [...this.operations.values()].sort(
        (left, right) =>
          left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
      );
      const scheduler = this.requireScheduler().getState();
      const publicAccounts = await Promise.all(
        accounts.map((account) => this.toPublicAccount(account)),
      );
      if (revision !== this.revision) continue;
      return {
        schemaVersion: POLYQUOTA_SCHEMA_VERSION,
        revision,
        generatedAt: this.now().toISOString(),
        providers: this.options.providerCatalog.map((descriptor) => ({ ...descriptor })),
        accounts: publicAccounts,
        usageByAccountId,
        operations,
        settings,
        scheduler,
      };
    }
  }

  setAccountEnabled(accountId: string, enabled: boolean): void {
    const account = this.storage.accounts.get(accountId);
    if (!account) throw new AppError("validation", "Account does not exist");
    if (account.enabled === enabled) return;
    this.storage.accounts.setEnabled(accountId, enabled, this.now().toISOString());
    this.commit(["accounts"]);
  }

  deleteAccount(accountId: string): void {
    if (!this.storage.accounts.get(accountId)) {
      throw new AppError("validation", "Account does not exist");
    }
    this.storage.transaction(() => this.storage.accounts.delete(accountId));
    this.pendingResetCreditUses.delete(accountId);
    for (const [id, operation] of this.operations) {
      if (operation.accountId === accountId) this.operations.delete(id);
    }
    this.commit(["accounts", "usage", "operations"]);
  }

  refreshAccount(accountId: string): Promise<RefreshOutcomeDto> {
    return this.runOperation(
      "refresh-account",
      accountId,
      "manual",
      () =>
        this.polling
          .refresh(accountId)
          .then((outcome) => this.reconcilePendingResetCreditUses(outcome))
          .then(toRefreshOutcome),
      ["accounts", "usage"],
    );
  }

  refreshAll(source: RefreshSource = "manual"): Promise<RefreshBatchOutcomeDto> {
    return this.requireScheduler().run(source);
  }

  executeRefreshBatch(source: RefreshSource): Promise<RefreshBatchOutcomeDto> {
    return this.runOperation(
      "refresh-all",
      null,
      source,
      async () => ({
        source,
        outcomes: (await this.polling.refreshAll())
          .map((outcome) => this.reconcilePendingResetCreditUses(outcome))
          .map(toRefreshOutcome),
      }),
      ["accounts", "usage"],
    );
  }

  refreshCredentials(accountId: string): Promise<CredentialRefreshOutcomeDto> {
    return this.runOperation(
      "refresh-credentials",
      accountId,
      "manual",
      () => this.polling.refreshCredentials(accountId).then(toCredentialRefreshOutcome),
      ["accounts"],
    );
  }

  redeemResetCredit(
    accountId: string,
    selectionToken: string,
  ): Promise<RedeemResetCreditOutcomeDto> {
    return this.runOperation(
      "use-reset-credit",
      accountId,
      "manual",
      async () => {
        const account = this.storage.accounts.get(accountId);
        if (!account) throw new AppError("validation", "Account does not exist");
        if (!account.enabled) throw new AppError("permission", "请先启用该账号再使用重置额度");
        const envelope = await this.vault.load(accountId);
        await this.options.redeemResetCredit(account, envelope, selectionToken);
        const pending = this.pendingResetCreditUses.get(accountId) ?? new Set<string>();
        pending.add(selectionToken);
        this.pendingResetCreditUses.set(accountId, pending);
        const refreshed = this.reconcilePendingResetCreditUses(
          await this.polling.refresh(accountId),
        );
        const currentSnapshot =
          refreshed.status === "updated"
            ? refreshed.snapshot
            : this.storage.snapshots.get(accountId);
        const reconciled = currentSnapshot
          ? reconcileRedeemedResetCredit(currentSnapshot, selectionToken)
          : null;
        if (reconciled) this.storage.snapshots.save(reconciled.snapshot);
        return {
          status: "redeemed",
          accountId,
          refreshStatus: refreshed.status,
          remainingResetCredits: reconciled?.remainingResetCredits ?? null,
        };
      },
      ["accounts", "usage"],
    );
  }

  async startAuth(request: StartAuthRequest): Promise<AuthStartResult> {
    const operationId = this.startOperation("auth", null, null);
    try {
      const options = {
        ...("region" in request ? { region: request.region } : {}),
        ...("apiKey" in request ? { apiKey: request.apiKey } : {}),
      };
      const result = await this.auth.start(request.provider, request.method, options);
      this.operations.delete(operationId);
      if (result.status === "completed") {
        const account = await this.toPublicAccount(result.account);
        this.commit(["accounts", "operations"]);
        return { status: "completed", account };
      }
      this.operations.set(result.sessionId, {
        id: result.sessionId,
        kind: "auth",
        status: "waiting-for-user",
        accountId: null,
        source: null,
        startedAt: this.now().toISOString(),
      });
      this.commit(["operations"]);
      return result;
    } catch (error) {
      this.operations.delete(operationId);
      this.commit(["operations"]);
      throw error;
    }
  }

  async finishAuth(sessionId: string): Promise<PublicAccount> {
    const pending = this.operations.get(sessionId);
    if (pending) {
      this.operations.set(sessionId, { ...pending, status: "running" });
      this.commit(["operations"]);
    }
    try {
      const account = await this.auth.finish(sessionId);
      return await this.toPublicAccount(account);
    } finally {
      this.operations.delete(sessionId);
      this.commit(["accounts", "operations"]);
    }
  }

  cancelAuth(sessionId: string): void {
    this.auth.cancel(sessionId);
    if (this.operations.delete(sessionId)) this.commit(["operations"]);
  }

  saveSettings(settings: Settings): void {
    const current = this.getSettings();
    if (
      current.pollingEnabled === settings.pollingEnabled &&
      current.pollingIntervalMinutes === settings.pollingIntervalMinutes
    ) {
      return;
    }
    const timestamp = this.now().toISOString();
    this.storage.transaction(() => {
      this.storage.settings.save("pollingEnabled", settings.pollingEnabled, timestamp);
      this.storage.settings.save(
        "pollingIntervalMinutes",
        settings.pollingIntervalMinutes,
        timestamp,
      );
    });
    this.requireScheduler().configure(settings);
    this.commit(["settings"]);
  }

  async getSystemStatus(): Promise<PublicSystemStatus> {
    return { proxy: await this.options.resolveProxy() };
  }

  schedulerChanged(): void {
    this.commit(["scheduler"]);
  }

  private startOperation(
    kind: PublicOperationKind,
    accountId: string | null,
    source: RefreshSource | null,
  ): string {
    const id = randomUUID();
    this.operations.set(id, {
      id,
      kind,
      status: "running",
      accountId,
      source,
      startedAt: this.now().toISOString(),
    });
    this.commit(["operations"]);
    return id;
  }

  private async runOperation<T>(
    kind: PublicOperationKind,
    accountId: string | null,
    source: RefreshSource | null,
    operation: () => Promise<T>,
    completedReasons: PolyQuotaChangeReason[],
  ): Promise<T> {
    const id = this.startOperation(kind, accountId, source);
    const started = this.now().getTime();
    try {
      const value = await operation();
      console.info("PolyQuota operation completed", {
        operation: kind,
        operationId: id,
        revision: this.revision + 1,
        durationMs: this.now().getTime() - started,
      });
      return value;
    } catch (error) {
      console.warn("PolyQuota operation failed", {
        operation: kind,
        operationId: id,
        revision: this.revision + 1,
        durationMs: this.now().getTime() - started,
        code: error instanceof AppError ? error.code : "internal",
      });
      throw error;
    } finally {
      this.operations.delete(id);
      this.commit([...completedReasons, "operations"]);
    }
  }

  private async toPublicAccount(account: Account): Promise<PublicAccount> {
    try {
      const credentials = await this.vault.load(account.id);
      return toPublicAccount(account, credentials.expiresAt);
    } catch {
      return toPublicAccount(account);
    }
  }

  private commit(reasons: PolyQuotaChangeReason[]): void {
    this.revision += 1;
    for (const reason of reasons) this.pendingReasons.add(reason);
    if (this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      if (!this.pendingReasons.size) return;
      const event: PolyQuotaChangedEvent = {
        schemaVersion: POLYQUOTA_SCHEMA_VERSION,
        revision: this.revision,
        reasons: [...this.pendingReasons],
        occurredAt: this.now().toISOString(),
      };
      this.pendingReasons.clear();
      console.info("PolyQuota state changed", {
        revision: event.revision,
        reasons: event.reasons.join(","),
      });
      this.options.publishChanged(event);
    });
  }

  private requireScheduler(): RefreshScheduler {
    if (!this.scheduler) throw new Error("Refresh scheduler is not attached");
    return this.scheduler;
  }

  private reconcilePendingResetCreditUses(outcome: RefreshOutcome): RefreshOutcome {
    if (outcome.status !== "updated") return outcome;
    const pending = this.pendingResetCreditUses.get(outcome.accountId);
    if (!pending?.size) return outcome;

    let snapshot = outcome.snapshot;
    for (const selectionToken of [...pending]) {
      const stillReported = snapshot.extras.some((extra) =>
        extra.items?.some((item) => item.actionToken === selectionToken),
      );
      if (!stillReported) {
        pending.delete(selectionToken);
        continue;
      }
      snapshot = reconcileRedeemedResetCredit(snapshot, selectionToken).snapshot;
    }
    if (!pending.size) this.pendingResetCreditUses.delete(outcome.accountId);
    if (snapshot === outcome.snapshot) return outcome;
    this.storage.snapshots.save(snapshot);
    return { ...outcome, snapshot };
  }
}

function toRefreshOutcome(outcome: RefreshOutcome): RefreshOutcomeDto {
  if (outcome.status === "updated") {
    return {
      status: "updated",
      accountId: outcome.accountId,
      snapshot: toPublicUsage(outcome.snapshot),
    };
  }
  return outcome;
}

function toCredentialRefreshOutcome(
  outcome: CredentialRefreshOutcome,
): CredentialRefreshOutcomeDto {
  return outcome;
}
