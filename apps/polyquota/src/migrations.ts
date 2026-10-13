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
  migration(
    3,
    `
      ALTER TABLE notification_states
        ADD COLUMN delivery_confirmed INTEGER NOT NULL DEFAULT 0
          CHECK (delivery_confirmed IN (0, 1));
    `,
  ),
  migration(
    4,
    `
      ALTER TABLE accounts ADD COLUMN offering_id TEXT;

      -- 旧账号按现有事实回填：GLM 优先 presentationId、其次 region 推导；
      -- 单接入点服务商的 offering id 与 provider 相同。
      UPDATE accounts SET offering_id = CASE
        WHEN provider = 'glm' THEN COALESCE(
          json_extract(public_metadata, '$.presentationId'),
          CASE json_extract(public_metadata, '$.region')
            WHEN 'china' THEN 'bigmodel-coding-plan'
            ELSE 'zai-coding-plan'
          END
        )
        ELSE provider
      END;

      ALTER TABLE accounts ALTER COLUMN offering_id SET NOT NULL;
    `,
  ),
];

export const currentSchemaVersion = migrations.at(-1)?.version ?? 0;
