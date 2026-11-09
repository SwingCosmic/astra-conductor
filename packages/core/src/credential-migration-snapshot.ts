import { randomUUID } from "node:crypto";
import {
  canonical,
  hash,
  requireValue,
  type BrokerCredential,
  type CredentialDescription,
  type InitialRecord,
  type SharedBrokerClient,
} from "@astra-conductor/credentials";
import type { CredentialAccountPreview } from "@astra-conductor/contract/common";
import type { Account, EncryptedCredential } from "./models.js";
import type { CredentialCipherPort, StoragePort } from "./ports.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { CredentialVault } from "./credential-vault.js";
import {
  decodeSharedCredential,
  encodeSharedCredential,
  sharedCredentialContentType,
  sharedCredentialMetadata,
  sharedAccountIdentityKey,
} from "./shared-credential-service.js";
import type { MigrationBinding, PrivateSnapshot } from "./credential-migration-profile.js";

export function previewRecord(
  record: BrokerCredential,
  providers: ProviderRegistry,
): CredentialAccountPreview {
  const d = record.description;
  const decoded =
    d.contentType === sharedCredentialContentType ? decodeSharedCredential(record) : null;
  const provider = decoded?.account.provider ?? d.metadata.provider ?? "unknown";
  return {
    id: d.credentialId,
    provider,
    maskedIdentifier: decoded?.account.maskedIdentifier ?? "—",
    canRefresh: !!decoded && !!providers.getAccount(provider)?.refreshCredentials,
    revision: d.revision,
  };
}
export function privateBaseline(storage: StoragePort): Record<string, string> {
  return Object.fromEntries(
    storage.accounts.list().map((account) => {
      const secret = storage.credentials.get(account.id);
      return [
        account.id,
        hash([
          JSON.stringify(account),
          secret ? Buffer.from(secret.ciphertext).toString("base64url") : null,
        ]),
      ];
    }),
  );
}
export function recordDigest(records: InitialRecord[]): string {
  // The broker index is derived from the authenticated account identity, and is not
  // a field of the migration package. Compare the actual transferable record fields.
  return hash(
    records
      .map(({ credentialId, contentType, payloadFormatVersion, payload, metadata }) => ({
        credentialId,
        contentType,
        payloadFormatVersion,
        payload,
        metadata,
      }))
      .sort((a, b) => a.credentialId.localeCompare(b.credentialId)),
  );
}
export function recordInput(record: BrokerCredential): InitialRecord {
  const { credentialId, contentType, payloadFormatVersion, metadata } = record.description;
  return { credentialId, contentType, payloadFormatVersion, metadata, payload: record.payload };
}
export async function exportSnapshot(
  storage: StoragePort,
  cipher: CredentialCipherPort,
  providers: ProviderRegistry,
) {
  const vault = new CredentialVault(storage, cipher);
  const accounts = storage.accounts.list();
  requireValue(accounts.length > 0 && accounts.length <= 1000, "invalid-export-record-count");
  const records: InitialRecord[] = [];
  for (const account of accounts) {
    const payload = encodeSharedCredential(account, await vault.load(account.id));
    records.push({
      credentialId: account.id,
      uniqueKey: sharedAccountIdentityKey(account),
      contentType: sharedCredentialContentType,
      payloadFormatVersion: 1,
      payload,
      metadata: sharedCredentialMetadata(account, providers),
    });
  }
  const baseline = privateBaseline(storage);
  return { records, baseline, watermark: hash(baseline) };
}

export async function snapshotWatermark(
  broker: SharedBrokerClient,
  binding: MigrationBinding,
): Promise<string> {
  const result = await broker.getSnapshotWatermark();
  requireValue(
    result.vaultId === binding.version.vaultId &&
      result.storageVersion === binding.version.storageVersion,
    "version-mismatch",
  );
  return result.watermark;
}
export async function readCurrentRecords(
  broker: SharedBrokerClient,
  descriptions: CredentialDescription[],
) {
  const records: BrokerCredential[] = [];
  for (const description of descriptions) {
    const record = await broker.getCredential(description.credentialId);
    requireValue(
      canonical(record.description) === canonical(description),
      "shared-snapshot-changed",
    );
    records.push(record);
  }
  return records;
}
export async function verifyPrivateSnapshot(
  snapshot: PrivateSnapshot,
  storage: StoragePort,
  load: (accountId: string) => Promise<unknown>,
) {
  for (const record of snapshot.records) {
    const account = storage.accounts.get(record.id);
    requireValue(
      account && hash([account, await load(record.id)]) === record.digest,
      "private-snapshot-readback-failed",
    );
  }
}
function manifestDigest(
  binding: MigrationBinding,
  snapshot: Omit<PrivateSnapshot, "protectedManifest">,
): string {
  return hash([
    binding.version,
    binding.clientId,
    snapshot.at,
    snapshot.watermark,
    snapshot.records,
  ]);
}
export async function protectManifest(
  binding: MigrationBinding,
  snapshot: Omit<PrivateSnapshot, "protectedManifest">,
  cipher: CredentialCipherPort,
): Promise<PrivateSnapshot> {
  const digest = manifestDigest(binding, snapshot);
  const bytes = await cipher.encrypt(digest);
  requireValue(
    (await cipher.decrypt(bytes)).plaintext === digest,
    "private-snapshot-readback-failed",
  );
  return { ...snapshot, protectedManifest: Buffer.from(bytes).toString("base64url") };
}
export async function verifyManifest(
  binding: MigrationBinding,
  snapshot: PrivateSnapshot,
  cipher: CredentialCipherPort,
) {
  const { plaintext } = await cipher.decrypt(Buffer.from(snapshot.protectedManifest, "base64url"));
  requireValue(plaintext === manifestDigest(binding, snapshot), "private-snapshot-readback-failed");
}
function receiptKey(binding: MigrationBinding): string {
  return "credentialSharing.privateSnapshot." + binding.version.vaultId;
}
/** Stored in the same private transaction as its rows, so an interrupted profile-file commit
 * still accounts for deletions on the next prepare. A previous local grant supplies scope only. */
