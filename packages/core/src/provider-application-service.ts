import { createHash, randomUUID } from "node:crypto";
import {
  modelEndpointDescriptor,
  modelEndpointDescriptors,
  parseConnectionRequest,
  protocolFamilies,
  type BackendContext,
  type CommandContext,
  type CreateConnectionRequest,
  type EditConnectionRequest,
  type ModelRoute,
  type ModelRouteInput,
  type OfferingRouteConfig,
  type ProviderManagementSnapshot,
  type PublicAccount,
  type PublicAuthSession,
  type PublicConnection,
  type StartAuthRequest,
} from "@astra-conductor/contract/common";
import type { AuthCoordinator } from "./auth/coordinator.js";
import type { CredentialMutationGate } from "./credential-mutation-gate.js";
import type { CredentialService } from "./credential-service.js";
import { AppError } from "./errors.js";
import type { Account, CredentialEnvelope } from "./models.js";
import type { StoragePort } from "./ports.js";
import { isLocalKeyAccount, toPublicProviderDescriptor } from "./providers/catalog.js";
import { compatibleKeyId } from "./providers/compatible-api-key/descriptor.js";
import { isCustomProviderId } from "./providers/model-policy.js";
import {
  accountRoutesSettingKey,
  bindModelRoutes,
  familyRevisionKey,
  resolveModelRoutes,
  routeRevisionKey,
  type ConnectionProviderSource,
} from "./providers/model-routes.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { toPublicAccount } from "./public-api.js";
import { RefreshCoordinator } from "./refresh-coordinator.js";

export interface CommonProviderApplicationOptions {
  storage: StoragePort;
  credentials: CredentialService;
  auth: AuthCoordinator;
  registry: ProviderRegistry;
  connectionProviders?: ConnectionProviderSource;
  allowLegacyConnections?: boolean;
  accountDeleted?(accountId: string): void;
  refresh?: RefreshCoordinator;
  mutations?: CredentialMutationGate;
  instanceId?: string;
  now?: () => Date;
  assertWritable?(): void;
  visibleAccountIds?(): ReadonlySet<string> | null;
  backend?(): BackendContext;
  changed?(): void;
}

export function connectionAccountId(operationId: string): string {
  return "connection-" + createHash("sha256").update(operationId).digest("hex");
}

function defaultProtocolVersion(
  protocol: OfferingRouteConfig["defaults"][number]["protocol"],
  protocolVersion?: string | null,
): string | null {
  if (protocolVersion !== undefined) return protocolVersion;
  return protocol === "anthropic-messages" ? "2023-06-01" : null;
}

function routesMatchConfigDefaults(
  submitted: readonly ModelRouteInput[],
  routeConfig: OfferingRouteConfig,
): boolean {
  if (submitted.length === 0) return true;
  if (submitted.length !== routeConfig.defaults.length) return false;
  return routeConfig.defaults.every((d) => {
    const expectedVersion = defaultProtocolVersion(d.protocol, d.protocolVersion);
    return submitted.some(
      (r) =>
        r.protocol === d.protocol &&
        r.baseUrl === d.baseUrl &&
        (r.protocolVersion ?? null) === expectedVersion &&
        r.chatOutputLimitField === undefined &&
        r.requestRule === undefined,
    );
  });
}

/** Common account management, independent of HTTP and either product's business projections. */
export class CommonProviderApplicationService {
  readonly instanceId: string;
  private revision = 0;
  private readonly contextId = randomUUID();
  private readonly sessions = new Map<string, string>();
  readonly routeSource: ConnectionProviderSource;
  private readonly refresh: RefreshCoordinator;

