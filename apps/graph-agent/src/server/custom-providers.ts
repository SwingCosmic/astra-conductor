import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  parseProviderDraft,
  providerSlug,
  customRevision,
  modelEndpointDescriptor,
  endpointProtocols,
  familyVersion,
  type EndpointProtocol,
  type ProtocolFamily,
  type CustomProvider,
  type CustomProviderDraft,
  type CustomProviderReference,
  type BindCustomAccount,
  type ModelRoute,
  type ModelRouteInput,
} from "@astra-conductor/contract/graph-agent";
import { AppError, computeFamilyBindingRevision } from "@astra-conductor/core/internal";

interface StoredOffering {
  offeringId: string;
  name: string;
  siteBaseUrl?: string;
  routes: (ModelRoute & { protocolRouteId?: EndpointProtocol })[];
  familyRevisions?: Partial<Record<ProtocolFamily, string>>;
}
interface ProviderRow {
  provider_id: string;
  template_kind: CustomProvider["templateKind"];
  name: string;
  icon: string | null;
  revision: number;
  offerings_json: string;
  creation_hash: string;
  family_policies_json: string;
  operation_id: string;
}
function normalizeStoredRoute(
  route: ModelRoute & { protocolRouteId?: EndpointProtocol },
): ModelRoute {
  if (route.protocol) {
    const { protocolRouteId: _, ...clean } = route;
    return clean;
  }
  const { protocolRouteId, ...rest } = route;
  return { ...rest, protocol: protocolRouteId! };
}
function dto(row: ProviderRow): CustomProvider {
  const offerings = JSON.parse(row.offerings_json) as StoredOffering[];
  const policies = JSON.parse(row.family_policies_json);
  return {
    providerId: row.provider_id,
    templateKind: row.template_kind,
    name: row.name,
    icon: row.icon,
    ...(Object.keys(policies).length && { familyPolicies: policies }),
    revision: row.revision,
    offerings: offerings.map(({ familyRevisions: _, ...o }) => ({
      ...o,
      routes: o.routes.map((r) => {
        const { bindingRevision: _, ...rest } = normalizeStoredRoute(r);
        return rest;
      }),
    })),
  };
}
function revised(
  providerId: string,
  draft: CustomProviderDraft,
  previous: StoredOffering[] = [],
  previousPolicies: CustomProviderDraft["familyPolicies"] = {},
): StoredOffering[] {
  return draft.offerings.map((o) => {
    const before = previous.find((x) => x.offeringId === o.offeringId);
    const beforeRoutes = before?.routes.map(normalizeStoredRoute);
    const familyRevisions: StoredOffering["familyRevisions"] = {};
    for (const route of o.routes) {
      const family = modelEndpointDescriptor(route.protocol).protocolFamily;
      if (familyRevisions[family]) continue;
      const old = beforeRoutes?.filter(
        (r) =>
          endpointProtocols.includes(r.protocol) &&
          modelEndpointDescriptor(r.protocol).protocolFamily === family,
      );
      const same =
        before?.siteBaseUrl === o.siteBaseUrl &&
        old?.length &&
        old.every(
          (r) => r.baseUrl === route.baseUrl && familyVersion(r) === familyVersion(route),
        ) &&
        JSON.stringify(previousPolicies[family]) === JSON.stringify(draft.familyPolicies?.[family]);
      familyRevisions[family] = same
        ? storedFamilyRevision(providerId, before!, family)
        : randomUUID();
    }
    return {
      ...o,
      familyRevisions,
      routes: o.routes.map((route: ModelRouteInput) => {
        const family = modelEndpointDescriptor(route.protocol).protocolFamily;
        const old = beforeRoutes?.find((r) => r.protocol === route.protocol);
        const chatOutputLimitField =
          route.protocol === "openai-chat"
            ? (route.chatOutputLimitField ?? old?.chatOutputLimitField ?? "max_completion_tokens")
            : undefined;
        return {
          ...route,
          ...(chatOutputLimitField && { chatOutputLimitField }),
          protocolVersion: route.protocolVersion ?? null,
          bindingRevision:
            old &&
            before &&
            familyRevisions[family] === storedFamilyRevision(providerId, before, family) &&
            old.baseUrl === route.baseUrl &&
            JSON.stringify(old.requestRule) === JSON.stringify(route.requestRule) &&
            old.chatOutputLimitField === chatOutputLimitField &&
            old.protocolVersion === (route.protocolVersion ?? null)
              ? old.bindingRevision
              : randomUUID(),
        };
      }),
    };
  });
}
function storedFamilyRevision(
  providerId: string,
  offering: StoredOffering,
  family: ProtocolFamily,
): string {
  if (offering.familyRevisions?.[family]) return offering.familyRevisions[family]!;
  const peers = offering.routes
    .map(normalizeStoredRoute)
    .filter(
      (r) =>
        endpointProtocols.includes(r.protocol) &&
        modelEndpointDescriptor(r.protocol).protocolFamily === family,
    );
  const first = peers[0];
  return computeFamilyBindingRevision({
    accountId: "",
    providerId,
    offeringId: offering.offeringId,
    protocolFamily: family,
    baseUrl: first?.baseUrl ?? "",
    protocolVersion: first ? familyVersion(first) : "",
    endpointRevisions: peers.map((r) => `${r.protocol}:${r.bindingRevision}`),
    credentialRevision: "",
  });
}

