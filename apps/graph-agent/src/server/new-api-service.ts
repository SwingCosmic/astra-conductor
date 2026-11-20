import type {
  NewApiAccountRequest,
  NewApiOfferingRequest,
  NewApiOfferingKeysRequest,
  NewApiCreateAccountRequest,
  NewApiKeyPage,
  NewApiListKeysRequest,
  NewApiSelectKeyRequest,
  NewApiUsage,
  ModelRouteSummary,
} from "@astra-conductor/contract/graph-agent";
import {
  AppError,
  readModelJson,
  type Account,
  type CommonProviderApplicationService,
  type CredentialMutationGate,
  type HttpPort,
  type SwitchingCredentialService,
} from "@astra-conductor/core/internal";
import type { CustomProviders } from "./custom-providers.js";
import type { GraphModelService } from "./model-service.js";

interface SiteCall {
  site: string;
  signal: AbortSignal;
  check(): void;
}
interface Options {
  providers: Pick<
    CommonProviderApplicationService,
    | "assertContext"
    | "getBackend"
    | "getSnapshot"
    | "editConnection"
    | "createConnection"
    | "getConnection"
  >;
  sites: Pick<CustomProviders, "newApiSite" | "revision" | "withNewApiSite" | "routes">;
  credentials: Pick<SwitchingCredentialService, "loadCurrent" | "recordRevision">;
  mutations: CredentialMutationGate;
  account(id: string): Account | null;
  reserveCreation(
    input: NewApiCreateAccountRequest,
    site: string,
  ): {
    accountId: string;
    operationId: string;
    knownAccount: boolean;
  };
  retireCatalogs(input: NewApiAccountRequest, routes: ModelRouteSummary[]): void;
  visible(): ReadonlySet<string> | null;
  watch: GraphModelService["watchCall"];
  http: HttpPort;
}

