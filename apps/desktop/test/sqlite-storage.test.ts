import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Account, UsageSnapshot } from "@llm-usage/core/internal";
import { currentSchemaVersion, migrations } from "../src/migrations.js";
import { SqliteStorage } from "../src/sqlite-storage.js";

const tempDirectories: string[] = [];

function tempDatabase(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "llm-usage-sqlite-"));
  tempDirectories.push(directory);
  return path.join(directory, "llm-usage.db");
}

function account(id = "account-1"): Account {
  return {
    id,
    provider: "codex",
    authMethod: "cli-import",
    stableIdentity: `workspace:${id}`,
    displayName: "Test account",
    maskedIdentifier: "te***@example.test",
    enabled: true,
    credentialState: "available",
    publicMetadata: { workspaceId: `workspace-${id}` },
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
}

function snapshot(accountId: string, plan: string): UsageSnapshot {
  return {
    accountId,
    plan,
    groups: [],
    extras: [],
    fetchedAt: "2026-09-24T01:00:00.000Z",
  };
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("SqliteStorage", () => {
  it("creates, migrates, and reopens the database idempotently", () => {
    const filename = tempDatabase();
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    legacy.exec(migrations[0].sql);
    legacy
      .prepare("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)")
      .run(1, migrations[0].checksum, "2026-09-24T00:00:00.000Z");
    legacy
      .prepare(
        `INSERT INTO accounts (
          id, provider, auth_method, stable_identity, display_name, masked_identifier,
          enabled, public_metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy",
        "codex",
        "cli-import",
        "workspace:legacy",
        "Legacy",
        "le***",
        1,
        "{}",
        "2026-09-24T00:00:00.000Z",
        "2026-09-24T00:00:00.000Z",
      );
    legacy.close();

    const first = new SqliteStorage(filename);
    expect(first.accounts.get("legacy")?.credentialState).toBe("available");
    first.close();
    const second = new SqliteStorage(filename);
    expect(second.accounts.list()).toHaveLength(1);
    second.close();

    const check = new Database(filename, { readonly: true });
    const count = check.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
      count: number;
    };
    expect(count.count).toBe(currentSchemaVersion);
    check.close();
  });

  it("replaces snapshots, rolls back transactions, and cascades account deletion", () => {
    const storage = new SqliteStorage(tempDatabase());
    const saved = account();
    storage.accounts.save(saved);
    storage.credentials.save({
      accountId: saved.id,
      encryptionVersion: 1,
      ciphertext: Buffer.from("encrypted-only"),
      updatedAt: saved.updatedAt,
    });
    storage.snapshots.save(snapshot(saved.id, "plus"));
    storage.snapshots.save(snapshot(saved.id, "pro"));
    storage.notifications.save({
      accountId: saved.id,
      quotaKey: "session",
      resetAt: null,
      level: "warning",
      lastNotifiedAt: saved.updatedAt,
    });
    expect(storage.snapshots.get(saved.id)?.plan).toBe("pro");

    expect(() =>
      storage.transaction(() => {
        storage.accounts.setEnabled(saved.id, false, saved.updatedAt);
        throw new Error("rollback");
      }),
    ).toThrow("Database transaction failed");
    expect(storage.accounts.get(saved.id)?.enabled).toBe(true);

    storage.accounts.delete(saved.id);
    expect(storage.credentials.get(saved.id)).toBeNull();
    expect(storage.snapshots.get(saved.id)).toBeNull();
    expect(storage.notifications.list(saved.id)).toEqual([]);
    storage.close();
  });

  it("stores only encrypted credential bytes", () => {
    const filename = tempDatabase();
    const storage = new SqliteStorage(filename);
    const saved = account();
    storage.accounts.save(saved);
    storage.credentials.save({
      accountId: saved.id,
      encryptionVersion: 1,
      ciphertext: Buffer.from("ciphertext-without-secret"),
      updatedAt: saved.updatedAt,
    });
    storage.close();
    const file = readFileSync(filename).toString("utf8");
    expect(file).toContain("ciphertext-without-secret");
    expect(file).not.toContain("plain-test-access-token");
  });
});
