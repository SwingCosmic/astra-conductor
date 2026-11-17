import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppError,
  MemoryStorage,
  isMinimalAccountProjection,
  type Account,
  type StoragePort,
} from "@astra-conductor/core/internal";
import { GraphStorage } from "./storage.js";
import { GraphModelRepository, modelSchema } from "../server/model-repository.js";

const accountSchema = `
CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, stable_identity TEXT NOT NULL,
  auth_method TEXT NOT NULL, offering_id TEXT, display_name TEXT NOT NULL, enabled INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX accounts_provider ON accounts(provider_id,offering_id);
CREATE TABLE account_sources (
  source TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(account_id),
  observed_json TEXT NOT NULL, PRIMARY KEY(source, account_id)
);
CREATE TABLE business_cache (
  source TEXT NOT NULL, kind TEXT NOT NULL, entry_key TEXT NOT NULL, value_json TEXT NOT NULL,
  PRIMARY KEY(source,kind,entry_key)
);
CREATE TABLE custom_providers (
  provider_id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, offerings_json TEXT NOT NULL,
  revision INTEGER NOT NULL, operation_id TEXT UNIQUE NOT NULL, creation_hash TEXT NOT NULL
);`;

interface AccountRow {
  account_id: string;
  provider_id: string;
  stable_identity: string;
  auth_method: string;
  offering_id: string | null;
  display_name: string;
  enabled: number;
  observed_json: string;
}

export class GraphBusinessDatabase {
  readonly db: Database.Database;
  readonly models: GraphModelRepository;
  constructor(directory: string, nativeBinding?: string) {
    mkdirSync(directory, { recursive: true });
    const db = (this.db = new Database(path.join(directory, "graph-agent.sqlite3"), {
      nativeBinding:
        nativeBinding ??
        (process.versions.electron
          ? fileURLToPath(new URL("../../lib/better-sqlite3/better_sqlite3.node", import.meta.url))
          : undefined),
    }));
    try {
      db.pragma("foreign_keys = ON");
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      const migrations = [accountSchema, modelSchema];
      this.models = db.transaction(() => {
        db.exec(
          "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
        );
        const applied = db
          .prepare("SELECT version,checksum FROM schema_migrations ORDER BY version")
          .all() as { version: number; checksum: string }[];
        if (applied.length > migrations.length || applied.some((r, i) => r.version !== i + 1))
          throw new AppError("storage", "业务库版本不兼容");
        migrations.forEach((sql, index) => {
          const hash = createHash("sha256").update(sql).digest("hex");
          if (applied[index]) {
            if (applied[index].checksum !== hash)
              throw new AppError("storage", "业务库结构校验失败");
            return;
          }
          db.exec(sql);
          db.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(
            index + 1,
            hash,
            new Date().toISOString(),
          );
        });
        return new GraphModelRepository(db);
      })();
    } catch (error) {
      db.close();
      throw error;
    }
  }

  unlinkDeletedAccount(accountId: string): void {
    this.db
      .prepare(
        `UPDATE accounts SET offering_id=NULL,revision=revision+1
      WHERE account_id=? AND NOT EXISTS (SELECT 1 FROM account_sources WHERE account_id=?)`,
      )
      .run(accountId, accountId);
  }

