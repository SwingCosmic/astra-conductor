import { createHash, randomUUID } from "node:crypto";
import {
  familyVersion,
  modelEndpointDescriptor,
  modelEndpointDescriptors,
  protocolFamilyDescriptors,
  type EndpointProtocol,
  type ModelEndpointDescriptor,
  type ModelRoute,
  type ModelRouteSummary,
  type ModelSelection,
  type ActionAvailability,
  type CommandContext,
  type ModelEntryView,
  type ModelCatalogView,
  type GraphModelSnapshot,
  type GraphModelChangeReason,
  type PublicError,
  type SaveModelDraftRequest,
  type ChangeModelPackRequest,
  type EditManualModelRequest,
  type SelectPresetRequest,
  type EditModelOverrideRequest,
  type RefreshCatalogRequest,
  type RouteBindingRequest,
  type SaveModelSelectionRequest,
  type EstimateModelCostRequest,
  type PreviewModelRequest,
  type ModelRequestPreview,
  type TestChatRequest,
} from "@astra-conductor/contract/graph-agent";
import {
  AppError,
  compileModelRequestPlan,
  computeFamilyBindingRevision,
  computeRouteBindingRevision,
  defaultRoutesFromConfig,
  discoverRouteModels,
  isCustomProviderId,
  isLocalKeyAccount,
  previewModelChat,
  projectDiscoveredModels,
  projectNewApiFamilyModels,
  resolveModelRoutes,
  toPublicError,
  estimateCharge,
  parseRateCard,
  parseBillingWorkload,
  type CatalogModelHint,
  type ProviderOfferingModelPolicy,
  type ProviderRegistry,
  type RequestPlan,
  type Account,
  type CommonProviderApplicationService,
  type CredentialEnvelope,
  type CredentialMutationGate,
  type CredentialService,
  type HttpPort,
  type RefreshCoordinator,
  type SelectedBusinessStorage,
  type ConnectionProviderSource,
} from "@astra-conductor/core/internal";
import {
  GraphModelRepository,
  settingsConflict,
  type ConfigKey,
  type CatalogKey,
  type ConfigRow,
  type ModelState,
  type ModelConfigDocument,
} from "./model-repository.js";
import { validateModelPack, fetchPack, type ValidatedPack } from "./model-pack.js";
import {
  projectEntry,
  extractEntryFacts,
  basicCardRows,
  validateParameters,
  priceKey,
  priceUnit,
  isPublicOffering,
  scopeKey,
  enabled,
  disabled,
} from "./model-resolution.js";

