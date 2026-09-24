import { createHash } from "node:crypto";

export interface Migration {
  version: number;
  sql: string;
  checksum: string;
}

function migration(version: number, sql: string): Migration {
  return {
    version,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
}

export const migrations: readonly Migration[] = [
  migration(
    1,
    `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        stable_identity TEXT NOT NULL,
        display_name TEXT NOT NULL,
        masked_identifier TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        public_metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider, stable_identity)
      );

      CREATE TABLE credentials (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        encryption_version INTEGER NOT NULL,
        ciphertext BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE usage_snapshots (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE notification_states (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        quota_key TEXT NOT NULL,
        reset_at TEXT,
        level TEXT NOT NULL,
        last_notified_at TEXT NOT NULL,
        PRIMARY KEY (account_id, quota_key)
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  ),
  migration(
    2,
    `
      ALTER TABLE accounts
        ADD COLUMN credential_state TEXT NOT NULL DEFAULT 'available';
      CREATE INDEX accounts_enabled_provider_idx ON accounts(enabled, provider);
    `,
  ),
];

export const currentSchemaVersion = migrations.at(-1)?.version ?? 0;
