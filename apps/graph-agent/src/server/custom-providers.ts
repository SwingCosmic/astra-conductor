import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  parseProviderDraft,
  providerSlug,
  customRevision,
  type CustomProvider,
  type CustomProviderDraft,
  type CustomProviderReference,
  type BindCustomAccount,
  type ModelRoute,
  type ModelRouteInput,
} from "@astra-conductor/contract/graph-agent";
import { AppError } from "@astra-conductor/core/internal";

interface StoredOffering {
  offeringId: string;
  name: string;
  routes: ModelRoute[];
}
interface ProviderRow {
  provider_id: string;
  name: string;
  icon: string | null;
  revision: number;
  offerings_json: string;
  creation_hash: string;
  operation_id: string;
}
function dto(row: ProviderRow): CustomProvider {
  const offerings = JSON.parse(row.offerings_json) as StoredOffering[];
  return {
    providerId: row.provider_id,
    name: row.name,
    icon: row.icon,
    revision: row.revision,
    offerings: offerings.map((o) => ({
      ...o,
      routes: o.routes.map(({ bindingRevision: _, ...r }) => r),
    })),
  };
}
function revised(draft: CustomProviderDraft, previous: StoredOffering[] = []): StoredOffering[] {
  return draft.offerings.map((o) => ({
    ...o,
    routes: o.routes.map((route: ModelRouteInput) => {
      const old = previous
        .find((x) => x.offeringId === o.offeringId)
        ?.routes.find((x) => x.protocolRouteId === route.protocolRouteId);
      return {
        ...route,
        protocolVersion: route.protocolVersion ?? null,
        bindingRevision:
          old &&
          old.baseUrl === route.baseUrl &&
          old.protocolVersion === (route.protocolVersion ?? null)
            ? old.bindingRevision
            : randomUUID(),
      };
    }),
  }));
}

export class CustomProviders {
  constructor(
    private readonly db: Database.Database,
    private readonly changed: () => void,
  ) {}
  private row(id: string) {
    return this.db
      .prepare("SELECT * FROM custom_providers WHERE provider_id=?")
      .get(providerSlug(id)) as ProviderRow | undefined;
  }
  routes(providerId: string, offeringId: string): ModelRoute[] | undefined {
    const row = this.row(providerId);
    return (
      row &&
      (JSON.parse(row.offerings_json) as StoredOffering[]).find((o) => o.offeringId === offeringId)
        ?.routes
    );
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
        .prepare("INSERT INTO custom_providers VALUES (?,?,?,?,1,?,?)")
        .run(id, draft.name, draft.icon, JSON.stringify(revised(draft)), requestKey, hash);
      return dto(this.row(id)!);
    })();
    this.changed();
    return result;
  }
  edit(id: string, expected: number, value: unknown): CustomProvider {
    const draft = parseProviderDraft(value);
    const result = this.db.transaction(() => {
      const row = this.row(id);
      if (!row) throw new AppError("not-found", "供应商不存在");
      if (row.revision !== customRevision(expected))
        throw new AppError("conflict", "供应商配置已更新，请重读");
      const offerings = revised(draft, JSON.parse(row.offerings_json));
      if (
        this.references(id).some((ref) => !offerings.some((o) => o.offeringId === ref.offeringId))
      )
        throw new AppError("conflict", "被账号引用的接入点需要先移走或解绑账号");
      this.db
        .prepare(
          "UPDATE custom_providers SET name=?,icon=?,offerings_json=?,revision=revision+1 WHERE provider_id=?",
        )
        .run(draft.name, draft.icon, JSON.stringify(offerings), id);
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
