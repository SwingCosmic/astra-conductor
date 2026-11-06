import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import {
  CredentialVault,
  CredentialMutationGate,
  MemoryStorage,
  type Account,
  type CredentialCipherPort,
  type ProviderRegistry,
} from "@astra-conductor/core/internal";
import { BrokerError, canonical, type InitialRecord } from "@astra-conductor/credentials";
import { CredentialSharingService, sharingFrozenKey } from "../src/credential-sharing/service.js";
import type { BrokerHost } from "../src/credential-sharing/broker-host.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const account: Account = {
  id: "account-1",
  provider: "example",
  offeringId: "example",
  authMethod: "api-key",
  stableIdentity: "private-id",
  displayName: "Example",
  maskedIdentifier: "exa***",
  enabled: true,
  credentialState: "available",
  publicMetadata: {},
  createdAt: "2026-11-05T00:00:00Z",
  updatedAt: "2026-11-05T00:00:00Z",
};
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "sharing-unit-"));
  directories.push(directory);
  const vaultDirectory = path.join(directory, "vault");
  const cacheDirectory = path.join(directory, "cache");
  const storage = new MemoryStorage();
  const cipher: CredentialCipherPort = {
    isAvailable: async () => true,
    encrypt: async (value) => Buffer.from(`encrypted:${value}`),
    decrypt: async (value) => ({
      plaintext: Buffer.from(value).toString().slice(10),
      shouldReEncrypt: false,
    }),
  };
  const mutations = new CredentialMutationGate();
  const credentials = new CredentialVault(storage, cipher, undefined, mutations);
  await credentials.saveAccount(account, {
    version: 1,
    accountId: account.id,
    provider: account.provider,
    authMethod: account.authMethod,
    expiresAt: null,
    secrets: { apiKey: "FICTIONAL-ONLY" },
  });
  let initialized: Record<string, unknown> | undefined;
  let sourceClientId = "";
  let owner = "uninitialized";
  let loseResponse = false;
  let ack = false;
  let tamper = false;
  let activeAuth = false;
  const initialize = vi.fn(async (params: unknown) => {
    const request = params as { records: InitialRecord[] };
    const version = {
      vaultId: "vault",
      storageVersion: "version",
      attemptId: "attempt",
      keyId: "key",
    };
    const info = canonical([
      "astraconductor.credential-transfer.v1",
      "vault",
      "version",
      "attempt",
      "transfer",
    ]);
    const header = {
      format: "astraconductor.credential-transfer",
      version: 1,
      ...version,
      transferId: "transfer",
      cipher: {
        name: "AES-256-GCM",
        nonce: Buffer.alloc(12, 1).toString("base64url"),
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
    const records = request.records.map((record) => ({
      description: {
        credentialId: record.credentialId,
        revision: "1",
        createdByClientId: sourceClientId,
        lastUpdatedByClientId: sourceClientId,
        metadata: record.metadata,
        contentType: record.contentType,
        payloadFormatVersion: record.payloadFormatVersion,
      },
      payload: tamper ? "eA" : record.payload,
    }));
    const snapshot = { ...version, masterKey: Buffer.alloc(32, 9).toString("base64url"), records };
    const transferKey = hkdfSync("sha256", Buffer.alloc(32, 7), Buffer.alloc(32, 2), info, 32);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(transferKey), Buffer.alloc(12, 1));
    cipher.setAAD(Buffer.from(canonical(header)));
    const bytes = Buffer.from(
      JSON.stringify({
        header,
        ciphertext: Buffer.concat([
          cipher.update(Buffer.from(canonical(snapshot))),
          cipher.final(),
        ]).toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      }),
    );
    const versionPath = path.join(vaultDirectory, "versions", "version");
    await mkdir(versionPath, { recursive: true });
    await writeFile(path.join(versionPath, "migration.json"), bytes);
    const keyCheckCipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 9), Buffer.alloc(12, 4));
    keyCheckCipher.setAAD(
      Buffer.from(canonical(["astra.key-check.v1", "vault", "version", "attempt", "key"])),
    );
    const keyCheck = {
      nonce: Buffer.alloc(12, 4).toString("base64url"),
      ciphertext: Buffer.concat([
        keyCheckCipher.update("astra-key-check-v1"),
        keyCheckCipher.final(),
      ]).toString("base64url"),
      tag: keyCheckCipher.getAuthTag().toString("base64url"),
    };
    await writeFile(
      path.join(versionPath, "version.json"),
      JSON.stringify({
        formatVersion: 1,
        ...version,
        migrationHash: createHash("sha256").update(bytes).digest("base64url"),
        keyCheck,
      }),
    );
    initialized = { ...version, state: "exported", migrationKey: null };
    owner = "source";
    if (loseResponse) throw new BrokerError("broker-disconnected");
    return { ...initialized, migrationKey: `acm1_${Buffer.alloc(32, 7).toString("base64url")}` };
  });
  const call = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "status")
      return { vaultId: "vault", storageVersion: initialized ? "version" : null, ownership: owner };
    if (method === "initialize") return initialize(params);
    if (method === "getOperation") return initialized;
    if (method === "recoverDelivery") {
      if (ack) throw new BrokerError("delivery-unavailable");
      return { migrationKey: `acm1_${Buffer.alloc(32, 7).toString("base64url")}` };
    }
    if (method === "prepareChallenge")
      return {
        challengeId: "challenge",
        nonce: Buffer.alloc(32).toString("base64url"),
        expiresAt: Date.now() + 60000,
      };
    if (method === "prepareClient") return { state: "prepared", storageVersion: "version" };
    if (method === "acknowledgeDelivery") {
      ack = true;
      return { acknowledged: true };
    }
    throw new Error("unexpected call");
  });
  const host: BrokerHost = {
    localPackageDirectory: path.join(directory, "download"),
    inspect: async () => ({
      installState: "installed",
      installedVersion: "0.1.0",
      installationDirectory: path.join(directory, "installed"),
    }),
    install: async () => undefined,
    uninstall: async () => undefined,
    connect: async (_vault, clientId) => {
      sourceClientId = clientId;
      return { call, close: () => undefined };
    },
  };
  const options = {
    storage,
    cipher,
    credentials,
    mutations,
    providers: { getUsage: () => ({}) } as unknown as ProviderRegistry,
    host,
    cacheDirectory,
    hasActiveAuth: () => activeAuth,
  };
  return {
    directory,
    vaultDirectory,
    storage,
    cipher,
    mutations,
    options,
    initialize,
    call,
    service: new CredentialSharingService(options),
    loseResponse: () => {
      loseResponse = true;
    },
    tamper: () => {
      tamper = true;
    },
    activeAuth: () => {
      activeAuth = true;
    },
    transferOwnership: () => {
      owner = "broker";
    },
  };
}
describe("PolyQuota first export", () => {
  it("accepts an existing empty directory and rejects nonempty selection before freezing", async () => {
    const c = await setup();
    await mkdir(c.vaultDirectory);
    const pick = vi.fn(async (): Promise<string | null> => c.vaultDirectory);
    const service = new CredentialSharingService({ ...c.options, selectDirectory: pick });
    expect(await service.selectDirectory()).toBe(c.vaultDirectory);
    await writeFile(path.join(c.vaultDirectory, "user-file.txt"), "keep");
    await expect(service.selectDirectory()).rejects.toThrow("首次导出请选择空目录");
    await expect(service.exportCredentials(c.vaultDirectory)).rejects.toThrow(
      "首次导出请选择空目录",
    );
    expect(c.storage.settings.get(sharingFrozenKey)).not.toBe(true);
    expect(c.initialize).not.toHaveBeenCalled();
    expect(await readFile(path.join(c.vaultDirectory, "user-file.txt"), "utf8")).toBe("keep");
    pick.mockResolvedValueOnce(null);
    expect(await service.selectDirectory()).toBeNull();
    await rm(path.join(c.vaultDirectory, "user-file.txt"));
    await service.exportCredentials(c.vaultDirectory);
    expect(c.initialize).toHaveBeenCalledTimes(1);
  });
  it("explains directory permission failures while preserving the pending export for retry", async () => {
    const c = await setup();
    const connect = vi
      .spyOn(c.options.host, "connect")
      .mockRejectedValueOnce(new BrokerError("directory-permissions-too-broad"));
    await expect(c.service.exportCredentials(c.vaultDirectory)).rejects.toThrow(
      "重新安装新版本地组件",
    );
    expect(await c.service.getStatus()).toMatchObject({
      exportState: "pending",
      frozen: true,
      lastError: "directory-permissions-too-broad",
    });
    connect.mockRestore();
    await c.service.exportCredentials(c.vaultDirectory);
    expect(c.initialize).toHaveBeenCalledTimes(1);
  });
  it("verifies the exported snapshot, remembers only the master key and explicitly acknowledges delivery", async () => {
    const c = await setup();
    const result = await c.service.exportCredentials(c.vaultDirectory);
    expect(result.migrationKey).toMatch(/^acm1_/);
    const status = await c.service.getStatus();
    expect(status).toMatchObject({
      exportState: "exported",
      rememberedKey: true,
      frozen: true,
      deliveryAcknowledged: false,
      activeBackend: "private",
    });
    expect(JSON.stringify(status)).not.toContain(result.migrationKey);
    expect(JSON.stringify(status)).not.toContain("FICTIONAL");
    expect(JSON.stringify(c.storage.settings.get("credentialSharing.export.v1"))).not.toContain(
      result.migrationKey,
    );
    expect(c.initialize.mock.calls[0][0]).toMatchObject({
      records: [{ metadata: { supportsUsage: "true" } }],
    });
    await c.service.acknowledgeDelivery();
    expect(await c.service.getStatus()).toMatchObject({ deliveryAcknowledged: true });
    await expect(c.service.exportCredentials(c.vaultDirectory)).rejects.toThrow(
      "migration-key-already-delivered",
    );
    expect(c.initialize).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost initialize response across restart without overwriting the published version", async () => {
    const c = await setup();
    c.loseResponse();
    await expect(c.service.exportCredentials(c.vaultDirectory)).rejects.toThrow();
    expect(c.storage.settings.get(sharingFrozenKey)).toBe(true);
    const restarted = new CredentialSharingService({
      ...c.options,
      mutations: new CredentialMutationGate(true),
    });
    expect((await restarted.exportCredentials(c.vaultDirectory)).migrationKey).toMatch(/^acm1_/);
    expect(c.initialize).toHaveBeenCalledTimes(1);
    expect(c.call).toHaveBeenCalledWith("getOperation", expect.anything());
  });
  it("keeps a published export recoverable when safe storage fails", async () => {
    const c = await setup();
    const encrypt = vi.spyOn(c.cipher, "encrypt").mockRejectedValueOnce(new Error("SECRET-ERROR"));
    await expect(c.service.exportCredentials(c.vaultDirectory)).rejects.not.toThrow("SECRET-ERROR");
    expect(await c.service.getStatus()).toMatchObject({
      exportState: "pending",
      rememberedKey: false,
      frozen: true,
    });
    encrypt.mockRestore();
    await c.service.exportCredentials(c.vaultDirectory);
    expect(c.initialize).toHaveBeenCalledTimes(1);
  });
  it("rejects mismatched authenticated content and changed source watermarks", async () => {
    const c = await setup();
    c.tamper();
    await expect(c.service.exportCredentials(c.vaultDirectory)).rejects.toThrow(
      "export-readback-mismatch",
    );
    const encrypted = c.storage.credentials.get(account.id)!;
    c.storage.credentials.save({ ...encrypted, updatedAt: "changed" });
    await expect(c.service.exportCredentials(c.vaultDirectory)).rejects.toThrow(
      "source-watermark-changed",
    );
    expect(c.initialize).toHaveBeenCalledTimes(1);
  });
  it("refuses export during active authorization and never freezes an unavailable cipher", async () => {
    const c = await setup();
    c.activeAuth();
    await expect(c.service.exportCredentials(c.vaultDirectory)).rejects.toThrow(
      "authorization-in-progress",
    );
    expect(c.storage.settings.get(sharingFrozenKey)).not.toBe(true);
    vi.spyOn(c.cipher, "isAvailable").mockResolvedValue(false);
    await expect(c.service.exportCredentials(c.vaultDirectory)).rejects.toThrow(
      "secure-storage-unavailable",
    );
  });
  it("does not freeze or create export state when the component is missing", async () => {
    const c = await setup();
    vi.spyOn(c.options.host, "inspect").mockResolvedValue({
      installState: "not-installed",
      installedVersion: null,
      installationDirectory: null,
    });
    await expect(c.service.exportCredentials(c.vaultDirectory)).rejects.toThrow(
      "component-not-installed",
    );
    expect(c.storage.settings.get(sharingFrozenKey)).not.toBe(true);
    expect(c.initialize).not.toHaveBeenCalled();
  });

  it("cancels only while the source retains ownership and never deletes a successful version", async () => {
    const c = await setup();
    await c.service.exportCredentials(c.vaultDirectory);
    c.transferOwnership();
    await expect(c.service.cancel()).rejects.toThrow("ownership-already-transferred");
    expect(c.storage.settings.get(sharingFrozenKey)).toBe(true);
    const d = await setup();
    await d.service.exportCredentials(d.vaultDirectory);
    await d.service.cancel();
    expect(await d.service.getStatus()).toMatchObject({ exportState: "cancelled", frozen: false });
    expect(
      (await readFile(path.join(d.vaultDirectory, "versions", "version", "migration.json"))).length,
    ).toBeGreaterThan(0);
    await expect(d.service.exportCredentials(d.vaultDirectory)).rejects.toThrow("export-cancelled");
  });
});