interface Options {
  repository: GraphModelRepository;
  storage: SelectedBusinessStorage;
  providers: CommonProviderApplicationService;
  credentials: CredentialService;
  refresh: RefreshCoordinator;
  http: HttpPort;
  registry: ProviderRegistry;
  mutations: CredentialMutationGate;
  connectionProviders?: ConnectionProviderSource;
  visibilityRef(): string;
  visible(): ReadonlySet<string> | null;
  publish(reason: GraphModelChangeReason): void;
}
function endpoint(protocol: EndpointProtocol) {
  const item = modelEndpointDescriptors.find((ep) => ep.protocol === protocol);
  if (!item) throw new AppError("validation", "未注册的模型端点");
  return item;
}
function assertCompatible(
  ep: ModelEndpointDescriptor,
  input: { modelType?: string; operation?: string; ioProfile?: string },
) {
  if (
    (input.modelType !== undefined && input.modelType !== ep.modelType) ||
    (input.operation !== undefined && input.operation !== ep.operation) ||
    (input.ioProfile !== undefined && input.ioProfile !== ep.ioProfile)
  )
    throw new AppError("validation", "模型类型、操作和输入输出组合必须匹配所选端点");
}
function available(action: ActionAvailability) {
  if (action.state !== "enabled")
    throw new AppError(
      "capability-unavailable",
      action.state === "disabled" ? action.reason : "当前操作不可用",
    );
}
function identity(account: Account) {
  return createHash("sha256")
    .update(JSON.stringify([account.provider, account.stableIdentity, account.id]))
    .digest("hex");
}
function selection(row: ConfigRow): ModelSelection {
  return {
    providerId: row.providerId,
    accountId: row.accountId!,
    protocol: row.protocol,
    modelId: row.modelId,
  };
}
export class GraphModelService {
  private revision = 0;
  private readonly observers = new Set<(stopping?: boolean) => void>();
  private readonly tasks = new Map<
    string,
    { check: () => void; stop: AbortController; done: Promise<void> }
  >();
  private readonly failures = new Map<string, PublicError>();
  constructor(private readonly options: Options) {}
  private get repo() {
    return this.options.repository;
  }
  getRevision() {
    return this.revision;
  }
  changed(reason: GraphModelChangeReason) {
    this.revision++;
    for (const fn of this.observers) fn();
    this.options.publish(reason);
  }
  bindingsChanged() {
    for (const task of this.tasks.values()) {
      try {
        task.check();
      } catch {
        task.stop.abort();
      }
    }
    this.changed("bindings");
  }
  watchCall(check: () => void, onStale: (err: AppError) => void) {
    const observer = (stopping = false) => {
      try {
        if (stopping) throw new AppError("service-unavailable", "服务正在停止");
        check();
      } catch (e) {
        onStale(e instanceof AppError ? e : new AppError("conflict", "模型绑定已失效"));
      }
    };
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }
  async stop() {
    for (const observer of this.observers) observer(true);
    for (const task of this.tasks.values()) task.stop.abort();
    await Promise.allSettled([...this.tasks.values()].map((t) => t.done));
  }
  private access(account: Account): ActionAvailability {
    const backend = this.options.providers.getBackend();
    if (backend.active !== "private" && backend.active !== "shared")
      return disabled("请连接凭据存储");
    if (!account.enabled) return disabled("账号已停用");
    if (account.credentialState !== "available") return disabled("账号凭据暂不可用");
    if (this.options.mutations.isFrozen) return disabled("凭据存储正在切换");
    return enabled;
  }
  private visibleAccount(input: CommandContext & { accountId: string }) {
    this.options.providers.assertContext(input);
    const account = this.options.storage.accounts.get(input.accountId);
    if (!account || this.options.visible()?.has(account.id) === false)
      throw new AppError("not-found", "账号不存在或不可访问");
    available(this.access(account));
    return account;
  }
  private resolvePolicy(providerId: string, offeringId: string): ProviderOfferingModelPolicy {
    return this.options.registry.resolveModelPolicy({
      providerId,
      offeringId,
      templateKind: this.options.connectionProviders?.templateKind?.(providerId),
    });
  }
  private getPolicy(providerId: string, offeringId: string): ProviderOfferingModelPolicy | null {
    return this.options.registry.getModelPolicy({
      providerId,
      offeringId,
      templateKind: this.options.connectionProviders?.templateKind?.(providerId),
    });
  }
  private policyContext(providerId: string, offeringId: string) {
    return {
      registry: this.options.registry,
      templateKind: this.options.connectionProviders?.templateKind?.(providerId),
      policy: this.getPolicy(providerId, offeringId),
    };
  }
  private receiptPoliciesFor(
    policy: ProviderOfferingModelPolicy,
  ): readonly ProviderOfferingModelPolicy[] {
    const shared = this.options.registry.listReceiptPolicies();
    return policy.transformReceipt && !shared.includes(policy) ? [...shared, policy] : shared;
  }
  private enrichFamilyRoutes(
    routes: ModelRoute[],
    account: Account,
    credentialRevision: string,
    policy: ProviderOfferingModelPolicy | null,
  ): ModelRoute[] {
    return routes.map((route) => {
      const protocolFamily = modelEndpointDescriptor(route.protocol).protocolFamily;
      const peers = routes.filter(
        (r) => modelEndpointDescriptor(r.protocol).protocolFamily === protocolFamily,
      );
      const consistent = peers.every(
        (r) => r.baseUrl === route.baseUrl && familyVersion(r) === familyVersion(route),
      );
      const familyBindingRevision = consistent
        ? computeFamilyBindingRevision({
            accountId: account.id,
            providerId: account.provider,
            offeringId: account.offeringId,
            protocolFamily,
            baseUrl: route.baseUrl,
            protocolVersion: familyVersion(route),
            endpointRevisions: route.familyBindingRevision ?? peers.map((r) => r.bindingRevision),
            credentialRevision,
          })
        : undefined;
      const familyCatalog =
        !consistent ||
        !protocolFamilyDescriptors[protocolFamily].catalogPath ||
        route.familyPolicy?.catalog === "none" ||
        policy?.catalogMode === "none"
          ? "none"
          : policy?.catalogMode === "vendor"
            ? "vendor"
            : "native";
      return { ...route, protocolFamily, familyBindingRevision, familyCatalog };
    });
  }
  private resolveLocalRoutes(
    account: Account,
    policy: ProviderOfferingModelPolicy | null,
  ): ModelRoute[] | null {
    const source = this.options.connectionProviders;
    const isLocalKey =
      isLocalKeyAccount(account, (id) => this.options.registry.findOffering(id)) ||
      (account.authMethod === "api-key" &&
        typeof account.publicMetadata.credentialBindingRevision === "string" &&
        Boolean(policy?.routeConfig));

    if (isLocalKey) {
      const revision = account.publicMetadata.credentialBindingRevision;
      if (!revision || typeof revision !== "string") return [];
      let endpoints: ModelRoute[];
      if (isCustomProviderId(account.provider)) {
        endpoints = source?.routes(account.provider, account.offeringId) ?? [];
      } else if (policy?.routeConfig) {
        if (policy.routeConfig.mode === "fixed") {
          endpoints = defaultRoutesFromConfig(
            policy.routeConfig,
            account.offeringId,
            "official-v1",
          );
        } else if (revision.startsWith("default-") || revision.startsWith("official-")) {
          endpoints = defaultRoutesFromConfig(policy.routeConfig, account.offeringId, "default-v1");
        } else {
          endpoints = source?.accountRoutes?.(account.id) ?? [];
        }
      } else {
        endpoints = [];
      }
      return this.enrichFamilyRoutes(endpoints, account, revision, policy).map((item) => ({
        ...item,
        bindingRevision: computeRouteBindingRevision({
          accountId: account.id,
          providerId: account.provider,
          offeringId: account.offeringId,
          protocol: item.protocol,
          endpointRevision: item.bindingRevision,
          credentialRevision: revision,
        }),
      }));
    }

    const owner = this.options.registry.findOffering(account.offeringId);
    const routeConfig = policy?.routeConfig ?? owner?.offering.routeConfig;
    if (routeConfig) {
      if (
        !policy &&
        (owner?.provider !== account.provider ||
          !owner.offering.authMethods.some((method) => method.method === account.authMethod))
      ) {
        return [];
      }
      const fixed = defaultRoutesFromConfig(routeConfig, account.offeringId);
      return this.enrichFamilyRoutes(fixed, account, account.stableIdentity, policy);
    }

    return null;
  }
  private resolveLocalRoute(
    account: Account,
    protocol: EndpointProtocol,
    expectedBindingRevision: string,
    policy: ProviderOfferingModelPolicy | null,
  ): ModelRoute | null {
    const routes = this.resolveLocalRoutes(account, policy);
    if (routes === null) return null;
    const found = routes.find((r) => r.protocol === protocol);
    if (!found || found.bindingRevision !== expectedBindingRevision)
      throw new AppError("stale-binding", "模型连接已变更");
    return found;
  }
  private boundAccount(input: RouteBindingRequest) {
    const account = this.visibleAccount(input);
    const policy = this.getPolicy(account.provider, account.offeringId) ?? undefined;
    const route = resolveModelRoutes(
      account,
      undefined,
      this.options.connectionProviders,
      policy,
    ).find((r) => r.protocol === input.protocol);
    if (!route || route.bindingRevision !== input.expectedBindingRevision)
      throw new AppError("stale-binding", "模型连接已变更，请重新选择");
    return account;
  }
  private taskKey(contextId: string, key: CatalogKey) {
    return JSON.stringify([
      contextId,
      key.visibilityRef,
      key.providerId,
      key.accountId,
      key.offeringId,
      key.protocolFamily,
      key.familyBindingRevision,
    ]);
  }
  private configKey(s: ModelSelection, offeringId: string, pub = false): ConfigKey {
    return { ...s, offeringId, accountId: pub ? null : s.accountId };
  }
  private catalogRoute(account: Account, ep: ModelEndpointDescriptor, binding: string) {
    const policy = this.getPolicy(account.provider, account.offeringId) ?? undefined;
    return resolveModelRoutes(account, undefined, this.options.connectionProviders, policy).find(
      (r) => r.protocol === ep.protocol && r.bindingRevision === binding,
    );
  }
  private catalogKey(
    account: Account,
    ep: ModelEndpointDescriptor,
    route: ModelRouteSummary | undefined,
  ) {
    return {
      accountId: account.id,
      offeringId: account.offeringId,
      providerId: account.provider,
      protocolFamily: ep.protocolFamily,
      familyBindingRevision: route?.familyBindingRevision ?? "",
      visibilityRef: this.options.visibilityRef(),
    };
  }
  private readCatalog(
    key: CatalogKey,
    ep: ModelEndpointDescriptor,
    policy?: ProviderOfferingModelPolicy | null,
  ) {
    const catalog = key.familyBindingRevision ? this.repo.getCatalog(key) : undefined;
    if (!catalog) return undefined;
    const entries = policy?.discoverableProtocols?.length
      ? projectNewApiFamilyModels(catalog.entries, ep.protocol)
      : projectDiscoveredModels(catalog.entries, ep.protocol);
    return { ...catalog, entries };
  }
  private catalogModelHints(
    account: Account,
    ep: ModelEndpointDescriptor,
    binding: string,
  ): readonly CatalogModelHint[] | undefined {
    const key = this.catalogKey(account, ep, this.catalogRoute(account, ep, binding));
    const catalog = key.familyBindingRevision ? this.repo.getCatalog(key) : undefined;
    if (!catalog?.entries.length) return undefined;
    return catalog.entries.map((entry) => ({
      modelId: entry.modelId,
      ...(entry.endpointTypes ? { endpointTypes: entry.endpointTypes } : {}),
    }));
  }
  private resolve(
    s: ModelSelection,
    account: Account,
    binding: string,
    pub = false,
  ): ModelEntryView {
    const key = this.configKey(s, account.offeringId);
    const row = pub ? undefined : this.repo.get(key);
    const local = row?.accountIdentity === identity(account) ? row : undefined;
    const common = isPublicOffering(s.providerId)
      ? this.repo.get({ ...key, accountId: null })
      : undefined;
    const ep = endpoint(s.protocol);
    const pCtx = this.policyContext(account.provider, account.offeringId);
    const catalog = this.readCatalog(
      this.catalogKey(account, ep, this.catalogRoute(account, ep, binding)),
      ep,
      pCtx.policy,
    );
    return projectEntry(
      this.repo,
      s,
      account.offeringId,
      ep,
      this.options.visibilityRef(),
      binding,
      this.access(account),
      local,
      common,
      catalog?.entries.find((e) => e.modelId === s.modelId),
      catalog,
      undefined,
      pCtx,
    );
  }
  private validateSelection(context: CommandContext, s: ModelSelection, binding: string) {
    const account = this.boundAccount({ ...context, ...s, expectedBindingRevision: binding });
    if (account.provider !== s.providerId) throw new AppError("validation", "模型与所选账号不匹配");
    return account;
  }
  private canDiscover(
    account: Account,
    ep: ModelEndpointDescriptor,
    route: ModelRouteSummary | undefined,
  ) {
    if (!route?.familyBindingRevision || route.familyCatalog === "none") return false;
    const policy = this.getPolicy(account.provider, account.offeringId);
    if (!policy || policy.catalogMode === "none") return false;
    return ep.canDiscover || Boolean(policy.discoverableProtocols?.includes(ep.protocol));
  }
  private catalogView(
    account: Account,
    ep: ModelEndpointDescriptor,
    route: ModelRouteSummary,
    state: ModelState,
  ): ModelCatalogView {
    const source = this.access(account);
    const binding = route.bindingRevision;
    const canDiscover = this.canDiscover(account, ep, route);
    const pCtx = this.policyContext(account.provider, account.offeringId);
    const key = this.catalogKey(account, ep, route),
      catalog =
        source.state === "enabled" && canDiscover
          ? this.readCatalog(key, ep, pCtx.policy)
          : undefined;
    const common = isPublicOffering(account.provider)
      ? this.repo.list(account.provider, account.offeringId, ep.protocol, null)
      : [];
    const local = this.repo
      .list(account.provider, account.offeringId, ep.protocol, account.id)
      .filter((r) => r.accountIdentity === identity(account));
    const overrides = new Map(local.map((r) => [r.modelId, r])),
      defaults = new Map(common.map((r) => [r.modelId, r])),
      remote = new Map(catalog?.entries.map((r) => [r.modelId, r]));
    const models = new Set([...remote.keys(), ...overrides.keys(), ...defaults.keys()]);
    const task = this.taskKey(this.options.providers.getBackend().contextId, key);
    const err = this.failures.get(task) ?? null;
    const entries = (pub: boolean) =>
      [...(pub ? new Set([...remote.keys(), ...defaults.keys()]) : models)].sort().map((modelId) =>
        projectEntry(
          this.repo,
          {
            accountId: account.id,
            providerId: account.provider,
            protocol: ep.protocol,
            modelId,
          },
          account.offeringId,
          ep,
          key.visibilityRef,
          binding,
          source,
          pub ? undefined : overrides.get(modelId),
          defaults.get(modelId),
          remote.get(modelId),
          catalog,
          state,
          pCtx,
        ),
      );
    return {
      accountDisplayName: account.displayName,
      providerId: account.provider,
      offeringId: account.offeringId,
      accountId: account.id,
      protocol: ep.protocol,
      protocolFamily: ep.protocolFamily,
      familyBindingRevision: key.familyBindingRevision || undefined,
      bindingRevision: binding,
      catalog: catalog
        ? {
            state: "ready",
            fetchedAt: catalog.fetchedAt,
            catalogRevision: catalog.revision,
            stale: !!err || Date.now() - Date.parse(catalog.fetchedAt) >= 86400000,
          }
        : err
          ? { state: "unavailable", reason: err.message }
          : { state: "not-loaded" },
      refreshing: this.tasks.has(task),
      lastRefreshError: err,
      register: source,
      refresh: !key.familyBindingRevision
        ? disabled("请先统一同一协议族的地址和版本")
        : canDiscover
          ? source
          : disabled("该端点通过手工登记模型"),
      entries: entries(false),
      publicEntries: isPublicOffering(account.provider) ? entries(true) : [],
    };
  }
  getSnapshot(_refreshExpired = false): GraphModelSnapshot {
    const { instanceId } = this.options.providers,
      backend = this.options.providers.getBackend(),
      visible = this.options.visible(),
      state = this.repo.state();
    const catalogs = this.options.storage.accounts
      .list()
      .filter((a) => visible?.has(a.id) ?? true)
      .sort((a, b) => a.id.localeCompare(b.id))
      .flatMap((a) =>
        resolveModelRoutes(
          a,
          undefined,
          this.options.connectionProviders,
          this.getPolicy(a.provider, a.offeringId) ?? undefined,
        ).map((r) => this.catalogView(a, endpoint(r.protocol), r, state)),
      );
    for (const group of this.repo.publicRoutes()) {
      if (
        catalogs.some(
          (c) =>
            c.providerId === group.providerId &&
            c.offeringId === group.offeringId &&
            c.protocol === group.protocol,
        )
      )
        continue;
      const action = disabled("暂无可用于读取目录的账号"),
        ep = endpoint(group.protocol);
      const pCtx = this.policyContext(group.providerId, group.offeringId);
      const publicEntries = this.repo
        .list(group.providerId, group.offeringId, group.protocol, null)
        .map((row) =>
          projectEntry(
            this.repo,
            { ...selection(row), accountId: "" },
            group.offeringId,
            ep,
            "",
            "",
            action,
            undefined,
            row,
            undefined,
            undefined,
            state,
            pCtx,
          ),
        );
      catalogs.push({
        ...group,
        accountDisplayName: "无可用账号",
        accountId: "",
        bindingRevision: "",
        catalog: { state: "not-loaded" },
        refreshing: false,
        lastRefreshError: null,
        register: action,
        refresh: action,
        entries: [],
        publicEntries,
      });
    }
    const chosen = this.repo.byId(state.selectedId);
    let savedSelection: GraphModelSnapshot["savedSelection"] = null;
    if (chosen && chosen.accountId && (visible?.has(chosen.accountId) ?? true)) {
      const account = this.options.storage.accounts.get(chosen.accountId);
      if (account && identity(account) === chosen.accountIdentity) {
        const current = catalogs.find(
          (c) =>
            c.accountId === chosen.accountId &&
            c.providerId === chosen.providerId &&
            c.offeringId === chosen.offeringId &&
            c.protocol === chosen.protocol,
        );
        const entry = current?.entries.find((e) => e.selection.modelId === chosen.modelId);
        savedSelection = {
          selection: selection(chosen),
          parameters: entry?.parameters ?? {
            contextWindow: null,
            maxOutputTokens: null,
            effort: null,
          },
          availability:
            current?.bindingRevision === state.bindingRevision && entry
              ? entry.actions.select
              : disabled("原模型绑定已变更，请重新选择"),
        };
      }
    }
    return {
      stamp: { instanceId, scope: "graph-agent.models", revision: this.revision },
      backend,
      generatedAt: new Date().toISOString(),
      settingsRevision: state.revision,
      pack: {
        active: state.active,
        previous: state.previous,
        updateConfigured: !!process.env.GRAPH_AGENT_MODEL_PACK_URL,
      },
      presets: this.repo
        .activePack(state.active)
        .presets.map(
          ({
            key,
            modelId,
            displayName,
            vendor,
            revision,
            checkedAt,
            referenceUrl,
            family,
            series,
            capabilities,
          }) => ({
            key,
            modelId,
            displayName,
            vendor,
            revision,
            checkedAt,
            referenceUrl,
            family,
            series,
            operations: capabilities.map((c) => c.operation),
          }),
        ),
      catalogs,
      savedSelection,
    };
  }
  async refreshCatalog(request: RefreshCatalogRequest) {
    let input: RouteBindingRequest;
    if ("expectedFamilyBindingRevision" in request) {
      const account = this.visibleAccount(request);
      const policy = this.getPolicy(account.provider, account.offeringId) ?? undefined;
      const routes = resolveModelRoutes(
        account,
        undefined,
        this.options.connectionProviders,
        policy,
      ).filter(
        (r) =>
          r.protocolFamily === request.protocolFamily &&
          r.familyBindingRevision === request.expectedFamilyBindingRevision,
      );
      if (!routes.length) throw new AppError("stale-binding", "目录所属协议族或绑定已更新");
      const route = routes.find((r) => this.canDiscover(account, endpoint(r.protocol), r));
      if (!route) throw new AppError("capability-unavailable", "该协议族未提供模型列表");
      input = {
        instanceId: request.instanceId,
        contextId: request.contextId,
        accountId: account.id,
        protocol: route.protocol,
        expectedBindingRevision: route.bindingRevision,
      };
    } else input = request;
    const account = this.boundAccount(input),
      ep = endpoint(input.protocol),
      route = this.catalogRoute(account, ep, input.expectedBindingRevision),
      storeKey = this.catalogKey(account, ep, route),
      key = this.taskKey(input.contextId, storeKey),
      policy = this.getPolicy(account.provider, account.offeringId);
    if (!storeKey.familyBindingRevision)
      throw new AppError("conflict", "请先统一同一协议族的地址和版本");
    if (!this.canDiscover(account, ep, route) || !policy)
      throw new AppError("capability-unavailable", "该端点没有模型列表，请手工登记");
    let task = this.tasks.get(key);
    if (!task) {
      const stop = new AbortController();
      const check = () => {
        this.options.providers.assertContext(input);
        const current = this.options.storage.accounts.get(account.id);
        if (
          !current ||
          this.options.visible()?.has(account.id) === false ||
          current.offeringId !== account.offeringId ||
          identity(current) !== identity(account) ||
          this.options.visibilityRef() !== storeKey.visibilityRef
        )
          throw new AppError("stale-binding", "目录绑定已变化");
        available(this.access(current));
        const currentPolicy = this.getPolicy(current.provider, current.offeringId) ?? undefined;
        if (
          !resolveModelRoutes(
            current,
            undefined,
            this.options.connectionProviders,
            currentPolicy,
          ).some(
            (r) =>
              r.protocolFamily === ep.protocolFamily &&
              r.familyBindingRevision === storeKey.familyBindingRevision,
          )
        )
          throw new AppError("stale-binding", "协议族连接已变化");
      };
      const done = this.options.mutations
        .run(async () => {
          const entries = await this.options.refresh.withModelCredential(
            account,
            async (envelope) => {
              const { account: current, route } = this.decryptedRoute(input, envelope, policy);
              if (route.familyBindingRevision !== storeKey.familyBindingRevision)
                throw new AppError("stale-binding", "族连接已变化或地址冲突，请重新配置");
              return discoverRouteModels(
                this.options.http,
                current,
                envelope,
                route,
                stop.signal,
                this.options.connectionProviders,
                "family",
                policy,
              );
            },
          );
          check();
          stop.signal.throwIfAborted();
          this.repo.saveCatalog(storeKey, entries);
          this.failures.delete(key);
        })
        .catch((err) => {
          check();
          this.failures.set(key, toPublicError(err));
          throw err;
        })
        .finally(() => {
          this.tasks.delete(key);
          this.changed("catalogs");
        });
      task = { check, done, stop };
      this.tasks.set(key, task);
      this.changed("catalogs");
    }
    await task.done;
    this.boundAccount(input);
    return this.getSnapshot();
  }
  private decryptedRoute(
    input: RouteBindingRequest,
    envelope: CredentialEnvelope,
    policy?: ProviderOfferingModelPolicy,
  ) {
    const account = this.boundAccount(input);
    const activePolicy =
      policy ?? this.getPolicy(account.provider, account.offeringId) ?? undefined;
    const route = resolveModelRoutes(
      account,
      envelope,
      this.options.connectionProviders,
      activePolicy,
    ).find((r) => r.protocol === input.protocol);
    if (!route || route.bindingRevision !== input.expectedBindingRevision)
      throw new AppError("stale-binding", "模型连接已变更");
    return { account, route };
  }
  private settings(context: CommandContext & { expectedSettingsRevision: string }) {
    this.options.providers.assertContext(context);
    this.options.mutations.assertAvailable();
    if (this.repo.state().revision !== context.expectedSettingsRevision) settingsConflict();
  }
  private mutate(
    input: SaveModelDraftRequest | EditManualModelRequest,
    apply: (doc: ModelConfigDocument, ep: ModelEndpointDescriptor, account: Account) => void,
    pub = false,
    allowNew = false,
    notify = true,
  ) {
    this.settings(input);
    const account = this.validateSelection(input, input.selection, input.expectedBindingRevision),
      ep = endpoint(input.selection.protocol),
      key = this.configKey(input.selection, account.offeringId, pub);
    if (pub && !isPublicOffering(account.provider))
      throw new AppError("validation", "自定义接入仅支持账号配置");
    this.repo.edit(input.expectedSettingsRevision, () => {
      const before = this.resolve(input.selection, account, input.expectedBindingRevision, pub),
        record = this.repo.get(key);
      if (!allowNew && before.presence === "missing" && !record && !pub)
        throw new AppError("not-found", "请先登记或发现模型");
      if (pub && !record && before.presence === "missing")
        throw new AppError("not-found", "请在取样账号的当前目录中选择模型");
      const doc = record?.document ?? { operations: {} };
      apply(doc, ep, account);
      this.repo.save(key, pub ? null : identity(account), ep.modelType, doc);
      const after = this.resolve(input.selection, account, input.expectedBindingRevision, pub);
      validateParameters(after, after.parameters);
    });
    if (notify) this.changed("model-settings");
    return this.getSnapshot();
  }
  saveModelDraft(input: SaveModelDraftRequest) {
    return this.applyDraft(input, true);
  }
  private applyDraft(input: SaveModelDraftRequest, notify: boolean) {
    return this.mutate(
      input,
      (doc, ep, account) => {
        assertCompatible(ep, {
          modelType: input.modelType,
          operation: input.operation,
          ioProfile: input.ioProfile,
        });
        if (input.expectedPackRevision && input.expectedPackRevision !== this.repo.state().active)
          settingsConflict();
        const key = scopeKey(ep.operation, ep.ioProfile),
          layer = (doc.operations[key] ??= {
            facts: {},
            prices: [],
            parameters: {},
            revision: "",
            updatedAt: "",
          });
        const plan =
          input.ratePlanKey ??
          layer.ratePlanKey ??
          this.resolve(
            input.selection,
            account,
            input.expectedBindingRevision,
            input.scope === "offering",
          ).ratePlanKey;
        if (["__proto__", "constructor", "prototype"].includes(plan))
          throw new AppError("validation", "无效的套餐编号");
        let prices = plan === "default" ? layer.prices : (layer.planPrices?.[plan] ?? []);
        const stamp = { revision: randomUUID(), updatedAt: new Date().toISOString() };
        const stamps = (layer.stamps ??= {});
        const mark = (k: string, op: string) => {
          if (op === "clear") delete stamps[k];
          else stamps[k] = stamp;
        };
        for (const c of input.changes) mark("fact:" + c.field, c.operation);
        for (const c of input.priceChanges)
          mark("price:" + plan + ":" + priceKey(c.key), c.operation);
        for (const c of input.parameterChanges) mark("parameter:" + c.field, c.operation);
        if (input.presetKey !== undefined) {
          if (input.presetKey === null) delete layer.presetKey;
          else {
            const preset = this.repo.activePack().byKey.get(input.presetKey);
            if (!preset?.capabilities.some((c) => c.operation === ep.operation))
              throw new AppError("validation", "该预置不支持所选端点操作");
            layer.presetKey = input.presetKey;
          }
        }
        for (const c of input.changes) {
          if (c.operation === "clear") delete layer.facts[c.field];
          else Object.assign(layer.facts, { [c.field]: c.value });
        }
        for (const c of input.priceChanges) {
          prices = prices.filter((p) => priceKey(p) !== priceKey(c.key));
          if (c.operation === "set")
            prices.push({ ...c.key, unit: priceUnit(c.key.unit), amount: c.amount });
        }
        for (const c of input.parameterChanges) {
          if (c.operation === "clear") delete layer.parameters[c.field];
          else Object.assign(layer.parameters, { [c.field]: c.value });
        }
        if (layer.parameters.thinkingEnabled === false) {
          layer.parameters.effort = null;
          layer.parameters.returnFullReasoning = false;
        }
        if (input.ratePlanKey !== undefined) {
          if (["__proto__", "constructor", "prototype"].includes(input.ratePlanKey))
            throw new AppError("validation", "无效的套餐编号");
          layer.ratePlanKey = input.ratePlanKey;
        }
        if (input.rateCard !== undefined) {
          mark("card:" + plan, "set");
          const refs = (layer.cardRefs ??= {});
          if (input.rateCard === null) {
            delete refs[plan];
            if (!Object.keys(refs).length) delete layer.cardRefs;
          } else {
            const card = parseRateCard(input.rateCard),
              scope = card.scope;
            if (
              scope &&
              (scope.providerId !== account.provider ||
                scope.offeringId !== account.offeringId ||
                scope.operation !== ep.operation ||
                (scope.protocol && scope.protocol !== ep.protocol) ||
                (scope.upstreamModelId && scope.upstreamModelId !== input.selection.modelId) ||
                (scope.planKey && scope.planKey !== plan))
            )
              throw new AppError("validation", "价卡声明的渠道或操作与当前绑定不符");
            // A full-card edit can also explicitly change a previously overridden base price.
            // Preserve unrelated overrides; resolving the submitted price patch in this transaction takes precedence.
            const previous = this.repo.card(refs[plan]);
            for (const { key: priceKeyValue, line, index } of basicCardRows(card)) {
              const id = priceKey(priceKeyValue),
                own = prices.find((p) => priceKey(p) === id);
              if (!own || input.priceChanges.some((c) => priceKey(c.key) === id)) continue;
              if (own.amount !== line.amount) {
                prices = prices.filter((p) => priceKey(p) !== id);
                mark("price:" + plan + ":" + id, "clear");
              } else if (previous) {
                const original = basicCardRows(previous).find((r) => priceKey(r.key) === id);
                if (original) card.chargeLines[index] = { ...line, amount: original.line.amount };
              }
            }
            refs[plan] = this.repo.saveCard(card);
          }
        }
        if (plan === "default") layer.prices = prices;
        else if (prices.length) (layer.planPrices ??= {})[plan] = prices;
        else if (layer.planPrices) {
          delete layer.planPrices[plan];
          if (!Object.keys(layer.planPrices).length) delete layer.planPrices;
        }
        layer.revision = stamp.revision;
        layer.updatedAt = stamp.updatedAt;
        if (
          !layer.presetKey &&
          !layer.cardRefs &&
          !layer.planPrices &&
          !layer.ratePlanKey &&
          !layer.prices.length &&
          !Object.keys(layer.facts).length &&
          !Object.keys(layer.parameters).length
        )
          delete doc.operations[key];
      },
      input.scope === "offering",
      false,
      notify,
    );
  }
  editManualModel(input: EditManualModelRequest) {
    return this.mutate(
      input,
      (doc, ep) => {
        if (input.change.operation === "remove") {
          delete doc.displayName;
          delete doc.manualBinding;
        } else {
          assertCompatible(ep, {
            modelType: input.change.modelType,
            operation: input.change.modelOperation,
            ioProfile: input.change.ioProfile,
          });
          doc.displayName = input.change.displayName;
          doc.manualBinding = {
            visibilityRef: this.options.visibilityRef(),
            revision: input.expectedBindingRevision,
          };
        }
      },
      false,
      true,
    );
  }
  editModelOverrides(input: EditModelOverrideRequest) {
    return this.saveModelDraft({ ...input, scope: "account", parameterChanges: [] });
  }
  selectPreset(input: SelectPresetRequest) {
    return this.saveModelDraft({
      ...input,
      scope: "account",
      changes: [],
      priceChanges: [],
      parameterChanges: [],
    });
  }
  saveModelSelection(input: SaveModelSelectionRequest) {
    this.settings(input);
    this.repo.edit(input.expectedSettingsRevision, () => {
      const c = input.choice;
      if (!c) {
        this.repo.select(null, null, null, null);
        return;
      }
      const account = this.validateSelection(input, c.selection, c.expectedBindingRevision),
        ep = endpoint(c.selection.protocol),
        key = this.configKey(c.selection, account.offeringId);
      const entry = this.resolve(c.selection, account, c.expectedBindingRevision);
      available(entry.actions.select);
      const row = this.repo.get(key),
        doc = row?.document ?? { operations: {} };
      // The deprecated parameters property is accepted for wire compatibility. Only saved drafts change model defaults.
      const id = this.repo.save(key, identity(account), ep.modelType, doc);
      this.repo.select(id, ep.operation, ep.ioProfile, c.expectedBindingRevision);
    });
    this.changed("selection");
    return this.getSnapshot();
  }
  async changeModelPack(input: ChangeModelPackRequest) {
    this.settings(input);
    let pack: ValidatedPack | undefined;
    if (input.action === "import") pack = validateModelPack(input.pack);
    else if (input.action === "update") {
      const url = process.env.GRAPH_AGENT_MODEL_PACK_URL;
      if (!url) throw new AppError("capability-unavailable", "管理员尚未配置预置更新源");
      pack = await fetchPack(url, this.options.http.fetch.bind(this.options.http));
    }
    this.settings(input);
    this.repo.edit(input.expectedSettingsRevision, () => this.repo.activate(pack));
    this.changed("model-settings");
    return this.getSnapshot();
  }
  estimateModelCost(input: EstimateModelCostRequest) {
    this.options.providers.assertContext(input);
    return estimateCharge(parseRateCard(input.rateCard), parseBillingWorkload(input.workload));
  }
  assertContext(context: CommandContext) {
    this.options.providers.assertContext(context);
  }
  readFamilyDirectory(
    input: CommandContext & { accountId: string; family: "openai" | "anthropic"; revision: string },
  ) {
    const source = this.options.connectionProviders;
    const current = () => {
      this.options.providers.assertContext(input);
      const account = this.options.storage.accounts.get(input.accountId);
      if (!account || this.options.visible()?.has(account.id) === false)
        throw new AppError("not-found", "账号不存在或不可访问");
      available(this.access(account));
      const policy = this.getPolicy(account.provider, account.offeringId);
      const routes = resolveModelRoutes(account, undefined, source, policy ?? undefined);
      const route = routes.find(
        (r) => r.protocolFamily === input.family && r.familyBindingRevision === input.revision,
      );
      if (!route || !policy) throw new AppError("stale-binding", "该协议族目录不可用或绑定已更新");
      if (route.familyCatalog !== "native")
        throw new AppError("capability-unavailable", "该供应商未开放此族的原生目录");
      return { account, route, policy };
    };
    const { account, route, policy } = current();
    const check = () => {
      const active = current();
      if (
        identity(active.account) !== identity(account) ||
        active.account.offeringId !== account.offeringId
      )
        settingsConflict();
    };
    return {
      account,
      policy,
      source,
      check,
      route: (envelope: CredentialEnvelope) => {
        check();
        const target = resolveModelRoutes(account, envelope, source, policy).find(
          (r) =>
            r.protocol === route.protocol &&
            r.familyBindingRevision === input.revision &&
            r.familyCatalog === "native",
        );
        if (!target) throw new AppError("stale-binding", "协议族目录绑定已更新");
        return target;
      },
    };
  }
  readSavedCall(input: Omit<TestChatRequest, "prompt">) {
    this.settings(input);
    const state = this.repo.state(),
      row = this.repo.byId(state.selectedId);
    if (!row || !row.accountId || state.bindingRevision !== input.expectedBindingRevision)
      settingsConflict();
    const s = selection(row),
      account = this.validateSelection(input, s, input.expectedBindingRevision);
    if (identity(account) !== row.accountIdentity || account.offeringId !== row.offeringId)
      settingsConflict();
    const entry = this.resolve(s, account, input.expectedBindingRevision);
    available(entry.actions.select);
    validateParameters(entry, entry.parameters);
    const policy = this.resolvePolicy(account.provider, account.offeringId);
    const ep = endpoint(s.protocol);
    const facts = extractEntryFacts(entry);
    const catalogModels = this.catalogModelHints(account, ep, input.expectedBindingRevision);
    const localRoute = this.resolveLocalRoute(
      account,
      s.protocol,
      input.expectedBindingRevision,
      policy,
    );
    const receiptPolicies = this.receiptPoliciesFor(policy);
    const routeInput: RouteBindingRequest = {
        instanceId: input.instanceId,
        contextId: input.contextId,
        accountId: s.accountId,
        protocol: s.protocol,
        expectedBindingRevision: input.expectedBindingRevision,
      },
      source = this.options.connectionProviders;
    const check = () => {
      const current = this.boundAccount(routeInput);
      if (current.offeringId !== row.offeringId || identity(current) !== row.accountIdentity)
        settingsConflict();
    };
    const compilePlan = (route: ModelRoute): RequestPlan => {
      const plan = compileModelRequestPlan({
        providerId: account.provider,
        offeringId: account.offeringId,
        route,
        localModelId: s.modelId,
        facts,
        parameters: entry.parameters,
        policy,
        catalogModels,
      });
      if (route.requestRule) validateParameters(entry, plan.parameters);
      return plan;
    };
    return {
      account,
      entry,
      policy,
      receiptPolicies,
      facts,
      catalogModels,
      localRoute,
      modelId: s.modelId,
      parameters: entry.parameters,
      compilePlan,
      check,
      checkSelection: () => {
        check();
        const selected = this.repo.state();
        if (
          selected.selectedId !== state.selectedId ||
          selected.bindingRevision !== input.expectedBindingRevision
        )
          settingsConflict();
        available(this.resolve(s, account, input.expectedBindingRevision).actions.select);
      },
      source,
      route: (envelope: CredentialEnvelope) => {
        check();
        return this.decryptedRoute(routeInput, envelope, policy).route;
      },
    };
  }
  async previewRequest(input: PreviewModelRequest): Promise<ModelRequestPreview> {
    this.settings(input);
    const account = this.validateSelection(input, input.selection, input.expectedBindingRevision);
    const entry = input.draft
      ? this.repo.simulate(() => {
          const draft = input.draft!;
          if (
            draft.instanceId !== input.instanceId ||
            draft.contextId !== input.contextId ||
            draft.expectedSettingsRevision !== input.expectedSettingsRevision ||
            draft.expectedBindingRevision !== input.expectedBindingRevision ||
            draft.selection.providerId !== input.selection.providerId ||
            draft.selection.accountId !== input.selection.accountId ||
            draft.selection.modelId !== input.selection.modelId ||
            draft.selection.protocol !== input.selection.protocol
          )
            settingsConflict();
          this.applyDraft(draft, false);
          return this.resolve(input.selection, account, input.expectedBindingRevision);
        })
      : this.resolve(input.selection, account, input.expectedBindingRevision);
    available(entry.actions.preview);
    const parameters = input.draft
      ? entry.parameters
      : {
          ...input.parameters,
          thinkingEnabled:
            entry.fields.reasoningMode.value !== "none" &&
            (input.parameters.thinkingEnabled ?? entry.parameters.thinkingEnabled ?? true),
          returnFullReasoning:
            input.parameters.returnFullReasoning ?? entry.parameters.returnFullReasoning ?? false,
        };
    if (!parameters.thinkingEnabled) {
      parameters.effort = null;
      parameters.returnFullReasoning = false;
    }
    if (input.operation !== "chat")
      throw new AppError("capability-unavailable", "媒体端点仅支持配置");
    validateParameters(entry, parameters);
    const policy = this.resolvePolicy(account.provider, account.offeringId);
    const facts = extractEntryFacts(entry);
    const ep = endpoint(input.selection.protocol);
    const catalogModels = this.catalogModelHints(account, ep, input.expectedBindingRevision);

    // Local custom providers and built-in offerings resolve routes locally with zero credential reads.
    let routeAccount = account;
    let route = this.resolveLocalRoute(
      account,
      input.selection.protocol,
      input.expectedBindingRevision,
      policy,
    );
    if (!route) {
      // Legacy v2 encrypted connections (compatible-api-key) keep routes inside the credential envelope.
      const envelope = await (this.options.credentials.loadCurrent?.(account.id) ??
        this.options.credentials.load(account.id));
      this.settings(input);
      const current = this.decryptedRoute({ ...input, ...input.selection }, envelope, policy);
      routeAccount = current.account;
      route = current.route;
    }

    if (route.requestRule) {
      const plan = compileModelRequestPlan({
        providerId: routeAccount.provider,
        offeringId: routeAccount.offeringId,
        route,
        localModelId: input.selection.modelId,
        facts,
        parameters,
        policy,
        catalogModels,
      });
      validateParameters(entry, plan.parameters);
    }

    const compiled = previewModelChat(
      routeAccount,
      route,
      input.selection.modelId,
      parameters,
      this.options.connectionProviders,
      { facts, policy, catalogModels },
    );

    return {
      instanceId: input.instanceId,
      contextId: input.contextId,
      selection: input.selection,
      bindingRevision: input.expectedBindingRevision,
      settingsRevision: input.expectedSettingsRevision,
      operation: input.operation,
      method: compiled.method,
      baseUrl: compiled.baseUrl,
      relativePath: compiled.relativePath,
      upstreamModelId: compiled.upstreamModelId,
      consumedParameters: compiled.consumedParameters,
      ruleSources: compiled.ruleSources,
      headers: compiled.headers,
      body: compiled.body,
      warnings: compiled.warnings,
    };
  }
}
