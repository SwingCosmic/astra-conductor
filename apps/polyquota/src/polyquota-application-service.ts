import { randomUUID } from "node:crypto";
import {
  POLYQUOTA_SCHEMA_VERSION,
  type AuthStartResult,
  type CredentialRefreshOutcomeDto,
  type PolyQuotaChangedEvent,
  type PolyQuotaChangeReason,
  type PolyQuotaSnapshot,
  type PublicAccount,
  type PublicCompositeRemaining,
  type PublicOperationKind,
  type PublicOperationState,
  type PublicSystemStatus,
  type PublicUsage,
  type RedeemResetCreditOutcomeDto,
  type RefreshBatchOutcomeDto,
  type RefreshOutcomeDto,
  type ResetCreditRedemption,
  type Settings,
  type StartAuthRequest,
} from "@astra-conductor/polyquota-contract";
import {
  AppError,
  CredentialVault,
  computeCompositeRemaining,
  toPublicAccount,
  toPublicUsage,
  type Account,
  type AuthCoordinator,
  type CredentialEnvelope,
  type CredentialRefreshOutcome,
  type ProviderRegistry,
  type RefreshOutcome,
  type StoragePort,
  type UsageSnapshot,
} from "@astra-conductor/core/internal";
import type { PollingService } from "./polling-service.js";
import type { RefreshScheduler, RefreshSource } from "./refresh-scheduler.js";

export interface PolyQuotaApplicationServiceOptions {
  publishChanged: (event: PolyQuotaChangedEvent) => void;
  detectProxyStatus: () => Promise<PublicSystemStatus>;
  /** 唯一的供应商注册表：目录投影、认证与重置额度分派全部经它解析。 */
  registry: ProviderRegistry;
  now?: () => Date;
}

/**
 * 分体形态的对账：已消耗的 itemId 在上游仍报告时从下一快照本地移除；
 * 聚合计数以服务端刷新为准，不做本地扣减（§9.3）。
 */
function reconcileRedeemedResetItems(
  snapshot: UsageSnapshot,
  redeemedIds: ReadonlySet<string>,
): { snapshot: UsageSnapshot; remainingResetCredits: number | null } {
  const credits = snapshot.resetCredits;
  if (!credits || credits.kind !== "itemized") {
    return { snapshot, remainingResetCredits: null };
  }
  const items = credits.items.filter((item) => !redeemedIds.has(item.id));
  return {
    snapshot:
      items.length === credits.items.length
        ? snapshot
        : { ...snapshot, resetCredits: { kind: "itemized", items } },
    remainingResetCredits: items.length,
  };
}

export class PolyQuotaApplicationService {
  private revision = 0;
  private readonly operations = new Map<string, PublicOperationState>();
  private readonly pendingResetCreditUses = new Map<string, Set<string>>();
  private readonly pendingReasons = new Set<PolyQuotaChangeReason>();
  private readonly legacySnapshotRefreshes = new Set<string>();
  private publishQueued = false;
  private scheduler: RefreshScheduler | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly storage: StoragePort,
    private readonly vault: CredentialVault,
    private readonly polling: PollingService,
    private readonly auth: AuthCoordinator,
    private readonly options: PolyQuotaApplicationServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  attachScheduler(scheduler: RefreshScheduler): void {
    if (this.scheduler) throw new Error("Refresh scheduler is already attached");
    this.scheduler = scheduler;
  }

  dispose(): void {
    return;
  }

