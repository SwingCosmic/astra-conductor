import { randomUUID } from "node:crypto";
import type {
  BackendContext,
  CommandContext,
  ProviderManagementSnapshot,
  PublicAccount,
  PublicAuthSession,
  StartAuthRequest,
} from "@astra-conductor/contract/common";
import type { AuthCoordinator } from "./auth/coordinator.js";
import type { CredentialService } from "./credential-service.js";
import type { CredentialMutationGate } from "./credential-mutation-gate.js";
import { AppError } from "./errors.js";
import type { StoragePort } from "./ports.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { toPublicAccount } from "./public-api.js";
import { RefreshCoordinator } from "./refresh-coordinator.js";

export interface CommonProviderApplicationOptions {
  storage: StoragePort;
  credentials: CredentialService;
  auth: AuthCoordinator;
  registry: ProviderRegistry;
  refresh?: RefreshCoordinator;
  mutations?: CredentialMutationGate;
  instanceId?: string;
  now?: () => Date;
  assertWritable?(): void;
  visibleAccountIds?(): ReadonlySet<string> | null;
  backend?(): BackendContext;
  changed?(): void;
}

/** Common account management, independent of HTTP and either product's business projections. */
export class CommonProviderApplicationService {
  readonly instanceId: string;
  private revision = 0;
  private readonly contextId = randomUUID();
  private readonly sessions = new Map<string, string>();
  private readonly refresh: RefreshCoordinator;

