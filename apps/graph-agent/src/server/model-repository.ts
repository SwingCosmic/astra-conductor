import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  EndpointProtocol,
  ModelOverrides,
  ModelType,
  RateCard,
} from "@astra-conductor/contract/graph-agent";
import { AppError, type DiscoveredModel } from "@astra-conductor/core/internal";
import { bundledModelPack, validateModelPack, type ValidatedPack } from "./model-pack.js";

export const modelSchema = `
CREATE TABLE model_packs (revision TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, digest TEXT NOT NULL, content_json TEXT NOT NULL);
CREATE TABLE model_catalogs (visibility_ref TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE, offering_id TEXT NOT NULL, route_id TEXT NOT NULL, binding_revision TEXT NOT NULL, retrieved_at TEXT NOT NULL, catalog_revision TEXT NOT NULL, entries_json TEXT NOT NULL, PRIMARY KEY(visibility_ref,account_id,offering_id,route_id,binding_revision));
CREATE TABLE model_configs (id INTEGER PRIMARY KEY, provider_id TEXT NOT NULL, offering_id TEXT NOT NULL, route_id TEXT NOT NULL, upstream_model_id TEXT NOT NULL, account_id TEXT REFERENCES accounts(account_id) ON DELETE CASCADE, account_identity TEXT, model_type TEXT NOT NULL, config_json TEXT NOT NULL);
CREATE UNIQUE INDEX model_configs_offering ON model_configs(provider_id,offering_id,route_id,upstream_model_id) WHERE account_id IS NULL;
CREATE UNIQUE INDEX model_configs_account ON model_configs(account_id,provider_id,offering_id,route_id,upstream_model_id) WHERE account_id IS NOT NULL;
CREATE TABLE model_rate_cards (rate_card_id TEXT NOT NULL, revision TEXT NOT NULL, card_json TEXT NOT NULL,PRIMARY KEY(rate_card_id,revision));
CREATE TABLE model_state (id INTEGER PRIMARY KEY CHECK(id=1), settings_revision TEXT NOT NULL, active_pack TEXT NOT NULL REFERENCES model_packs(revision),previous_pack TEXT REFERENCES model_packs(revision), selected_config_id INTEGER REFERENCES model_configs(id) ON DELETE SET NULL, operation_id TEXT, profile_id TEXT,binding_revision TEXT);
`;

export interface CatalogKey {
  providerId: string;
  accountId: string;
  offeringId: string;
  protocolFamily: string;
  visibilityRef: string;
  familyBindingRevision: string;
}
export interface RemoteCatalog {
  revision: string;
  fetchedAt: string;
  entries: DiscoveredModel[];
}
export interface ConfigKey {
  providerId: string;
  offeringId: string;
  protocol: EndpointProtocol;
  modelId: string;
  accountId: string | null;
}
export interface ModelConfigDocument {
  displayName?: string;
  manualBinding?: { visibilityRef: string; revision: string };
  operations: Record<
    string,
    Omit<ModelOverrides, "rateCard"> & {
      updatedAt: string;
      revision: string;
      stamps?: Record<string, { revision: string; updatedAt: string }>;
      cardRefs?: Record<string, [string, string]>;
      planPrices?: Record<string, ModelOverrides["prices"]>;
    }
  >;
}
export interface ConfigRow extends ConfigKey {
  id: number;
  accountIdentity: string | null;
  modelType: ModelType;
  document: ModelConfigDocument;
}
interface ConfigRecord extends Omit<ConfigRow, "document"> {
  configJson: string;
}
const columns = `id,provider_id AS providerId,offering_id AS offeringId,route_id AS protocol,upstream_model_id AS modelId,account_id AS accountId,account_identity AS accountIdentity,model_type AS modelType,config_json AS configJson`;
const predicate = `provider_id=@providerId AND offering_id=@offeringId AND route_id=@protocol AND upstream_model_id=@modelId AND account_id IS @accountId`;
function config(row: ConfigRecord): ConfigRow {
  const { configJson, ...values } = row;
  return { ...values, document: JSON.parse(configJson) as ModelConfigDocument };
}
export interface ModelState {
  revision: string;
  active: string;
  previous: string | null;
  selectedId: number | null;
  operation: string | null;
  ioProfile: string | null;
  bindingRevision: string | null;
}
export function settingsConflict(): never {
  throw new AppError("conflict", "配置修订已变更，请重新读取后再保存");
}
export const BUNDLED_PACK_TOKEN = "$bundled";

