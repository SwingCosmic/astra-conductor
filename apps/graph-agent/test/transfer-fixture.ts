import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import { canonical, type TransferSnapshot } from "@astra-conductor/credentials";

export function transferFixture(records: TransferSnapshot["records"] = []) {
  const version = {
    vaultId: "vault",
    storageVersion: "version",
    attemptId: "attempt",
    keyId: "key",
  };
  const migrationKey = `acm1_${Buffer.alloc(32, 7).toString("base64url")}`;
  const info = canonical([
    "astraconductor.credential-transfer.v1",
    version.vaultId,
    version.storageVersion,
    version.attemptId,
    "transfer",
  ]);
  const header = {
    format: "astraconductor.credential-transfer",
    version: 1,
    ...version,
    transferId: "transfer",
    cipher: {
      name: "AES-256-GCM",
      nonce: Buffer.alloc(12, 3).toString("base64url"),
      tagLength: 128,
    },
    kdf: {
      name: "HKDF-SHA-256",
      salt: Buffer.alloc(32, 2).toString("base64url"),
      info: Buffer.from(info).toString("base64url"),
      outputLength: 32,
    },
    payloadSchemaVersion: 1,
  };
  const snapshot = {
    ...version,
    masterKey: Buffer.alloc(32, 9).toString("base64url"),
    records,
  };
  const key = hkdfSync("sha256", Buffer.alloc(32, 7), Buffer.alloc(32, 2), info, 32);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.alloc(12, 3));
  cipher.setAAD(Buffer.from(canonical(header)));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonical(snapshot))),
    cipher.final(),
  ]);
  const pack = {
    header,
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
  const bytes = Buffer.from(JSON.stringify(pack));
  const keyCheckCipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 9), Buffer.alloc(12, 4));
  keyCheckCipher.setAAD(
    Buffer.from(
      canonical([
        "astra.key-check.v1",
        version.vaultId,
        version.storageVersion,
        version.attemptId,
        version.keyId,
      ]),
    ),
  );
  const keyCheck = {
    nonce: Buffer.alloc(12, 4).toString("base64url"),
    ciphertext: Buffer.concat([
      keyCheckCipher.update("astra-key-check-v1"),
      keyCheckCipher.final(),
    ]).toString("base64url"),
    tag: keyCheckCipher.getAuthTag().toString("base64url"),
  };
  const manifest = {
    formatVersion: 1,
    ...version,
    migrationHash: createHash("sha256").update(bytes).digest("base64url"),
    keyCheck,
  };
  return {
    version,
    migrationKey,
    snapshot,
    pack,
    manifest,
    bytes,
    versionBytes: Buffer.from(JSON.stringify(manifest)),
  };
}