  /** Accounts keep a profile identity and independent observations from each credential source. */
  source(
    source: string,
    auxiliary: StoragePort = new MemoryStorage(),
    privateVault = false,
  ): StoragePort {
    const db = this.db;
    const view =
      "SELECT a.*,s.observed_json FROM accounts a JOIN account_sources s USING(account_id) WHERE s.source=?";
    const rowToAccount = (row: AccountRow): Account => ({
      ...JSON.parse(row.observed_json),
      id: row.account_id,
      provider: row.provider_id,
      stableIdentity: row.stable_identity,
      authMethod: row.auth_method,
      displayName: row.display_name,
      offeringId: row.offering_id ?? "",
      enabled: !!row.enabled,
    });
    const get = (id: string) => {
      const row = db.prepare(view + " AND a.account_id=?").get(source, id) as
        | AccountRow
        | undefined;
      return row ? rowToAccount(row) : null;
    };
    const save = (account: Account) => {
      const current = db.prepare("SELECT * FROM accounts WHERE account_id=?").get(account.id) as
        | AccountRow
        | undefined;
      if (
        current &&
        (current.provider_id !== account.provider ||
          current.stable_identity !== account.stableIdentity ||
          current.auth_method !== account.authMethod)
      )
        throw new AppError("conflict", "同一记录 ID 的账号身份不一致");
      const fromMinimal = account.provider.startsWith("custom-") && !account.offeringId;
      const offering = (fromMinimal && current ? current.offering_id : account.offeringId) || null;
      if (account.provider.startsWith("custom-") && offering) {
        const binding = db
          .prepare(
            "SELECT 1 FROM custom_providers p, json_each(p.offerings_json) o WHERE p.provider_id=? AND json_extract(o.value,'$.offeringId')=?",
          )
          .get(account.provider, offering);
        if (!binding) throw new AppError("conflict", "自定义供应商或接入点已变更，请重新绑定账号");
      }
      const display =
        (fromMinimal || isMinimalAccountProjection(account)) && current
          ? current.display_name
          : account.displayName;
      const enabled = current ? current.enabled : Number(account.enabled);
      db.prepare(
        `INSERT INTO accounts(account_id,provider_id,stable_identity,auth_method,offering_id,display_name,enabled) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET offering_id=excluded.offering_id,display_name=excluded.display_name,revision=revision+1
        WHERE accounts.offering_id IS NOT excluded.offering_id OR accounts.display_name IS NOT excluded.display_name`,
      ).run(
        account.id,
        account.provider,
        account.stableIdentity,
        account.authMethod,
        offering,
        display,
        enabled,
      );
      const observed = {
        maskedIdentifier: account.maskedIdentifier,
        publicMetadata: account.publicMetadata,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
        credentialState: account.credentialState,
      };
      db.prepare(
        `INSERT INTO account_sources VALUES(?,?,?) ON CONFLICT(source,account_id) DO UPDATE SET
        observed_json=excluded.observed_json WHERE observed_json<>excluded.observed_json`,
      ).run(source, account.id, JSON.stringify(observed));
    };
    // Older private credential envelopes are still read through their owning vault. Model data has no legacy read path.
    const loadPrivateAccount = (id: string) => {
      const known = get(id);
      if (known || !privateVault) return known;
      const legacy = auxiliary.accounts.get(id);
      if (legacy) db.transaction(() => save(legacy))();
      return legacy;
    };
    const list = () => {
      if (privateVault)
        for (const legacy of auxiliary.accounts.list()) loadPrivateAccount(legacy.id);
      return (db.prepare(view + " ORDER BY a.account_id").all(source) as AccountRow[]).map(
        rowToAccount,
      );
    };
    const update = (id: string, patch: Partial<Account>) => {
      const account = loadPrivateAccount(id);
      if (!account) throw new AppError("not-found", "账号不存在");
      if (patch.enabled !== undefined)
        db.prepare("UPDATE accounts SET enabled=?,revision=revision+1 WHERE account_id=?").run(
          Number(patch.enabled),
          id,
        );
      save({ ...account, ...patch });
    };
    const cached = (kind: string, key: string) => {
      const row = db
        .prepare("SELECT value_json FROM business_cache WHERE source=? AND kind=? AND entry_key=?")
        .get(source, kind, key) as { value_json: string } | undefined;
      return row ? JSON.parse(row.value_json) : null;
    };
    const cache = (kind: string, key: string, value: unknown) => {
      db.prepare(
        "INSERT INTO business_cache VALUES(?,?,?,?) ON CONFLICT(source,kind,entry_key) DO UPDATE SET value_json=excluded.value_json",
      ).run(source, kind, key, JSON.stringify(value));
    };
    return {
      accounts: {
        list,
        get: loadPrivateAccount,
        findByStableIdentity: (provider, identity) =>
          list().find((a) => a.provider === provider && a.stableIdentity === identity) ?? null,
        save: (a) => db.transaction(() => save(a))(),
        setEnabled: (id, enabled, updatedAt) =>
          db.transaction(() => update(id, { enabled, updatedAt }))(),
        setCredentialState: (id, credentialState, updatedAt) =>
          db.transaction(() => update(id, { credentialState, updatedAt }))(),
        delete: (id) => {
          db.prepare("DELETE FROM account_sources WHERE source=? AND account_id=?").run(source, id);
          if (privateVault) auxiliary.accounts.delete(id);
        },
      },
      credentials:
        privateVault && auxiliary instanceof GraphStorage
          ? {
              get: auxiliary.credentials.get,
              save: (credential) => {
                const owner = loadPrivateAccount(credential.accountId);
                if (!owner) throw new AppError("not-found", "私有凭据缺少对应账号");
                auxiliary.savePrivateCredential(credential, owner);
              },
            }
          : auxiliary.credentials,
      snapshots: { get: (id) => cached("usage", id), save: (v) => cache("usage", v.accountId, v) },
      notifications: {
        list: (id) => cached("notifications", id) ?? [],
        save: (v) => {
          const entries = (cached("notifications", v.accountId) ?? []) as ReturnType<
            StoragePort["notifications"]["list"]
          >;
          cache("notifications", v.accountId, [
            ...entries.filter((row) => row.quotaKey !== v.quotaKey),
            v,
          ]);
        },
      },
      settings:
        source === "private"
          ? auxiliary.settings
          : { get: (k) => cached("projection", k), save: (k, v) => cache("projection", k, v) },
      transaction: <T>(op: () => T) => db.transaction(() => auxiliary.transaction(op))(),
      close: () => auxiliary.close(),
    };
  }
}