  constructor(private readonly options: CommonProviderApplicationOptions) {
    this.routeSource = {
      newApiSite: (provider, offering) =>
        options.connectionProviders?.newApiSite?.(provider, offering),
      templateKind: (provider) => options.connectionProviders?.templateKind?.(provider),
      routes: (provider: string, offering: string) =>
        options.connectionProviders?.routes(provider, offering),
      accountRoutes: (
        accountId: string,
        providerId?: string,
        credentialRevision?: string,
      ): ModelRoute[] | undefined => {
        const readStoredRoutes = (key: string): ModelRoute[] | undefined => {
          const raw = options.storage.settings.get(key);
          if (typeof raw !== "string") return undefined;
          try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return undefined;
            return parsed.map((item: Record<string, unknown>) => {
              if (!item || typeof item !== "object") return item as unknown as ModelRoute;
              const { protocolRouteId, protocolFamilyId, ...rest } = item;
              return {
                ...rest,
                ...(!("protocol" in rest) && protocolRouteId !== undefined
                  ? { protocol: protocolRouteId }
                  : {}),
                ...(!("protocolFamily" in rest) && protocolFamilyId !== undefined
                  ? { protocolFamily: protocolFamilyId }
                  : {}),
              } as ModelRoute;
            });
          } catch {
            return undefined;
          }
        };
        return (
          readStoredRoutes(accountRoutesSettingKey(accountId)) ??
          (providerId && credentialRevision
            ? readStoredRoutes(`${providerId}.routes.${credentialRevision}`)
            : undefined)
        );
      },
    };
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

  private get legacyConnections() {
    return this.options.allowLegacyConnections ?? !this.options.connectionProviders;
  }

  private isManagedLocalKeyAccount(
    account: Pick<Account, "provider" | "offeringId" | "authMethod">,
  ) {
    return isLocalKeyAccount(account, (id) => this.options.registry.findOffering(id));
  }

  private resolveAccountPolicy(account: Pick<Account, "provider" | "offeringId">) {
    return (
      this.options.registry.getModelPolicy({
        providerId: account.provider,
        offeringId: account.offeringId,
        templateKind: this.routeSource.templateKind?.(account.provider),
      }) ?? undefined
    );
  }