export class CustomProviders {
  private readonly pendingSiteUpdates = new Set<string>();
  constructor(
    private readonly db: Database.Database,
    private readonly changed: () => void,
  ) {}
  private row(id: string) {
    return this.db
      .prepare("SELECT * FROM custom_providers WHERE provider_id=?")
      .get(providerSlug(id)) as ProviderRow | undefined;
  }
  templateKind(providerId: string): CustomProvider["templateKind"] | undefined {
    return this.row(providerId)?.template_kind;
  }
  routes(providerId: string, offeringId: string): ModelRoute[] | undefined {
    const row = this.row(providerId);
    if (!row) return undefined;
    const offering = (JSON.parse(row.offerings_json) as StoredOffering[]).find(
      (o) => o.offeringId === offeringId,
    );
    if (!offering) return undefined;
    const policies = JSON.parse(row.family_policies_json) as NonNullable<
      CustomProviderDraft["familyPolicies"]
    >;
    return offering.routes
      .map(normalizeStoredRoute)
      .filter((r) => endpointProtocols.includes(r.protocol))
      .map((route) => {
        const family = modelEndpointDescriptor(route.protocol).protocolFamily;
        return {
          ...route,
          familyBindingRevision: storedFamilyRevision(providerId, offering, family),
          ...(policies[family] && { familyPolicy: policies[family] }),
        };
      });
  }
  newApiSite(providerId: string, offeringId: string): string | undefined {
    const row = this.row(providerId);
    if (row?.template_kind !== "new-api") return undefined;
    return (JSON.parse(row.offerings_json) as StoredOffering[]).find(
      (o) => o.offeringId === offeringId,
    )?.siteBaseUrl;
  }
  revision(providerId: string): number | undefined {
    return this.row(providerId)?.revision;
  }
  private assertSiteAvailable(id: string) {
    if (this.pendingSiteUpdates.has(id))
      throw new AppError("conflict", "供应商正在更新凭据，请稍后重试");
  }
  async withNewApiSite<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.assertSiteAvailable(id);
    this.pendingSiteUpdates.add(id);
    try {
      return await operation();
    } finally {
      this.pendingSiteUpdates.delete(id);
    }
  }
  list(): CustomProvider[] {
    return (
      this.db
        .prepare("SELECT * FROM custom_providers ORDER BY name,provider_id")
        .all() as ProviderRow[]
    ).map(dto);
  }
  create(value: unknown, operationId: unknown, verifiedProviderId?: string): CustomProvider {
    if (typeof operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(operationId))
      throw new AppError("validation", "创建操作标识无效");
    const draft = parseProviderDraft(value);
    const requestKey = (verifiedProviderId ? "restore:" : "create:") + operationId;
    const hash = createHash("sha256").update(JSON.stringify(draft)).digest("hex");
    const result = this.db.transaction(() => {
      const prior = this.db
        .prepare("SELECT * FROM custom_providers WHERE operation_id=?")
        .get(requestKey) as ProviderRow | undefined;
      if (prior) {
        if (hash !== prior.creation_hash)
          throw new AppError("conflict", "同一操作标识已经用于其他配置");
        return dto(prior);
      }
      if (
        !verifiedProviderId &&
        this.db
          .prepare(
            "SELECT 1 FROM business_cache WHERE source='profile' AND kind='deleted-provider-create' AND entry_key=?",
          )
          .get(requestKey)
      )
        throw new AppError("conflict", "该创建操作对应的供应商已删除");
      const id = verifiedProviderId ?? "custom-" + randomUUID();
      if (verifiedProviderId && this.row(id))
        throw new AppError("conflict", "该供应商已有本地配置");
      this.db
        .prepare(
          `INSERT INTO custom_providers
          (provider_id,name,icon,offerings_json,revision,operation_id,creation_hash,template_kind,family_policies_json)
          VALUES (?,?,?,?,1,?,?,?,?)`,
        )
        .run(
          id,
          draft.name,
          draft.icon,
          JSON.stringify(revised(id, draft)),
          requestKey,
          hash,
          draft.templateKind ?? "generic",
          JSON.stringify(draft.familyPolicies ?? {}),
        );
      return dto(this.row(id)!);
    })();
    this.changed();
    return result;
  }
  edit(id: string, expected: number, value: unknown): CustomProvider {
    this.assertSiteAvailable(id);
    const result = this.db.transaction(() => {
      const row = this.row(id);
      if (!row) throw new AppError("not-found", "供应商不存在");
      if (row.revision !== customRevision(expected))
        throw new AppError("conflict", "供应商配置已更新，请重读");
      const draft = parseProviderDraft(value, dto(row));
      const offerings = revised(
        id,
        draft,
        JSON.parse(row.offerings_json),
        JSON.parse(row.family_policies_json),
      );
      if (
        this.references(id).some((ref) => !offerings.some((o) => o.offeringId === ref.offeringId))
      )
        throw new AppError("conflict", "被账号引用的接入点需要先移走或解绑账号");
      this.db
        .prepare(
          "UPDATE custom_providers SET name=?,icon=?,offerings_json=?,family_policies_json=?,revision=revision+1 WHERE provider_id=?",
        )
        .run(
          draft.name,
          draft.icon,
          JSON.stringify(offerings),
          JSON.stringify(draft.familyPolicies ?? {}),
          id,
        );
      return dto(this.row(id)!);
    })();
    this.changed();
    return result;
  }
  references(id: string): CustomProviderReference[] {
    providerSlug(id);
    return (
      this.db
        .prepare(
          `SELECT account_id AS accountId,display_name AS displayName,offering_id AS offeringId,enabled,'local-'||revision AS bindingRevision
      FROM accounts WHERE provider_id=? AND offering_id IS NOT NULL ORDER BY display_name,account_id`,
        )
        .all(id) as (Omit<CustomProviderReference, "enabled"> & { enabled: number })[]
    ).map((row) => ({ ...row, enabled: !!row.enabled }));
  }
  remove(id: string, expected: number): void {
    this.assertSiteAvailable(id);
    this.db.transaction(() => {
      const row = this.row(id);
      if (!row) throw new AppError("not-found", "供应商不存在");
      if (row.revision !== customRevision(expected))
        throw new AppError("conflict", "供应商配置已更新，请重读");
      if (this.references(id).length)
        throw new AppError("conflict", "供应商仍被账号引用，请先移走或解绑账号");
      if (row.operation_id.startsWith("create:"))
        this.db
          .prepare(
            "INSERT OR IGNORE INTO business_cache VALUES('profile','deleted-provider-create',?,?)",
          )
          .run(row.operation_id, JSON.stringify(id));
      this.db.prepare("DELETE FROM custom_providers WHERE provider_id=?").run(id);
    })();
    this.changed();
  }
  bind(input: BindCustomAccount): void {
    this.assertSiteAvailable(input.providerId);
    this.db.transaction(() => {
      const row = this.row(input.providerId);
      if (!row) throw new AppError("not-found", "供应商不存在");
      const account = this.db
        .prepare("SELECT provider_id,offering_id, revision FROM accounts WHERE account_id=?")
        .get(input.accountId) as
        | { provider_id: string; offering_id: string | null; revision: number }
        | undefined;
      if (!account || account.provider_id !== input.providerId)
        throw new AppError("conflict", "账号与凭据所属供应商不匹配");
      if (
        input.expectedRevision.startsWith("local-") &&
        input.expectedRevision !== "local-" + account.revision
      )
        throw new AppError("conflict", "账号绑定已更新");
      if (
        input.expectedOfferingId !== undefined &&
        (account.offering_id ?? "") !== input.expectedOfferingId
      )
        throw new AppError("conflict", "账号绑定已更新");
      if (input.offeringId && !this.routes(input.providerId, input.offeringId))
        throw new AppError("validation", "接入点不存在");
      this.db
        .prepare("UPDATE accounts SET offering_id=?,revision=revision+1 WHERE account_id=?")
        .run(input.offeringId, input.accountId);
    })();
    this.changed();
  }
}