  getSettings(): Settings {
    const interval = this.storage.settings.get("pollingIntervalMinutes");
    return {
      pollingEnabled: this.storage.settings.get("pollingEnabled") !== false,
      pollingIntervalMinutes: typeof interval === "number" ? interval : 15,
      taskbarProgressEnabled: this.storage.settings.get("taskbarProgressEnabled") !== false,
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
          if (snapshot) this.refreshLegacySnapshot(account.id, snapshot);
          return [account.id, snapshot ? toPublicUsage(snapshot, account.offeringId) : null];
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
      // 套餐解析点上移：目录匹配只在这里经 core 的唯一实现完成，解析结果
      // （planId / planLabel）随快照固化下发；match 键是 core 内部数据层
      // 标识，不再进公开目录。正确性由 TS 类型与契约测试保证，不做运行期自检。
      const snapshot: PolyQuotaSnapshot = {
        schemaVersion: POLYQUOTA_SCHEMA_VERSION,
        revision,
        generatedAt: this.now().toISOString(),
        providers: this.options.registry.descriptors.map((descriptor) => ({
          provider: descriptor.provider,
          displayName: descriptor.displayName,
          offerings: descriptor.offerings.map((offering) => ({
            id: offering.id,
            provider: offering.provider,
            displayName: offering.displayName,
            ...(offering.description ? { description: offering.description } : {}),
            ...(offering.websiteUrl ? { websiteUrl: offering.websiteUrl } : {}),
            ...(offering.iconKey ? { iconKey: offering.iconKey } : {}),
            authMethods: offering.authMethods.map((method) => ({
              method: method.method,
              interaction: method.interaction,
              ...(method.sourceLabel ? { sourceLabel: method.sourceLabel } : {}),
              ...(method.sourcePathHint ? { sourcePathHint: method.sourcePathHint } : {}),
            })),
            plans: offering.plans.map((plan) => ({
              id: plan.id,
              displayName: plan.displayName,
            })),
          })),
        })),
        accounts: publicAccounts,
        usageByAccountId,
        compositeRemaining: this.compositeRemaining(publicAccounts, usageByAccountId),
        operations,
        settings,
        scheduler,
      };
      return snapshot;
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
    this.legacySnapshotRefreshes.delete(accountId);
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
          .then((outcome) => toRefreshOutcome(outcome, this.offeringIdOf(accountId))),
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
          .map((outcome) => toRefreshOutcome(outcome, this.offeringIdOf(outcome.accountId))),
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
    redemption: ResetCreditRedemption,
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
        const usage = this.options.registry.requireUsage(account.provider);
        if (!usage.redeemResetCard) {
          throw new AppError("validation", "该服务商的重置额度使用协议尚未接入");
        }
        // 消耗请求与快照形态的一致性、聚合 type 与分体 itemId 的有效性由实现校验。
        await usage.redeemResetCard(account, envelope, redemption);
        if (redemption.kind === "item") {
          const pending = this.pendingResetCreditUses.get(accountId) ?? new Set<string>();
          pending.add(redemption.itemId);
          this.pendingResetCreditUses.set(accountId, pending);
        }
        const refreshed = this.reconcilePendingResetCreditUses(
          await this.polling.refresh(accountId),
        );
        let remainingResetCredits: number | null = null;
        if (redemption.kind === "item") {
          const currentSnapshot =
            refreshed.status === "updated"
              ? refreshed.snapshot
              : this.storage.snapshots.get(accountId);
          const reconciled = currentSnapshot
            ? reconcileRedeemedResetItems(
                currentSnapshot,
                this.pendingResetCreditUses.get(accountId) ?? new Set<string>(),
              )
            : null;
          if (reconciled && reconciled.snapshot !== currentSnapshot) {
            this.storage.snapshots.save(reconciled.snapshot);
          }
          remainingResetCredits = reconciled?.remainingResetCredits ?? null;
        }
        return {
          status: "redeemed",
          accountId,
          refreshStatus: refreshed.status,
          remainingResetCredits,
        };
      },
      ["accounts", "usage"],
    );
  }

  async startAuth(request: StartAuthRequest): Promise<AuthStartResult> {
    const operationId = this.startOperation("auth", null, null);
    try {
      const options = request.apiKey === undefined ? {} : { apiKey: request.apiKey };
      const result = await this.auth.start(request.offeringId, request.method, options);
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
      current.pollingIntervalMinutes === settings.pollingIntervalMinutes &&
      current.taskbarProgressEnabled === settings.taskbarProgressEnabled
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
      this.storage.settings.save(
        "taskbarProgressEnabled",
        settings.taskbarProgressEnabled,
        timestamp,
      );
    });
    this.requireScheduler().configure(settings);
    this.commit(["settings"]);
  }

  async getSystemStatus(): Promise<PublicSystemStatus> {
    return this.options.detectProxyStatus();
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

  /** 刷新结果里的快照同样要在主进程完成套餐解析；账号已删除时查表自然落空。 */
  private offeringIdOf(accountId: string): string | null {
    return this.storage.accounts.get(accountId)?.offeringId ?? null;
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

  private compositeRemaining(
    accounts: readonly PublicAccount[],
    usageByAccountId: Record<string, PublicUsage | null>,
  ): PublicCompositeRemaining {
    return computeCompositeRemaining(
      accounts.map((account) => ({
        enabled: account.enabled,
        provider: account.provider,
        offeringId: account.offeringId,
        snapshot: usageByAccountId[account.id] ?? null,
      })),
    );
  }

  private requireScheduler(): RefreshScheduler {
    if (!this.scheduler) throw new Error("Refresh scheduler is not attached");
    return this.scheduler;
  }

  /**
   * 破坏性结构更新：resetCredits 已是一等必填字段，旧结构快照（extras 形态、
   * 缺该字段）不做投影适配——读到即静默触发一次该账号的刷新换取新数据。
   * 每账号每进程只触发一次，失败也不重试（停用账号刷新会被跳过，同理不重试）。
   */
  private refreshLegacySnapshot(accountId: string, snapshot: UsageSnapshot): void {
    if ("resetCredits" in snapshot) return;
    if (this.legacySnapshotRefreshes.has(accountId)) return;
    this.legacySnapshotRefreshes.add(accountId);
    void this.polling
      .refresh(accountId)
      .then((outcome) => this.reconcilePendingResetCreditUses(outcome))
      .then((outcome) => {
        if (outcome.status !== "skipped") this.commit(["accounts", "usage"]);
      })
      .catch(() => undefined);
  }

  private reconcilePendingResetCreditUses(outcome: RefreshOutcome): RefreshOutcome {
    if (outcome.status !== "updated") return outcome;
    const pending = this.pendingResetCreditUses.get(outcome.accountId);
    if (!pending?.size) return outcome;
    const credits = outcome.snapshot.resetCredits;
    if (!credits || credits.kind !== "itemized") return outcome;

    for (const itemId of [...pending]) {
      if (!credits.items.some((item) => item.id === itemId)) {
        pending.delete(itemId);
      }
    }
    if (!pending.size) {
      this.pendingResetCreditUses.delete(outcome.accountId);
      return outcome;
    }
    const reconciled = reconcileRedeemedResetItems(outcome.snapshot, pending);
    if (reconciled.snapshot === outcome.snapshot) return outcome;
    this.storage.snapshots.save(reconciled.snapshot);
    return { ...outcome, snapshot: reconciled.snapshot };
  }
}

function toRefreshOutcome(outcome: RefreshOutcome, offeringId: string | null): RefreshOutcomeDto {
  if (outcome.status === "updated") {
    return {
      status: "updated",
      accountId: outcome.accountId,
      snapshot: toPublicUsage(outcome.snapshot, offeringId ?? ""),
    };
  }
  return outcome;
}

function toCredentialRefreshOutcome(
  outcome: CredentialRefreshOutcome,
): CredentialRefreshOutcomeDto {
  return outcome;
}