  constructor(private readonly options: CommonProviderApplicationOptions) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.refresh =
      options.refresh ??
      new RefreshCoordinator(
        options.storage,
        options.credentials,
        options.registry,
        undefined,
        undefined,
        options.mutations,
      );
  }

  getRevision(): number {
    return this.revision;
  }

  changed(): void {
    this.revision += 1;
    this.options.changed?.();
  }

  getBackend(): BackendContext {
    return (
      this.options.backend?.() ?? {
        contextId: this.contextId,
        selected: "private",
        active: "private",
      }
    );
  }

  assertContext(context: CommandContext): void {
    if (context.instanceId !== this.instanceId || context.contextId !== this.getBackend().contextId)
      throw new AppError("stale-context", "账号存储上下文已变更，请重新读取当前页面");
  }

  async getSnapshot(): Promise<ProviderManagementSnapshot> {
    const backend = this.getBackend();
    let mutationAvailable = true;
    try {
      this.options.mutations?.assertAvailable();
    } catch {
      mutationAvailable = false;
    }
    const mutable =
      mutationAvailable && (backend.active === "private" || backend.active === "shared");
    let writable =
      mutable && (backend.active === "private" || !!this.options.credentials.removeShared);
    try {
      this.options.assertWritable?.();
    } catch {
      writable = false;
    }
    const disabled = { state: "disabled" as const, reason: "当前凭据后端不支持此操作" };
    const enabled = { state: "enabled" as const };
    const visibleAccountIds = this.options.visibleAccountIds?.();
    const accounts = this.options.storage.accounts
      .list()
      .filter((account) => visibleAccountIds?.has(account.id) ?? true)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      // Management listings never decrypt credential payloads just to fill display fields.
      .map((account) => toPublicAccount(account));
    return {
      schemaVersion: 1,
      instanceId: this.instanceId,
      revision: this.revision,
      generatedAt: (this.options.now?.() ?? new Date()).toISOString(),
      stamp: { instanceId: this.instanceId, scope: "providers", revision: this.revision },
      backend,
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
          plans: offering.plans.map(({ id, displayName }) => ({ id, displayName })),
        })),
      })),
      accounts,
      connections: accounts.map((account) => ({
        accountId: account.id,
        providerId: account.provider,
        offeringId: account.offeringId,
        displayName: account.displayName,
        recordRevision: this.options.credentials.recordRevision?.(account.id) ?? account.updatedAt,
        routes: null,
        actions: {
          delete: writable ? enabled : disabled,
          refreshCredentials: this.options.registry.getAccount(account.provider)?.refreshCredentials
            ? mutable
              ? enabled
              : disabled
            : { state: "hidden" },
        },
      })),
      actions: {
        startAuth: writable ? enabled : disabled,
        deleteAccount: writable ? enabled : disabled,
        setAccountEnabled: mutable ? enabled : disabled,
        refreshCredentials: mutable ? enabled : disabled,
      },
    };
  }

  private account(accountId: string) {
    const account = this.options.storage.accounts.get(accountId);
    if (!account || this.options.visibleAccountIds?.()?.has(accountId) === false)
      throw new AppError("not-found", "账号不存在或不可访问");
    return account;
  }

  private writable(): void {
    this.options.assertWritable?.();
    this.assertActiveBackend();
    if (this.getBackend().active === "shared" && !this.options.credentials.removeShared)
      throw new AppError("capability-unavailable", "当前凭据后端不提供账号写入能力");
    this.options.mutations?.assertAvailable();
  }

  async getAuthSession(sessionId: string): Promise<PublicAuthSession> {
    const { account, ...state } = this.options.auth.getSession(sessionId);
    return { ...state, ...(account ? { account: toPublicAccount(account) } : {}) };
  }

  async startAuth(request: StartAuthRequest) {
    this.writable();
    const contextId = this.getBackend().contextId;
    const result = await this.options.auth.start(
      request.offeringId,
      request.method,
      request.apiKey === undefined ? {} : { apiKey: request.apiKey },
    );
    if (result.status === "pending") this.sessions.set(result.sessionId, contextId);
    this.changed();
    return result.status === "completed"
      ? { ...result, account: toPublicAccount(result.account) }
      : result;
  }

  async finishAuth(sessionId: string): Promise<PublicAccount> {
    this.writable();
    this.assertSession(sessionId);
    try {
      return toPublicAccount(await this.options.auth.finish(sessionId));
    } finally {
      this.changed();
    }
  }

  cancelAuth(sessionId: string): void {
    this.assertSession(sessionId);
    this.options.auth.cancel(sessionId);
    this.changed();
  }

  private assertSession(sessionId: string): void {
    if (this.sessions.get(sessionId) !== this.getBackend().contextId)
      throw new AppError("stale-context", "授权会话属于旧的凭据存储上下文");
  }

  setAccountEnabled(accountId: string, enabled: boolean): Promise<void> {
    const baseline = { instanceId: this.instanceId, contextId: this.getBackend().contextId };
    return this.refresh.runAccountOperation(accountId, () => {
      this.assertContext(baseline);
      this.assertActiveBackend();
      this.options.mutations?.assertAvailable();
      const account = this.account(accountId);
      if (account.enabled === enabled) return;
      this.options.storage.accounts.setEnabled(
        account.id,
        enabled,
        (this.options.now?.() ?? new Date()).toISOString(),
      );
      this.changed();
    });
  }

  deleteAccount(accountId: string, expectedRecordRevision?: string): Promise<void> {
    const baseline = { instanceId: this.instanceId, contextId: this.getBackend().contextId };
    return this.refresh.runAccountOperation(accountId, async () => {
      this.assertContext(baseline);
      this.writable();
      const account = this.account(accountId);
      if (this.getBackend().active === "shared") {
        await this.options.credentials.removeShared!(accountId, expectedRecordRevision);
      } else if (
        expectedRecordRevision !== undefined &&
        expectedRecordRevision !== account.updatedAt
      ) {
        throw new AppError("conflict", "账号记录已变更，请重新读取后确认删除");
      }
      this.options.storage.transaction(() => this.options.storage.accounts.delete(accountId));
      this.changed();
    });
  }

  async refreshCredentials(accountId: string) {
    this.assertActiveBackend();
    this.account(accountId);
    try {
      return await this.refresh.refreshCredentials(accountId);
    } finally {
      this.changed();
    }
  }

  private assertActiveBackend(): void {
    const active = this.getBackend().active;
    if (active !== "private" && active !== "shared")
      throw new AppError("service-unavailable", "当前凭据后端不可用，请先恢复连接", true);
  }
}
