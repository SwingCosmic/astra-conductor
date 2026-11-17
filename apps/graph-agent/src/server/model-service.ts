import { createHash, randomUUID } from "node:crypto";
import {
  modelEndpointDescriptors,
  type ModelEndpointDescriptor,
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
  type SaveModelSelectionRequest,
  type EstimateModelCostRequest,
  type PreviewModelRequest,
  type ModelRequestPreview,
  type TestChatRequest,
} from "@astra-conductor/contract/graph-agent";
import {
  AppError,
  resolveModelRoutes,
  toPublicError,
  estimateCharge,
  parseRateCard,
  parseBillingWorkload,
  type ProviderRegistry,
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
  type ConfigRow,
  type ModelState,
  type ModelConfigDocument,
} from "./model-repository.js";
import { validateModelPack, fetchPack, type ValidatedPack } from "./model-pack.js";
import {
  projectEntry,
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
function endpoint(id: string) {
  const item = modelEndpointDescriptors.find((ep) => ep.id === id);
  if (!item) throw new AppError("validation", "未注册的模型端点");
  return item;
}
function assertCompatible(
  ep: ModelEndpointDescriptor,
  input: { modelType?: string; operationId?: string; profileId?: string },
) {
  if (
    (input.modelType !== undefined && input.modelType !== ep.modelType) ||
    (input.operationId !== undefined && input.operationId !== ep.operationId) ||
    (input.profileId !== undefined && input.profileId !== ep.profileId)
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
    protocolRouteId: row.protocolRouteId,
    modelId: row.modelId,
  };
}
export class GraphModelService {
  private revision = 0;
  private readonly observers = new Set<(stopping?: boolean) => void>();
  private readonly tasks = new Map<
    string,
    { input: RefreshCatalogRequest; stop: AbortController; done: Promise<void> }
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
        this.boundAccount(task.input);
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
  private boundAccount(input: RefreshCatalogRequest) {
    this.options.providers.assertContext(input);
    const account = this.options.storage.accounts.get(input.accountId);
    if (!account || this.options.visible()?.has(account.id) === false)
      throw new AppError("not-found", "账号不存在或不可访问");
    available(this.access(account));
    const route = resolveModelRoutes(account, undefined, this.options.connectionProviders).find(
      (r) => r.protocolRouteId === input.protocolRouteId,
    );
    if (!route || route.bindingRevision !== input.expectedBindingRevision)
      throw new AppError("stale-binding", "模型连接已变更，请重新选择");
    return account;
  }
  private taskKey(input: RefreshCatalogRequest) {
    return JSON.stringify([
      input.contextId,
      input.accountId,
      input.protocolRouteId,
      input.expectedBindingRevision,
    ]);
  }
  private configKey(s: ModelSelection, offeringId: string, pub = false): ConfigKey {
    return { ...s, offeringId, accountId: pub ? null : s.accountId };
  }
  private catalogKey(account: Account, ep: string, bindingRevision: string) {
    return {
      accountId: account.id,
      offeringId: account.offeringId,
      protocolRouteId: ep,
      bindingRevision,
      visibilityRef: this.options.visibilityRef(),
    };
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
    const ep = endpoint(s.protocolRouteId),
      catalog = this.repo.getCatalog(this.catalogKey(account, ep.id, binding));
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
    );
  }
  private validateSelection(context: CommandContext, s: ModelSelection, binding: string) {
    const account = this.boundAccount({ ...context, ...s, expectedBindingRevision: binding });
    if (account.provider !== s.providerId) throw new AppError("validation", "模型与所选账号不匹配");
    return account;
  }
  private catalogView(
    account: Account,
    ep: ModelEndpointDescriptor,
    binding: string,
    state: ModelState,
  ): ModelCatalogView {
    const source = this.access(account);
    const key = this.catalogKey(account, ep.id, binding),
      catalog = source.state === "enabled" ? this.repo.getCatalog(key) : undefined;
    const common = isPublicOffering(account.provider)
      ? this.repo.list(account.provider, account.offeringId, ep.id, null)
      : [];
    const local = this.repo
      .list(account.provider, account.offeringId, ep.id, account.id)
      .filter((r) => r.accountIdentity === identity(account));
    const overrides = new Map(local.map((r) => [r.modelId, r])),
      defaults = new Map(common.map((r) => [r.modelId, r])),
      remote = new Map(catalog?.entries.map((r) => [r.modelId, r]));
    const models = new Set([...remote.keys(), ...overrides.keys(), ...defaults.keys()]);
    const task = this.taskKey({
      instanceId: this.options.providers.instanceId,
      contextId: this.options.providers.getBackend().contextId,
      accountId: account.id,
      protocolRouteId: ep.id,
      expectedBindingRevision: binding,
    });
    const err = this.failures.get(task) ?? null;
    const entries = (pub: boolean) =>
      [...(pub ? new Set([...remote.keys(), ...defaults.keys()]) : models)].sort().map((modelId) =>
        projectEntry(
          this.repo,
          {
            accountId: account.id,
            providerId: account.provider,
            protocolRouteId: ep.id,
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
        ),
      );
    return {
      accountDisplayName: account.displayName,
      providerId: account.provider,
      offeringId: account.offeringId,
      accountId: account.id,
      protocolRouteId: ep.id,
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
      refresh: ep.canDiscover ? source : disabled("该端点通过手工登记模型"),
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
        resolveModelRoutes(a, undefined, this.options.connectionProviders).map((r) =>
          this.catalogView(a, endpoint(r.protocolRouteId), r.bindingRevision, state),
        ),
      );
    for (const group of this.repo.publicRoutes()) {
      if (
        catalogs.some(
          (c) =>
            c.providerId === group.providerId &&
            c.offeringId === group.offeringId &&
            c.protocolRouteId === group.protocolRouteId,
        )
      )
        continue;
      const action = disabled("暂无可用于读取目录的账号"),
        ep = endpoint(group.protocolRouteId);
      const publicEntries = this.repo
        .list(group.providerId, group.offeringId, group.protocolRouteId, null)
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
            c.protocolRouteId === chosen.protocolRouteId,
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
            vendorId,
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
            vendorId,
            revision,
            checkedAt,
            referenceUrl,
            family,
            series,
            operations: capabilities.map((c) => c.operationId),
          }),
        ),
      catalogs,
      savedSelection,
    };
  }
  async refreshCatalog(input: RefreshCatalogRequest) {
    const account = this.boundAccount(input),
      key = this.taskKey(input),
      ep = endpoint(input.protocolRouteId),
      cap = this.options.registry.getModels(account.provider);
    if (!ep.canDiscover || !cap)
      throw new AppError("capability-unavailable", "该端点没有模型列表，请手工登记");
    let task = this.tasks.get(key);
    if (!task) {
      const stop = new AbortController(),
        storeKey = this.catalogKey(account, ep.id, input.expectedBindingRevision);
      const done = this.options.mutations
        .run(async () => {
          const entries = await this.options.refresh.withModelCredential(
            account,
            async (envelope) => {
              const { account: current, route } = this.decryptedRoute(input, envelope);
              return cap.discover(
                this.options.http,
                current,
                envelope,
                route,
                stop.signal,
                this.options.connectionProviders,
              );
            },
          );
          this.boundAccount(input);
          stop.signal.throwIfAborted();
          if (storeKey.visibilityRef !== this.options.visibilityRef()) settingsConflict();
          this.repo.saveCatalog(
            storeKey,
            entries.map((entry) => ({
              ...entry,
              modelType: ep.modelType,
              operationId: ep.operationId,
              profileId: ep.profileId,
            })),
          );
          this.failures.delete(key);
        })
        .catch((err) => {
          this.boundAccount(input);
          this.failures.set(key, toPublicError(err));
          throw err;
        })
        .finally(() => {
          this.tasks.delete(key);
          this.changed("catalogs");
        });
      task = { input, done, stop };
      this.tasks.set(key, task);
      this.changed("catalogs");
    }
    await task.done;
    return this.getSnapshot();
  }
  private decryptedRoute(input: RefreshCatalogRequest, envelope: CredentialEnvelope) {
    const account = this.boundAccount(input);
    const route = resolveModelRoutes(account, envelope, this.options.connectionProviders).find(
      (r) => r.protocolRouteId === input.protocolRouteId,
    );
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
      ep = endpoint(input.selection.protocolRouteId),
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
        assertCompatible(ep, input);
        if (input.expectedPackRevision && input.expectedPackRevision !== this.repo.state().active)
          settingsConflict();
        const key = scopeKey(ep.operationId, ep.profileId),
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
            if (!preset?.capabilities.some((c) => c.operationId === ep.operationId))
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
                scope.operationId !== ep.operationId ||
                (scope.protocolRouteId && scope.protocolRouteId !== ep.id) ||
                (scope.upstreamModelId && scope.upstreamModelId !== input.selection.modelId) ||
                (scope.planId && scope.planId !== plan))
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
          assertCompatible(ep, input.change);
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
        ep = endpoint(c.selection.protocolRouteId),
        key = this.configKey(c.selection, account.offeringId);
      const entry = this.resolve(c.selection, account, c.expectedBindingRevision);
      available(entry.actions.select);
      const row = this.repo.get(key),
        doc = row?.document ?? { operations: {} };
      // The deprecated parameters property is accepted for wire compatibility. Only saved drafts change model defaults.
      const id = this.repo.save(key, identity(account), ep.modelType, doc);
      this.repo.select(id, ep.operationId, ep.profileId, c.expectedBindingRevision);
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
  readSavedCall(input: TestChatRequest) {
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
    const inference = this.options.registry.getInference(account.provider);
    if (!inference) throw new AppError("capability-unavailable", "所选供应商尚未提供推理能力");
    const routeInput = {
        instanceId: input.instanceId,
        contextId: input.contextId,
        accountId: s.accountId,
        protocolRouteId: s.protocolRouteId,
        expectedBindingRevision: input.expectedBindingRevision,
      },
      source = this.options.connectionProviders;
    const check = () => {
      const current = this.boundAccount(routeInput);
      if (current.offeringId !== row.offeringId || identity(current) !== row.accountIdentity)
        settingsConflict();
    };
    return {
      account,
      entry,
      inference,
      modelId: s.modelId,
      parameters: entry.parameters,
      check,
      source,
      route: (envelope: CredentialEnvelope) => {
        check();
        return this.decryptedRoute(routeInput, envelope).route;
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
            draft.selection.protocolRouteId !== input.selection.protocolRouteId
          )
            settingsConflict();
          this.applyDraft(draft, false);
          return this.resolve(input.selection, account, input.expectedBindingRevision);
        })
      : this.resolve(input.selection, account, input.expectedBindingRevision);
    available(entry.actions.preview);
    const parameters = input.draft ? entry.parameters : input.parameters;
    if (input.operation !== "chat")
      throw new AppError("capability-unavailable", "媒体端点仅支持配置");
    validateParameters(entry, parameters);
    const inference = this.options.registry.getInference(account.provider);
    if (!inference) throw new AppError("capability-unavailable", "所选供应商尚未提供推理能力");
    const envelope = await (this.options.credentials.loadCurrent?.(account.id) ??
      this.options.credentials.load(account.id));
    this.settings(input);
    const current = this.decryptedRoute({ ...input, ...input.selection }, envelope);
    return {
      instanceId: input.instanceId,
      contextId: input.contextId,
      selection: input.selection,
      bindingRevision: input.expectedBindingRevision,
      settingsRevision: input.expectedSettingsRevision,
      operation: input.operation,
      consumedParameters: [],
      ...inference.preview(
        current.account,
        current.route,
        input.selection.modelId,
        parameters,
        this.options.connectionProviders,
      ),
    };
  }
}
