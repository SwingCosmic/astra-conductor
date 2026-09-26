import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  AppError,
  type Account,
  type EncryptedCredential,
  type NotificationState,
  type SettingValue,
  type StoragePort,
  type UsageSnapshot,
} from "@astra-conductor/core/internal";
import { migrations } from "./migrations.js";

interface AccountRow {
  id: string;
  provider: Account["provider"];
  auth_method: Account["authMethod"];
  stable_identity: string;
  display_name: string;
  masked_identifier: string;
  enabled: number;
  credential_state: Account["credentialState"];
  public_metadata: string;
  created_at: string;
  updated_at: string;
}

interface CredentialRow {
  account_id: string;
  encryption_version: 1;
  ciphertext: Buffer;
  updated_at: string;
}

interface JsonRow {
  value_json: string;
}

interface SnapshotRow {
  snapshot_json: string;
}

interface NotificationRow {
  account_id: string;
  quota_key: string;
  reset_at: string | null;
  level: NotificationState["level"];
  last_notified_at: string;
  delivery_confirmed: number;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new AppError("storage", `${label} contains invalid JSON`, false, { cause: error });
  }
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    provider: row.provider,
    authMethod: row.auth_method,
    stableIdentity: row.stable_identity,
    displayName: row.display_name,
    maskedIdentifier: row.masked_identifier,
    enabled: row.enabled === 1,
    credentialState: row.credential_state,
    publicMetadata: parseJson(row.public_metadata, "Account metadata"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SqliteStorageOptions {
  nativeBinding?: string;
}

export class SqliteStorage implements StoragePort {
  private readonly database: Database.Database;
  private closed = false;

  constructor(
    readonly filename: string,
    options: SqliteStorageOptions = {},
  ) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    try {
      this.database = new Database(filename, { nativeBinding: options.nativeBinding });
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 2500");
      if (filename !== ":memory:") this.database.pragma("journal_mode = WAL");
      this.applyMigrations();
    } catch (error) {
      throw new AppError("storage", "Unable to open the local database", false, { cause: error });
    }
  }

  readonly accounts = {
    list: (): Account[] =>
      (
        this.database
          .prepare("SELECT * FROM accounts ORDER BY created_at, id")
          .all() as AccountRow[]
      ).map(toAccount),
    get: (id: string): Account | null => {
      const row = this.database.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as
        | AccountRow
        | undefined;
      return row ? toAccount(row) : null;
    },
    findByStableIdentity: (
      provider: Account["provider"],
      stableIdentity: string,
    ): Account | null => {
      const row = this.database
        .prepare("SELECT * FROM accounts WHERE provider = ? AND stable_identity = ?")
        .get(provider, stableIdentity) as AccountRow | undefined;
      return row ? toAccount(row) : null;
    },
    save: (account: Account): void => {
      this.database
        .prepare(
          `INSERT INTO accounts (
             id, provider, auth_method, stable_identity, display_name, masked_identifier,
             enabled, credential_state, public_metadata, created_at, updated_at
           ) VALUES (
             @id, @provider, @authMethod, @stableIdentity, @displayName, @maskedIdentifier,
             @enabled, @credentialState, @publicMetadata, @createdAt, @updatedAt
           )
           ON CONFLICT(id) DO UPDATE SET
             provider = excluded.provider,
             auth_method = excluded.auth_method,
             stable_identity = excluded.stable_identity,
             display_name = excluded.display_name,
             masked_identifier = excluded.masked_identifier,
             enabled = excluded.enabled,
             credential_state = excluded.credential_state,
             public_metadata = excluded.public_metadata,
             updated_at = excluded.updated_at`,
        )
        .run({
          ...account,
          enabled: account.enabled ? 1 : 0,
          publicMetadata: JSON.stringify(account.publicMetadata),
        });
    },
    setEnabled: (id: string, enabled: boolean, updatedAt: string): void => {
      const result = this.database
        .prepare("UPDATE accounts SET enabled = ?, updated_at = ? WHERE id = ?")
        .run(enabled ? 1 : 0, updatedAt, id);
      if (result.changes !== 1) throw new AppError("validation", "Account does not exist");
    },
    setCredentialState: (
      id: string,
      state: Account["credentialState"],
      updatedAt: string,
    ): void => {
      const result = this.database
        .prepare("UPDATE accounts SET credential_state = ?, updated_at = ? WHERE id = ?")
        .run(state, updatedAt, id);
      if (result.changes !== 1) throw new AppError("validation", "Account does not exist");
    },
    delete: (id: string): void => {
      this.database.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    },
  };

  readonly credentials = {
    get: (accountId: string): EncryptedCredential | null => {
      const row = this.database
        .prepare("SELECT * FROM credentials WHERE account_id = ?")
        .get(accountId) as CredentialRow | undefined;
      return row
        ? {
            accountId: row.account_id,
            encryptionVersion: row.encryption_version,
            ciphertext: new Uint8Array(row.ciphertext),
            updatedAt: row.updated_at,
          }
        : null;
    },
    save: (credential: EncryptedCredential): void => {
      this.database
        .prepare(
          `INSERT INTO credentials (account_id, encryption_version, ciphertext, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             encryption_version = excluded.encryption_version,
             ciphertext = excluded.ciphertext,
             updated_at = excluded.updated_at`,
        )
        .run(
          credential.accountId,
          credential.encryptionVersion,
          Buffer.from(credential.ciphertext),
          credential.updatedAt,
        );
    },
  };

  readonly snapshots = {
    get: (accountId: string): UsageSnapshot | null => {
      const row = this.database
        .prepare("SELECT snapshot_json FROM usage_snapshots WHERE account_id = ?")
        .get(accountId) as SnapshotRow | undefined;
      return row ? parseJson(row.snapshot_json, "Usage snapshot") : null;
    },
    save: (snapshot: UsageSnapshot): void => {
      this.database
        .prepare(
          `INSERT INTO usage_snapshots (account_id, snapshot_json, fetched_at)
           VALUES (?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             snapshot_json = excluded.snapshot_json,
             fetched_at = excluded.fetched_at`,
        )
        .run(snapshot.accountId, JSON.stringify(snapshot), snapshot.fetchedAt);
    },
  };

  readonly notifications = {
    list: (accountId: string): NotificationState[] =>
      (
        this.database
          .prepare("SELECT * FROM notification_states WHERE account_id = ? ORDER BY quota_key")
          .all(accountId) as NotificationRow[]
      ).map((row) => ({
        accountId: row.account_id,
        quotaKey: row.quota_key,
        resetAt: row.reset_at,
        level: row.level,
        lastNotifiedAt: row.last_notified_at,
        deliveryConfirmed: row.delivery_confirmed === 1,
      })),
    save: (state: NotificationState): void => {
      this.database
        .prepare(
          `INSERT INTO notification_states (
             account_id, quota_key, reset_at, level, last_notified_at, delivery_confirmed
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, quota_key) DO UPDATE SET
             reset_at = excluded.reset_at,
             level = excluded.level,
             last_notified_at = excluded.last_notified_at,
             delivery_confirmed = excluded.delivery_confirmed`,
        )
        .run(
          state.accountId,
          state.quotaKey,
          state.resetAt,
          state.level,
          state.lastNotifiedAt,
          state.deliveryConfirmed ? 1 : 0,
        );
    },
  };

  readonly settings = {
    get: (key: string): SettingValue | null => {
      const row = this.database
        .prepare("SELECT value_json FROM settings WHERE key = ?")
        .get(key) as JsonRow | undefined;
      return row ? parseJson(row.value_json, "Setting") : null;
    },
    save: (key: string, value: SettingValue, updatedAt: string): void => {
      this.database
        .prepare(
          `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
        )
        .run(key, JSON.stringify(value), updatedAt);
    },
  };

  transaction<T>(operation: () => T): T {
    try {
      return this.database.transaction(operation)();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("storage", "Database transaction failed", false, { cause: error });
    }
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Map(
      (
        this.database
          .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
          .all() as Array<{ version: number; checksum: string }>
      ).map((entry) => [entry.version, entry.checksum]),
    );
    for (const migration of migrations) {
      const checksum = applied.get(migration.version);
      if (checksum && checksum !== migration.checksum) {
        throw new AppError("storage", `Migration ${migration.version} checksum mismatch`);
      }
      if (checksum) continue;
      this.database.transaction(() => {
        this.database.exec(migration.sql);
        this.database
          .prepare("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.checksum, new Date().toISOString());
      })();
    }
  }
}
