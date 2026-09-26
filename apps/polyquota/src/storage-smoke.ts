import { existsSync, readFileSync } from "node:fs";
import type { Account } from "@llm-usage/core/internal";
import { CredentialVault } from "@llm-usage/core/internal";
import { ElectronSafeStorageCipher } from "./safe-storage-cipher.js";
import { SqliteStorage } from "./sqlite-storage.js";

const testSecret = "stage3-plain-secret-must-not-appear";

function smokeAccount(): Account {
  const timestamp = new Date().toISOString();
  return {
    id: "stage3-smoke",
    provider: "codex",
    authMethod: "cli-import",
    stableIdentity: "smoke:stage3",
    displayName: "Storage smoke test",
    maskedIdentifier: "st***",
    enabled: true,
    credentialState: "available",
    publicMetadata: { workspaceId: "smoke" },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function assertNoPlaintext(filename: string): void {
  for (const candidate of [filename, `${filename}-wal`]) {
    if (existsSync(candidate) && readFileSync(candidate).includes(Buffer.from(testSecret))) {
      throw new Error("plaintext credential detected");
    }
  }
}

export async function runStorageSmoke(filename: string, nativeBinding: string): Promise<void> {
  const cipher = new ElectronSafeStorageCipher();
  const first = new SqliteStorage(filename, { nativeBinding });
  const account = smokeAccount();
  first.accounts.save(account);
  const firstVault = new CredentialVault(first, cipher);
  await firstVault.save(account, {
    version: 1,
    accountId: account.id,
    provider: account.provider,
    authMethod: account.authMethod,
    expiresAt: null,
    secrets: { accessToken: testSecret, refreshToken: "stage3-refresh-secret" },
  });
  first.close();
  assertNoPlaintext(filename);

  const reopened = new SqliteStorage(filename, { nativeBinding });
  const loaded = await new CredentialVault(reopened, cipher).load(account.id);
  if (loaded.secrets.accessToken !== testSecret) throw new Error("credential round trip failed");
  reopened.close();
}
