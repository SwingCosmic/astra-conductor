import { describe, expect, it } from "vitest";
import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import { canonical, parseJson, unpackTransfer } from "../src/index.js";

export function transferFixture() {
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
    records: [],
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
describe("broker protocol formats", () => {
  it("rejects duplicate properties at every level and malformed Unicode/UTF8", () => {
    for (const input of [
      '{"a":1,"a":2}',
      '{"a":{"b":1,"b":2}}',
      "[true,]",
      '"\\ud800"',
      "9007199254740992",
      "{} garbage",
    ])
      expect(() => parseJson(Buffer.from(input))).toThrow();
    expect(() => parseJson(Buffer.from([0xc0, 0x80]))).toThrow();
    expect(parseJson(Buffer.from('{"a":[1,"文😀",null]}'))).toEqual({ a: [1, "文😀", null] });
  });
  it("canonicalizes nested objects with UTF16 property order and safe integer restriction", () => {
    expect(canonical({ z: true, a: { "😀": 1, "\ufffd": 2 }, n: -0 })).toBe(
      '{"a":{"😀":1,"�":2},"n":0,"z":true}',
    );
    expect(() => canonical({ value: 0.1 })).toThrow();
  });
  it("authenticates identity, digest, parameters, key and transfer payload", () => {
    const f = transferFixture();
    expect(unpackTransfer(f.bytes, f.migrationKey, f.versionBytes, f.version)).toEqual(f.snapshot);
    expect(() =>
      unpackTransfer(
        f.bytes,
        `acm1_${Buffer.alloc(32, 8).toString("base64url")}`,
        f.versionBytes,
        f.version,
      ),
    ).toThrow();
    expect(() =>
      unpackTransfer(f.bytes, f.migrationKey, f.versionBytes, { ...f.version, vaultId: "other" }),
    ).toThrow();
    f.pack.header.cipher.tagLength = 96;
    const bytes = Buffer.from(JSON.stringify(f.pack));
    const manifest = Buffer.from(
      JSON.stringify({
        ...f.manifest,
        migrationHash: createHash("sha256").update(bytes).digest("base64url"),
      }),
    );
    expect(() => unpackTransfer(bytes, f.migrationKey, manifest, f.version)).toThrow(
      "unsupported-crypto",
    );
    const corrupt = Buffer.from(f.bytes);
    corrupt[50] ^= 1;
    expect(() => unpackTransfer(corrupt, f.migrationKey, f.versionBytes, f.version)).toThrow();
  });
});