export class GraphModelRepository {
  private cachedPack?: ValidatedPack;
  constructor(private readonly db: Database.Database) {
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM model_state WHERE id=1").get()) return;
      this.db
        .prepare("INSERT INTO model_state(id,settings_revision,active_pack) VALUES(1,?,?)")
        .run("0", BUNDLED_PACK_TOKEN);
    })();
  }
  private rawState(): ModelState {
    return this.db
      .prepare(
        `SELECT settings_revision AS revision,active_pack AS active,previous_pack AS previous,selected_config_id AS selectedId,operation_id AS operation,profile_id AS ioProfile,binding_revision AS bindingRevision FROM model_state WHERE id=1`,
      )
      .get() as ModelState;
  }
  state(): ModelState {
    const raw = this.rawState();
    const bundledRevision = bundledModelPack().document.revision;
    return {
      ...raw,
      active: raw.active === BUNDLED_PACK_TOKEN ? bundledRevision : raw.active,
      previous: raw.previous === BUNDLED_PACK_TOKEN ? bundledRevision : raw.previous,
    };
  }
  activePack(active = this.state().active): ValidatedPack {
    const bundled = bundledModelPack();
    if (active === BUNDLED_PACK_TOKEN || active === bundled.document.revision) {
      return bundled;
    }
    if (this.cachedPack?.document.revision !== active) {
      const row = this.db
        .prepare("SELECT digest,content_json FROM model_packs WHERE revision=?")
        .get(active) as { digest: string; content_json: string } | undefined;
      if (!row) return bundled;
      const pack = validateModelPack(JSON.parse(row.content_json));
      if (pack.document.revision !== active || pack.digest !== row.digest)
        throw new AppError("storage", "业务库的活动预置与保存的修订或摘要不符");
      this.cachedPack = pack;
    }
    return this.cachedPack;
  }
  private savePack(pack: ValidatedPack): string {
    const bundled = bundledModelPack();
    const { revision } = pack.document;
    if (revision === bundled.document.revision) {
      if (pack.digest !== bundled.digest)
        throw new AppError("validation", "此预置修订已存在且内容不同");
      return BUNDLED_PACK_TOKEN;
    }
    const old = this.db.prepare("SELECT digest FROM model_packs WHERE revision=?").get(revision) as
      | { digest: string }
      | undefined;
    if (old && old.digest !== pack.digest)
      throw new AppError("validation", "此预置修订已存在且内容不同");
    if (!old)
      this.db
        .prepare("INSERT INTO model_packs VALUES(?,?,?,?)")
        .run(revision, 2, pack.digest, JSON.stringify(pack.document));
    return revision;
  }
  activate(pack?: ValidatedPack) {
    const state = this.rawState();
    const nextToken = pack ? this.savePack(pack) : state.previous;
    if (!nextToken) throw new AppError("not-found", "没有可回滚的预置清单");
    if (nextToken !== state.active)
      this.db
        .prepare("UPDATE model_state SET previous_pack=active_pack,active_pack=? WHERE id=1")
        .run(nextToken);
  }
  simulate<T>(readCandidate: () => T): T {
    this.db.exec("SAVEPOINT model_preview");
    try {
      return readCandidate();
    } finally {
      this.db.exec("ROLLBACK TO model_preview; RELEASE model_preview");
    }
  }
  edit(revision: string, mutation: () => void) {
    this.db
      .transaction(() => {
        if (this.state().revision !== revision) settingsConflict();
        mutation();
        this.db.prepare("UPDATE model_state SET settings_revision=? WHERE id=1").run(randomUUID());
      })
      .immediate();
  }
  getCatalog(key: CatalogKey): RemoteCatalog | undefined {
    const row = this.db
      .prepare(
        `SELECT catalog_revision AS revision,retrieved_at AS fetchedAt,entries_json AS json FROM model_catalogs WHERE visibility_ref=@visibilityRef AND provider_id=@providerId AND account_id=@accountId AND offering_id=@offeringId AND protocol_family_id=@protocolFamily AND family_binding_revision=@familyBindingRevision`,
      )
      .get(key) as { revision: string; fetchedAt: string; json: string } | undefined;
    if (row)
      return { revision: row.revision, fetchedAt: row.fetchedAt, entries: JSON.parse(row.json) };
  }
  removeCatalogs(keys: CatalogKey[]) {
    if (!keys.length) return;
    const remove = this.db.prepare(
      "DELETE FROM model_catalogs WHERE visibility_ref=@visibilityRef AND provider_id=@providerId AND account_id=@accountId AND offering_id=@offeringId AND protocol_family_id=@protocolFamily AND family_binding_revision=@familyBindingRevision",
    );
    this.db.transaction(() => {
      for (const key of keys) remove.run(key);
    })();
  }
  saveCatalog(key: CatalogKey, entries: DiscoveredModel[]) {
    this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM model_catalogs WHERE visibility_ref=@visibilityRef AND provider_id=@providerId AND account_id=@accountId AND offering_id=@offeringId AND protocol_family_id=@protocolFamily`,
        )
        .run(key);
      this.db
        .prepare(
          "INSERT INTO model_catalogs VALUES(@visibilityRef,@providerId,@offeringId,@accountId,@protocolFamily,@familyBindingRevision,@now,@revision,@entries)",
        )
        .run({
          ...key,
          now: new Date().toISOString(),
          revision: randomUUID(),
          entries: JSON.stringify(entries),
        });
    })();
  }
  get(key: ConfigKey): ConfigRow | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM model_configs WHERE ${predicate}`)
      .get(key) as ConfigRecord | undefined;
    return row && config(row);
  }
  byId(id: number | null): ConfigRow | undefined {
    if (id === null) return;
    const row = this.db.prepare(`SELECT ${columns} FROM model_configs WHERE id=?`).get(id) as
      | ConfigRecord
      | undefined;
    return row && config(row);
  }
  list(
    providerId: string,
    offeringId: string,
    protocol: EndpointProtocol,
    accountId: string | null,
  ): ConfigRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${columns} FROM model_configs WHERE provider_id=? AND offering_id=? AND route_id=? AND account_id IS ?`,
        )
        .all(providerId, offeringId, protocol, accountId) as ConfigRecord[]
    ).map(config);
  }
  publicRoutes() {
    return this.db
      .prepare(
        "SELECT DISTINCT provider_id AS providerId,offering_id AS offeringId,route_id AS protocol FROM model_configs WHERE account_id IS NULL",
      )
      .all() as Array<{ providerId: string; offeringId: string; protocol: EndpointProtocol }>;
  }
  save(
    key: ConfigKey,
    accountIdentity: string | null,
    modelType: ModelType,
    document: ModelConfigDocument,
  ): number {
    const existing = this.get(key);
    if (existing && existing.accountIdentity !== accountIdentity)
      throw new AppError("conflict", "保存配置的账号身份与当前账号不符");
    const json = JSON.stringify(document);
    if (existing) {
      this.db
        .prepare("UPDATE model_configs SET model_type=?,config_json=? WHERE id=?")
        .run(modelType, json, existing.id);
      return existing.id;
    }
    return Number(
      this.db
        .prepare(
          "INSERT INTO model_configs(provider_id,offering_id,route_id,upstream_model_id,account_id,account_identity,model_type,config_json) VALUES(@providerId,@offeringId,@protocol,@modelId,@accountId,@accountIdentity,@modelType,@json)",
        )
        .run({ ...key, accountIdentity, modelType, json }).lastInsertRowid,
    );
  }
  remove(id: number) {
    this.db.prepare("DELETE FROM model_configs WHERE id=?").run(id);
  }
  select(
    id: number | null,
    operation: string | null,
    profile: string | null,
    binding: string | null,
  ) {
    this.db
      .prepare(
        "UPDATE model_state SET selected_config_id=?,operation_id=?,profile_id=?,binding_revision=? WHERE id=1",
      )
      .run(id, operation, profile, binding);
  }
  card(ref?: [string, string]): RateCard | undefined {
    if (!ref) return;
    const row = this.db
      .prepare("SELECT card_json FROM model_rate_cards WHERE rate_card_id=? AND revision=?")
      .get(...ref) as { card_json: string } | undefined;
    return row && (JSON.parse(row.card_json) as RateCard);
  }
  saveCard(card: RateCard): [string, string] {
    const old = this.card([card.rateCardId, card.revision]);
    if (old && JSON.stringify(old) !== JSON.stringify(card))
      card = { ...card, revision: randomUUID() };
    this.db
      .prepare("INSERT OR IGNORE INTO model_rate_cards VALUES(?,?,?)")
      .run(card.rateCardId, card.revision, JSON.stringify(card));
    return [card.rateCardId, card.revision];
  }
}