export async function privateSnapshotReceipt(
  binding: MigrationBinding,
  storage: StoragePort,
  cipher: CredentialCipherPort,
): Promise<{ snapshot: PrivateSnapshot; clientId: string; operationId: string } | null> {
  const encoded = storage.settings.get(receiptKey(binding));
  if (encoded === null) return null;
  requireValue(typeof encoded === "string", "private-snapshot-readback-failed");
  const receipt = JSON.parse(encoded) as {
    clientId: string;
    snapshot: PrivateSnapshot;
    operationId: string;
  };
  await verifyManifest({ ...binding, clientId: receipt.clientId }, receipt.snapshot, cipher);
  return receipt;
}
export async function preparePrivateSnapshot(
  binding: MigrationBinding,
  broker: SharedBrokerClient,
  storage: StoragePort,
  cipher: CredentialCipherPort,
  operationId: string,
): Promise<PrivateSnapshot> {
  const watermark = await snapshotWatermark(broker, binding);
  const current = await readCurrentRecords(broker, await broker.listCredentials());
  const vault = new CredentialVault(storage, cipher);
  const staged: { account: Account; encrypted: EncryptedCredential; digest: string }[] = [];
  const previous = await privateSnapshotReceipt(binding, storage, cipher);
  for (const record of current) {
    // A private copy cannot silently discard an authorized payload it cannot round-trip.
    const decoded = decodeSharedCredential(record);
    const sameIdentity = storage.accounts.findByStableIdentity(
      decoded.account.provider,
      decoded.account.stableIdentity,
    );
    const existing = storage.accounts.get(decoded.account.id);
    // Reuse the local account's id and usage history for a matching identity. An unrelated
    // private account whose id collides with a broker id must survive the snapshot intact.
    const localId = sameIdentity?.id ?? (existing ? randomUUID() : decoded.account.id);
    const account = {
      ...decoded.account,
      id: localId,
      createdAt: sameIdentity?.createdAt ?? decoded.account.createdAt,
    };
    const credentials = { ...decoded.credentials, accountId: localId };
    const encrypted = await vault.seal(account, credentials);
    const readback = await cipher.decrypt(encrypted.ciphertext);
    requireValue(
      canonical(JSON.parse(readback.plaintext)) === canonical(credentials),
      "private-snapshot-readback-failed",
    );
    staged.push({ account, encrypted, digest: hash([account, credentials]) });
  }
  requireValue((await snapshotWatermark(broker, binding)) === watermark, "shared-snapshot-changed");
  const ids = new Set(staged.map((item) => item.account.id));
  const snapshot = await protectManifest(
    binding,
    {
      at: new Date().toISOString(),
      watermark,
      records: staged.map((item) => ({ id: item.account.id, digest: item.digest })),
    },
    cipher,
  );
  storage.transaction(() => {
    const managed = new Set([
      ...(binding.managedIds ?? []),
      ...(previous?.snapshot.records.map((record) => record.id) ?? []),
    ]);
    for (const id of managed) {
      if (!ids.has(id)) storage.accounts.delete(id);
    }
    for (const { account, encrypted } of staged) {
      storage.accounts.save(account);
      storage.credentials.save(encrypted);
      const persisted = storage.credentials.get(account.id);
      requireValue(
        persisted && Buffer.from(persisted.ciphertext).equals(Buffer.from(encrypted.ciphertext)),
        "private-snapshot-readback-failed",
      );
    }
    storage.settings.save(
      receiptKey(binding),
      JSON.stringify({ clientId: binding.clientId, snapshot, operationId }),
      snapshot.at,
    );
  });
  await verifyPrivateSnapshot(snapshot, storage, (id) => vault.load(id));
  return snapshot;
}