function stale(): never {
  throw new AppError("stale-binding", "账号、凭据或 New API 站点已变更，请重新读取");
}
function invalid(): never {
  throw new AppError("upstream", "New API 站点未返回有效数据，请检查站点版本和访问权限");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
function usage(result: Record<string, unknown>): NewApiUsage {
  if (result.code !== true) return invalid();
  const data = record(result.data);
  if (data.object !== "token_usage") return invalid();
  const user = data.user_quota == null ? null : record(data.user_quota);
  return {
    totalGranted: integer(data.total_granted),
    totalUsed: integer(data.total_used),
    totalAvailable: integer(data.total_available),
    unlimitedQuota: typeof data.unlimited_quota === "boolean" ? data.unlimited_quota : null,
    expiresAt: integer(data.expires_at),
    userQuota: user && {
      totalUsed: integer(user.total_used),
      totalAvailable: integer(user.total_available),
    },
  };
}

const pageSize = 20;
function keyPage(result: Record<string, unknown>, page: number, secrets: string[]): NewApiKeyPage {
  if (result.success !== true) return invalid();
  const data = record(result.data);
  const total = integer(data.total);
  if (
    data.page !== page ||
    data.page_size !== pageSize ||
    total === null ||
    total < 0 ||
    !Array.isArray(data.items) ||
    data.items.length > pageSize
  )
    return invalid();
  const label = (value: unknown, fieldKey: unknown) => {
    if (
      typeof value !== "string" ||
      value.length > 128 ||
      /[\x00-\x1f\x7f]/.test(value) ||
      /(?:sk-|nap_)[a-z\d_-]+/i.test(value) ||
      secrets.some((key) => key && value.includes(key)) ||
      (typeof fieldKey === "string" && fieldKey && value.includes(fieldKey))
    )
      return "";
    return value;
  };
  return {
    page,
    pageSize,
    total,
    items: data.items.map((value) => {
      const item = record(value);
      const id = integer(item.id);
      if (id === null || id < 1) return invalid();
      return {
        id,
        name: label(item.name, item.key),
        group: label(item.group, item.key),
        status: integer(item.status),
        expiresAt: integer(item.expired_time),
      };
    }),
  };
}

export class NewApiService {
  constructor(private readonly options: Options) {}

  private site(input: NewApiOfferingRequest) {
    const { providers, sites, mutations } = this.options;
    providers.assertContext(input);
    mutations.assertAvailable();
    if (providers.getBackend().active === "unavailable") return stale();
    const site = sites.newApiSite(input.providerId, input.offeringId);
    if (!site || sites.revision(input.providerId) !== input.expectedProviderRevision)
      return stale();
    const routes = sites.routes(input.providerId, input.offeringId);
    if (!routes?.length || routes.some((route) => route.baseUrl !== site + "/v1"))
      throw new AppError("validation", "New API 接入点的所有推理路由必须使用本站的 /v1 地址");
    const url = new URL(site);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "localhost" ||
          url.hostname === "[::1]" ||
          /^127(?:\.\d{1,3}){3}$/.test(url.hostname))
      )
    )
      throw new AppError("validation", "New API 凭据请求需要 HTTPS 或本机回环地址");
    return site;
  }
  private bound(input: NewApiAccountRequest) {
    const account = this.options.account(input.accountId);
    if (
      !account ||
      this.options.visible()?.has(input.accountId) === false ||
      !account.enabled ||
      account.credentialState !== "available" ||
      account.authMethod !== "api-key" ||
      account.provider !== input.providerId ||
      account.offeringId !== input.offeringId
    )
      return stale();
    return { account, revision: this.options.credentials.recordRevision(account.id) };
  }

  private atSite<T>(
    input: NewApiOfferingRequest,
    signal: AbortSignal,
    operation: (state: SiteCall) => Promise<T>,
    checkBinding?: () => void,
  ): Promise<T> {
    return this.options.mutations.run(async () => {
      const site = this.site(input);
      const stop = new AbortController();
      const combined = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(20_000)]);
      const check = () => {
        if (combined.aborted)
          throw stop.signal.reason instanceof AppError
            ? stop.signal.reason
            : new AppError("network", "New API 请求已取消或超时", true);
        if (this.site(input) !== site) stale();
        checkBinding?.();
      };
      const unwatch = this.options.watch(check, (error) => stop.abort(error));
      try {
        check();
        return await operation({ site, signal: combined, check });
      } catch (error) {
        if (combined.aborted) check();
        throw error;
      } finally {
        unwatch();
      }
    });
  }

  private async run<T>(
    input: NewApiAccountRequest,
    editing: boolean,
    signal: AbortSignal,
    operation: (
      state: SiteCall & { key: string; displayName: string; routes: ModelRouteSummary[] },
    ) => Promise<T>,
  ): Promise<T> {
    const { account, revision } = this.bound(input);
    const checkBinding = () => {
      const now = this.bound(input);
      if (
        now.account.updatedAt !== account.updatedAt ||
        now.revision !== revision ||
        now.account.publicMetadata.credentialBindingRevision !==
          account.publicMetadata.credentialBindingRevision
      )
        stale();
    };
    return this.atSite(
      input,
      signal,
      async (call) => {
        const snapshot = await this.options.providers.getSnapshot();
        const connection = snapshot.connections.find((row) => row.accountId === input.accountId);
        if (
          !connection?.routes?.length ||
          connection.recordRevision !== input.expectedRecordRevision
        )
          stale();
        if (editing && connection.actions.editConnection?.state !== "enabled")
          throw new AppError("permission", "当前账号不允许切换 API Key");
        call.check();
        const envelope = await this.options.credentials.loadCurrent(account.id);
        call.check();
        const key = envelope.secrets.apiKey;
        if (
          envelope.accountId !== account.id ||
          envelope.provider !== account.provider ||
          envelope.authMethod !== "api-key" ||
          !key ||
          !envelope.credentialBindingRevision ||
          envelope.credentialBindingRevision !== account.publicMetadata.credentialBindingRevision
        )
          return stale();
        return operation({
          ...call,
          key,
          displayName: account.displayName,
          routes: connection.routes,
        });
      },
      checkBinding,
    );
  }

  private async request(url: string, method: "GET" | "POST", token: string, signal: AbortSignal) {
    let response: Response;
    try {
      response = await this.options.http.fetch(url, {
        method,
        signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      });
    } catch {
      throw new AppError("network", "New API 站点请求失败，请检查连接", true);
    }
    if (!response.ok || response.redirected) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403)
        throw new AppError("permission", "New API 站点拒绝凭据或权限不足");
      if (response.status === 404 || response.status === 405)
        throw new AppError("capability-unavailable", "该中转站未开放此接口");
      if (response.status === 429)
        throw new AppError("rate-limit", "New API 站点请求过于频繁", true);
      return invalid();
    }
    return record(await readModelJson(response, 256 * 1024, invalid));
  }

  getUsage(input: NewApiAccountRequest, signal: AbortSignal) {
    return this.run(input, false, signal, async ({ site, key, signal, check }) => {
      const result = await this.request(site + "/api/usage/token/", "GET", key, signal);
      check();
      return usage(result);
    });
  }
  listKeys(input: NewApiListKeysRequest, signal: AbortSignal) {
    return this.run(input, true, signal, (state) =>
      this.listPage(state, input, [state.key, state.key.replace(/^sk-/, "")]),
    );
  }
  private async listPage(call: SiteCall, input: NewApiOfferingKeysRequest, secrets: string[] = []) {
    const result = await this.request(
      call.site + "/api/token/?p=" + input.page + "&page_size=" + pageSize,
      "GET",
      input.accessToken,
      call.signal,
    );
    call.check();
    return keyPage(result, input.page, [input.accessToken, ...secrets]);
  }
  private async reveal(call: SiteCall, input: { tokenId: number; accessToken: string }) {
    const result = await this.request(
      call.site + "/api/token/" + input.tokenId + "/key",
      "POST",
      input.accessToken,
      call.signal,
    );
    call.check();
    if (result.success !== true) return invalid();
    const secret = record(result.data).key;
    if (typeof secret !== "string") return invalid();
    const raw = secret.replace(/^sk-/, "");
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,4092}$/.test(raw) ||
      raw.startsWith("nap_") ||
      raw === input.accessToken ||
      secret === input.accessToken
    )
      return invalid();
    return "sk-" + raw;
  }
  private async allowCreate(call: SiteCall) {
    const snapshot = await this.options.providers.getSnapshot();
    call.check();
    if (snapshot.actions.createConnection.state !== "enabled")
      throw new AppError("permission", "当前凭据后端不允许创建账号");
  }
  listOfferingKeys(input: NewApiOfferingKeysRequest, signal: AbortSignal) {
    return this.atSite(input, signal, async (call) => {
      await this.allowCreate(call);
      return this.listPage(call, input);
    });
  }
  createAccountWithKey(input: NewApiCreateAccountRequest, signal: AbortSignal) {
    return this.atSite(input, signal, async (call) => {
      await this.allowCreate(call);
      const reservation = this.options.reserveCreation(input, call.site);
      const existing = async () => {
        const account = this.options.account(reservation.accountId);
        if (
          !account ||
          account.provider !== input.providerId ||
          account.offeringId !== input.offeringId ||
          this.options.visible()?.has(account.id) === false
        )
          throw new AppError("conflict", "该创建操作所属账号已删除、已解绑或不可访问");
        const connection = await this.options.providers.getConnection(account.id);
        call.check();
        return connection;
      };
      if (reservation.knownAccount) return existing();
      const apiKey = await this.reveal(call, input);
      if (input.displayName.includes(apiKey.slice(3)))
        throw new AppError("validation", "账号名称不能包含 API Key");
      return this.options.sites.withNewApiSite(input.providerId, async () => {
        await this.allowCreate(call);
        if (this.options.reserveCreation(input, call.site).knownAccount) return existing();
        return this.options.providers.createConnection({
          providerId: input.providerId,
          offeringId: input.offeringId,
          displayName: input.displayName,
          operationId: reservation.operationId,
          routes: [],
          apiKey,
        });
      });
    });
  }
  selectKey(input: NewApiSelectKeyRequest, signal: AbortSignal) {
    return this.run(input, true, signal, async (call) => {
      const apiKey = await this.reveal(call, input);
      const { check, displayName, routes } = call;
      await this.options.sites.withNewApiSite(input.providerId, async () => {
        check();
        const saved = await this.options.providers.editConnection(input.accountId, {
          providerId: input.providerId,
          offeringId: input.offeringId,
          displayName,
          expectedRecordRevision: input.expectedRecordRevision,
          routes: [],
          apiKey,
        });
        const active = new Set(saved.routes.map((r) => r.bindingRevision));
        this.options.retireCatalogs(
          input,
          routes.filter((r) => !active.has(r.bindingRevision)),
        );
      });
    });
  }
}