  private clearAccountRoutes(accountId: string, updatedAt: string): void {
    const key = accountRoutesSettingKey(accountId);
    if (this.options.storage.settings.delete) {
      this.options.storage.settings.delete(key);
    } else if (this.options.storage.settings.get(key) !== null) {
      this.options.storage.settings.save(key, null, updatedAt);
    }
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
    if (
      context.instanceId !== this.instanceId ||
      context.contextId !== this.getBackend().contextId
    ) {
      throw new AppError("stale-context", "账号存储上下文已变更，请重新读取当前页面");
    }
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
      .filter(
        (account) =>
          (visibleAccountIds?.has(account.id) ?? true) &&
          (this.options.connectionProviders || !isCustomProviderId(account.provider)),
      )
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
      modelEndpoints: modelEndpointDescriptors,
      providers: this.options.registry.descriptors
        .filter((d) => d.provider !== compatibleKeyId || this.legacyConnections)
        .map((descriptor) => toPublicProviderDescriptor(descriptor)),
      accounts,
      connections: accounts.map((account) => {
        const stored = this.account(account.id);
        return {
          accountId: account.id,
          providerId: account.provider,
          offeringId: account.offeringId,
          displayName: account.displayName,
          recordRevision: this.connectionRevision(account),
          routes: resolveModelRoutes(
            stored,
            undefined,
            this.routeSource,
            this.resolveAccountPolicy(stored),
          ),
          actions: {
            editConnection:
              account.provider === compatibleKeyId || this.isManagedLocalKeyAccount(account)
                ? writable
                  ? enabled
                  : disabled
                : { state: "hidden" },
            delete: writable ? enabled : disabled,
            refreshCredentials: this.options.registry.getRefreshAccount(account)?.refreshCredentials
              ? mutable
                ? enabled
                : disabled
              : { state: "hidden" },
          },
        };
      }),
      actions: {
        createConnection: writable ? enabled : disabled,
        startAuth: writable ? enabled : disabled,
        deleteAccount: writable ? enabled : disabled,
        setAccountEnabled: mutable ? enabled : disabled,
        refreshCredentials: mutable ? enabled : disabled,
      },
    };
  }

  private account(accountId: string) {
    const account = this.options.storage.accounts.get(accountId);
    if (
      !account ||
      (isCustomProviderId(account.provider) && !this.options.connectionProviders) ||
      this.options.visibleAccountIds?.()?.has(accountId) === false
    ) {
      throw new AppError("not-found", "账号不存在或不可访问");
    }
    return account;
  }

  private connectionRevision(account: Account | PublicAccount): string {
    const credentialRevision = this.options.credentials.recordRevision?.(account.id);
    if (!credentialRevision || !this.isManagedLocalKeyAccount(account)) {
      return credentialRevision ?? account.updatedAt;
    }
    return (
      credentialRevision +
      "." +
      createHash("sha256")
        .update(JSON.stringify([account.displayName, account.offeringId, account.updatedAt]))
        .digest("hex")
    );
  }

  private connection(account: Account, envelope: CredentialEnvelope): PublicConnection {
    return {
      instanceId: this.instanceId,
      contextId: this.getBackend().contextId,
      accountId: account.id,
      providerId: account.provider,
      offeringId: account.offeringId,
      displayName: account.displayName,
      recordRevision: this.connectionRevision(account),
      routes: resolveModelRoutes(
        account,
        envelope,
        this.routeSource,
        this.resolveAccountPolicy(account),
      ),
    };
  }

  async getConnection(accountId: string): Promise<PublicConnection> {
    this.assertActiveBackend();
    const context = { instanceId: this.instanceId, contextId: this.getBackend().contextId };
    this.account(accountId);
    const envelope = await this.options.credentials.load(accountId);
    this.assertContext(context);
    return this.connection(this.account(accountId), envelope);
  }

  createConnection(input: CreateConnectionRequest): Promise<PublicConnection> {
    const request = parseConnectionRequest(input, "create");
    const baseline = { instanceId: this.instanceId, contextId: this.getBackend().contextId };
    const id = connectionAccountId(request.operationId);
    return this.refresh.runAccountOperation(id, async () => {
      this.assertContext(baseline);
      this.writable();
      // The operation's id is committed with the account, including in the shared broker.
      if (!this.legacyConnections && !request.providerId) {
        throw new AppError("validation", "请创建自定义供应商并选择接入点，或选择官方 API");
      }
      const provider = request.providerId ?? compatibleKeyId;
      const offeringId = request.offeringId ?? compatibleKeyId;
      if (request.providerId) {
        const knownCustom =
          isCustomProviderId(provider) &&
          Boolean(this.options.connectionProviders?.routes(provider, offeringId));
        const knownOffering = this.options.registry.findOffering(offeringId);
        const knownScopedApiKey = Boolean(
          knownOffering &&
            knownOffering.provider === provider &&
            knownOffering.offering.supportsSubscriptionUsage === false &&
            knownOffering.offering.routeConfig !== undefined &&
            knownOffering.offering.authMethods.some((m) => m.method === "api-key"),
        );
        if (!knownCustom && !knownScopedApiKey) {
          throw new AppError("validation", "所选供应商接入点不存在");
        }
        const routeConfig = knownOffering?.offering.routeConfig;
        if (routeConfig?.mode === "editable") {
          for (const route of request.routes) {
            if (!routeConfig.allowedProtocols.includes(route.protocol)) {
              throw new AppError("validation", `所选协议不受当前接入点支持：${route.protocol}`);
            }
          }
        } else if (request.routes.length) {
          throw new AppError("validation", "账号不能覆盖供应商的目的地");
        }
      }
      const existing = this.options.storage.accounts.get(id);
      if (existing) {
        if (existing.provider !== provider || existing.offeringId !== offeringId) {
          throw new AppError("conflict", "创建操作已用于另一接入点");
        }
        return this.getConnection(id);
      }
      const now = (this.options.now?.() ?? new Date()).toISOString();
      const account: Account = {
        id,
        provider,
        offeringId,
        authMethod: "api-key",
        displayName: request.displayName,
        stableIdentity: id,
        maskedIdentifier: request.accountIdentifier ?? "API Key ••••",
        publicMetadata: {},
        enabled: true,
        credentialState: "available",
        createdAt: now,
        updatedAt: now,
      };
      return this.saveConnection(account, request);
    });
  }

  editConnection(accountId: string, input: EditConnectionRequest): Promise<PublicConnection> {
    const request = parseConnectionRequest(input, "edit");
    const baseline = { instanceId: this.instanceId, contextId: this.getBackend().contextId };
    return this.refresh.runAccountOperation(accountId, async () => {
      this.assertContext(baseline);
      this.writable();
      const account = this.account(accountId);
      if (!this.legacyConnections && account.provider === compatibleKeyId) {
        throw new AppError("validation", "请配置本地供应商并重新绑定账号");
      }
      if (
        request.providerId &&
        (account.provider !== request.providerId || account.offeringId !== request.offeringId)
      ) {
        throw new AppError("conflict", "账号接入点已变更");
      }
      if (account.provider !== compatibleKeyId && !this.isManagedLocalKeyAccount(account)) {
        throw new AppError("capability-unavailable", "订阅账号使用供应商固定的协议绑定");
      }
      if (this.connectionRevision(account) !== request.expectedRecordRevision) {
        throw new AppError("conflict", "连接已变更，请重新读取后编辑");
      }
      const expectedCredentialRevision =
        this.options.credentials.recordRevision?.(accountId) ?? request.expectedRecordRevision;
      const previous = await (this.options.credentials.loadCurrent?.(accountId) ??
        this.options.credentials.load(accountId));
      this.assertContext(baseline);
      if (this.connectionRevision(this.account(accountId)) !== request.expectedRecordRevision) {
        throw new AppError("conflict", "读取期间连接已变更");
      }
      return this.saveConnection(account, request, previous, expectedCredentialRevision);
    });
  }

  private async saveConnection(
    account: Account,
    request: CreateConnectionRequest | EditConnectionRequest,
    previous?: CredentialEnvelope,
    expectedCredentialRevision = "new",
  ) {
    const apiKey = request.apiKey ?? previous?.secrets.apiKey;
    if (
      !apiKey ||
      request.displayName.includes(apiKey) ||
      account.maskedIdentifier.includes(apiKey) ||
      (previous?.secrets.apiKey && request.displayName.includes(previous.secrets.apiKey))
    ) {
      throw new AppError("validation", "请检查名称及 API Key，名称不能包含密钥");
    }

    const local = this.isManagedLocalKeyAccount(account);
    const policy = this.resolveAccountPolicy(account);
    const offeringEntry = this.options.registry.findOffering(account.offeringId);
    const routeConfig = policy?.routeConfig ?? offeringEntry?.offering.routeConfig;
    const editableScoped = local && routeConfig?.mode === "editable";

    if (local && !editableScoped && request.routes.length) {
      throw new AppError("validation", "账号不能覆盖供应商的目的地");
    }
    if (editableScoped && routeConfig) {
      for (const route of request.routes) {
        if (!routeConfig.allowedProtocols.includes(route.protocol)) {
          throw new AppError("validation", `所选协议不受当前接入点支持：${route.protocol}`);
        }
      }
    }

    const modelRoutes = local ? [] : bindModelRoutes(request.routes, apiKey, previous);
    const priorRevision = previous?.credentialBindingRevision;
    const previousRoutes = editableScoped
      ? this.routeSource.accountRoutes?.(account.id)
      : undefined;
    const matchesDefaults =
      editableScoped && routeConfig ? routesMatchConfigDefaults(request.routes, routeConfig) : true;
    const localRoutes =
      editableScoped && !matchesDefaults && request.routes.length
        ? bindModelRoutes(
            request.routes,
            apiKey,
            previous ? { ...previous, modelRoutes: previousRoutes } : undefined,
          )
        : undefined;
    const hadDefault = Boolean(
      priorRevision &&
        (priorRevision.startsWith("default-") || priorRevision.startsWith("official-")),
    );
    const sameRoutes = editableScoped
      ? localRoutes
        ? JSON.stringify(previousRoutes) === JSON.stringify(localRoutes)
        : hadDefault && previousRoutes === undefined
      : true;
    const keyRevision = local
      ? previous?.secrets.apiKey === apiKey && sameRoutes
        ? previous.credentialBindingRevision
        : (editableScoped && !localRoutes ? "default-" : "") + randomUUID()
      : undefined;
    if (local && !keyRevision) throw new AppError("stale-binding", "凭据绑定修订缺失");

    const envelope: CredentialEnvelope = {
      version: 1,
      accountId: account.id,
      provider: account.provider,
      authMethod: "api-key",
      expiresAt: null,
      secrets: { apiKey },
      ...(local ? { credentialBindingRevision: keyRevision } : { modelRoutes }),
    };

    const metadata = { ...account.publicMetadata, supportsUsage: false, supportsInference: true };
    if (!local) {
      const prior =
        previous && resolveModelRoutes(account, previous, this.options.connectionProviders, policy);
      for (const family of protocolFamilies) {
        const field = familyRevisionKey(family);
        const route = modelRoutes.find(
          (r) => modelEndpointDescriptor(r.protocol).protocolFamily === family,
        );
        if (!route) {
          delete (metadata as Account["publicMetadata"])[field];
          continue;
        }
        const same =
          previous?.secrets.apiKey === apiKey &&
          prior?.find(
            (r) =>
              r.protocolFamily === family &&
              r.baseUrl === route.baseUrl &&
              r.protocolVersion === route.protocolVersion,
          );
        (metadata as Account["publicMetadata"])[field] =
          (same && same.familyBindingRevision) || randomUUID();
      }
    }
    for (const route of previous?.modelRoutes ?? []) {
      delete (metadata as Account["publicMetadata"])[routeRevisionKey(route.protocol)];
    }

    const stamp = Math.max(
      (this.options.now?.() ?? new Date()).getTime(),
      Date.parse(account.updatedAt) + 1,
    );
    const updatedAt = new Date(stamp).toISOString();
    const { credentialProjection: _observation, ...localAccount } = account;
    const updated = {
      ...localAccount,
      displayName: request.displayName,
      updatedAt,
      publicMetadata: {
        ...metadata,
        ...(keyRevision ? { credentialBindingRevision: keyRevision } : {}),
        ...Object.fromEntries(
          modelRoutes.map((route) => [routeRevisionKey(route.protocol), route.bindingRevision]),
        ),
      },
    };

    if (local) {
      const previewSource: ConnectionProviderSource = {
        ...this.routeSource,
        accountRoutes: (id) =>
          id === account.id ? localRoutes : this.routeSource.accountRoutes?.(id),
      };
      resolveModelRoutes(updated, envelope, previewSource, policy);
    }

    if (editableScoped) {
      if (localRoutes) {
        this.options.storage.settings.save(
          accountRoutesSettingKey(account.id),
          JSON.stringify(localRoutes),
          updatedAt,
        );
      } else {
        this.clearAccountRoutes(account.id, updatedAt);
      }
    }

    if (local && previous && previous.credentialBindingRevision === keyRevision) {
      this.options.storage.accounts.save(updated);
      this.changed();
      return this.connection(updated, envelope);
    }
    await this.options.credentials.saveAccount(updated, envelope, expectedCredentialRevision);
    this.changed();
    return this.connection(updated, envelope);
  }

  private writable(): void {
    this.options.assertWritable?.();
    this.assertActiveBackend();
    if (this.getBackend().active === "shared" && !this.options.credentials.removeShared) {
      throw new AppError("capability-unavailable", "当前凭据后端不提供账号写入能力");
    }
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
    if (this.sessions.get(sessionId) !== this.getBackend().contextId) {
      throw new AppError("stale-context", "授权会话属于旧的凭据存储上下文");
    }
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
        if (
          expectedRecordRevision !== undefined &&
          this.connectionRevision(account) !== expectedRecordRevision
        ) {
          throw new AppError("conflict", "账号记录已变更，请重新读取后确认删除");
        }
        await this.options.credentials.removeShared!(
          accountId,
          this.options.credentials.recordRevision?.(accountId) ?? expectedRecordRevision,
        );
      } else if (
        expectedRecordRevision !== undefined &&
        expectedRecordRevision !== account.updatedAt
      ) {
        throw new AppError("conflict", "账号记录已变更，请重新读取后确认删除");
      }
      const deletedAt = (this.options.now?.() ?? new Date()).toISOString();
      this.options.storage.transaction(() => {
        this.options.storage.accounts.delete(accountId);
        this.clearAccountRoutes(accountId, deletedAt);
        this.options.accountDeleted?.(accountId);
      });
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
    if (active !== "private" && active !== "shared") {
      throw new AppError("service-unavailable", "当前凭据后端不可用，请先恢复连接", true);
    }
  }
}
