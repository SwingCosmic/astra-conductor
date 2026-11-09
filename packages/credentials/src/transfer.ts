import { createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { canonical, id, object, parseJson, requireValue, text, unb64 } from "./format.js";

export interface InitialRecord {
  credentialId: string;
  contentType: string;
  payloadFormatVersion: number;
  payload: string;
  metadata: Record<string, string>;
  coordinationKey?: string;
  uniqueKey?: string;
}
export interface ExportVersion {
  vaultId: string;
  storageVersion: string;
  attemptId: string;
  keyId: string;
}
export interface TransferSnapshot extends ExportVersion {
  masterKey: string;
  records: {
    description: {
      credentialId: string;
      revision: string;
      createdByClientId: string;
      lastUpdatedByClientId: string;
      metadata: Record<string, string>;
      contentType: string;
      payloadFormatVersion: number;
    };
    payload: string;
  }[];
}
/** Verify a cached key against the authenticated vault/version/attempt/key identity. */
export function verifyTransferKey(
  version: Record<string, unknown>,
  expected: ExportVersion,
  masterKeyText: string,
): void {
  requireValue(
    Object.entries(expected).every(([key, value]) => version[key] === value),
    "version-mismatch",
  );
  const masterKey = unb64(masterKeyText, 32);
  try {
    const check = object(version.keyCheck, ["nonce", "ciphertext", "tag"]);
    const keyCheck = createDecipheriv("aes-256-gcm", masterKey, unb64(check.nonce, 12));
    keyCheck.setAAD(
      Buffer.from(
        canonical([
          "astra.key-check.v1",
          expected.vaultId,
          expected.storageVersion,
          expected.attemptId,
          expected.keyId,
        ]),
      ),
    );
    keyCheck.setAuthTag(unb64(check.tag, 16));
    const verified = Buffer.concat([keyCheck.update(unb64(check.ciphertext)), keyCheck.final()]);
    try {
      requireValue(verified.toString("utf8") === "astra-key-check-v1", "invalid-master-key");
    } finally {
      verified.fill(0);
    }
  } finally {
    masterKey.fill(0);
  }
}

export function unpackTransfer(
  bytes: Uint8Array,
  migrationKey: string,
  versionBytes: Uint8Array,
  expected: ExportVersion,
): TransferSnapshot {
  requireValue(/^acm1_[A-Za-z0-9_-]{43}$/.test(migrationKey), "invalid-migration-key");
  const version = object(parseJson(versionBytes), [
    "formatVersion",
    "vaultId",
    "storageVersion",
    "attemptId",
    "keyId",
    "migrationHash",
    "keyCheck",
  ]);
  requireValue(
    version.formatVersion === 1 && Object.entries(expected).every(([k, v]) => version[k] === v),
    "version-mismatch",
  );
  requireValue(
    createHash("sha256").update(bytes).digest("base64url") === version.migrationHash,
    "migration-digest-mismatch",
  );
  const pack = object(parseJson(bytes), ["header", "ciphertext", "tag"]);
  const header = object(pack.header, [
    "format",
    "version",
    "vaultId",
    "storageVersion",
    "attemptId",
    "transferId",
    "keyId",
    "cipher",
    "kdf",
    "payloadSchemaVersion",
  ]);
  requireValue(
    header.format === "astraconductor.credential-transfer" &&
      header.version === 1 &&
      header.payloadSchemaVersion === 1,
    "unsupported-crypto",
  );
  for (const [k, v] of Object.entries(expected)) requireValue(header[k] === v, "version-mismatch");
  id(header.transferId);
  const cipher = object(header.cipher, ["name", "nonce", "tagLength"]);
  const kdf = object(header.kdf, ["name", "salt", "info", "outputLength"]);
  requireValue(
    cipher.name === "AES-256-GCM" &&
      cipher.tagLength === 128 &&
      kdf.name === "HKDF-SHA-256" &&
      kdf.outputLength === 32,
    "unsupported-crypto",
  );
  const info = canonical([
    "astraconductor.credential-transfer.v1",
    expected.vaultId,
    expected.storageVersion,
    expected.attemptId,
    header.transferId,
  ]);
  requireValue(
    text(kdf.info) === Buffer.from(info).toString("base64url"),
    "invalid-crypto-parameters",
  );
  const migration = unb64(migrationKey.slice(5), 32);
  const key = Buffer.from(hkdfSync("sha256", migration, unb64(kdf.salt, 32), info, 32));
  let plain: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, unb64(cipher.nonce, 12));
    decipher.setAAD(Buffer.from(canonical(header)));
    decipher.setAuthTag(unb64(pack.tag, 16));
    plain = Buffer.concat([decipher.update(unb64(pack.ciphertext)), decipher.final()]);
    const snapshot = object(parseJson(plain), [
      "vaultId",
      "storageVersion",
      "attemptId",
      "keyId",
      "masterKey",
      "records",
    ]);
    requireValue(
      Object.entries(expected).every(([k, v]) => snapshot[k] === v),
      "snapshot-mismatch",
    );
    verifyTransferKey(version, expected, text(snapshot.masterKey));
    requireValue(Array.isArray(snapshot.records) && snapshot.records.length <= 1000);
    for (const item of snapshot.records) {
      const record = object(item, ["description", "payload"]);
      const d = object(record.description, [
        "credentialId",
        "revision",
        "createdByClientId",
        "lastUpdatedByClientId",
        "metadata",
        "contentType",
        "payloadFormatVersion",
      ]);
      id(d.credentialId);
      id(d.createdByClientId);
      id(d.lastUpdatedByClientId);
      requireValue(
        d.revision === "1" &&
          typeof d.contentType === "string" &&
          Number.isSafeInteger(d.payloadFormatVersion),
      );
      for (const value of Object.values(object(d.metadata))) text(value);
      unb64(record.payload);
    }
    return snapshot as unknown as TransferSnapshot;
  } finally {
    migration.fill(0);
    key.fill(0);
    plain?.fill(0);
  }
}
