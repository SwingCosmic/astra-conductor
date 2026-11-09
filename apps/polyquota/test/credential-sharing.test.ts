import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import {
  CredentialMigrationService,
  CredentialVault,
  CredentialMutationGate,
  MemoryStorage,
  MigrationProfileUpgradeRequired,
  SwitchingCredentialService,
  type Account,
  type CredentialCipherPort,
  type ProviderRegistry,
} from "@astra-conductor/core/internal";
import {
  BrokerError,
  canonical,
  type BrokerCredential,
  type InitialRecord,
} from "@astra-conductor/credentials";
import type { BrokerHost } from "../src/platform/common/credential-broker-host.js";
import { SqliteStorage } from "../src/platform/common/sqlite-storage.js";

const directories: string[] = [];
const services: CredentialMigrationService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.useRealTimers();
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
  const switcher = new SwitchingCredentialService(credentials);
  await credentials.saveAccount(account, {
    version: 1,
    accountId: account.id,
    provider: account.provider,
    authMethod: account.authMethod,
    expiresAt: null,
    secrets: { apiKey: "FICTIONAL-ONLY" },
  });
  let initialized: Record<string, unknown> | undefined;
  let connectedVaultDirectory = vaultDirectory;
  let sourceClientId = "";
  let callerId = "";
  let owner = "uninitialized";
  let loseResponse = false;
  let ack = false;
  let tamper = false;
  let activeAuth = false;
  let disconnected = false;
  let sourceWatermark = "";
  let exportOperationId = "";
  let sharedRecords: BrokerCredential[] = [];
  let eventSequence = 0;
  const initialize = vi.fn(async (params: unknown) => {
    const request = params as {
      records: InitialRecord[];
      operationId: string;
      sourceWatermark: string;
    };
    sourceClientId = callerId;
    sourceWatermark = request.sourceWatermark;
    exportOperationId = request.operationId;
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
    sharedRecords = structuredClone(records);
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
    const versionPath = path.join(connectedVaultDirectory, "versions", "version");
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
    owner = "broker";
    await writeFile(
      path.join(connectedVaultDirectory, "manifest.json"),
      JSON.stringify({ vaultId: "vault" }),
    );
    if (loseResponse) throw new BrokerError("broker-disconnected");
    return { ...initialized, migrationKey: `acm1_${Buffer.alloc(32, 7).toString("base64url")}` };
  });
  const call = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "status")
      return { vaultId: "vault", storageVersion: initialized ? "version" : null, ownership: owner };
    if (method === "publish") return initialize(params);
    if (method === "getOperation") {
      const operationId = (params as { operationId: string }).operationId;
      if (operationId === exportOperationId) return initialized;
      throw new BrokerError("operation-not-found");
    }
    if (method === "getSharingState")
      return {
        vaultId: "vault",
        storageVersion: "version",
        attemptId: "attempt",
        keyId: "key",
        sourceWatermark,
        sourceClientId,
        preparedClientIds: [],
        ownership: owner,
      };
    if (method === "getSnapshotWatermark")
      return { vaultId: "vault", storageVersion: "version", watermark: String(eventSequence) };
    if (method === "listCredentials") {
      const filter = (params as { metadataEquals?: Record<string, string> }).metadataEquals ?? {};
      return {
        items: sharedRecords
          .filter((record) =>
            Object.entries(filter).every(
              ([key, value]) => record.description.metadata[key] === value,
            ),
          )
          .map((record) => structuredClone(record.description)),
        nextCursor: null,
      };
    }
    if (method === "getCredential") {
      const record = sharedRecords.find(
        (record) =>
          record.description.credentialId === (params as { credentialId: string }).credentialId,
      );
      if (!record) throw new BrokerError("credential-not-found");
      return structuredClone(record);
    }
    if (method === "getEvents") {
      const cursor = Number((params as { cursor: string }).cursor);
      return {
        items:
          cursor < eventSequence
            ? sharedRecords.map((record) => ({
                credentialId: record.description.credentialId,
                revision: record.description.revision,
                eventSequence: String(eventSequence),
                kind: "credentialChanged",
              }))
            : [],
        nextCursor: String(eventSequence),
      };
    }
    if (method === "disconnect") {
      disconnected = true;
      return { disconnected: true };
    }
    if (method === "recoverDelivery") {
      if (ack) throw new BrokerError("delivery-unavailable");
      return { migrationKey: `acm1_${Buffer.alloc(32, 7).toString("base64url")}` };
    }
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
      installedVersion: "0.3.0",
      installationDirectory: path.join(directory, "installed"),
    }),
    install: async () => undefined,
    uninstall: async () => undefined,
    connect: async (selectedVault, clientId) => {
      if (selectedVault !== connectedVaultDirectory) {
        connectedVaultDirectory = selectedVault;
        initialized = undefined;
        owner = "uninitialized";
        ack = false;
      }
      callerId = clientId;
      return { call, close: () => undefined };
    },
  };
  const options = {
    product: "polyquota" as const,
    storage,
    cipher,
    switcher,
    mutations,
    providers: {
      getUsage: () => ({}),
      getAccount: () => ({}),
      findOffering: () => ({
        provider: account.provider,
        offering: { authMethods: [{ method: account.authMethod }] },
      }),
    } as unknown as ProviderRegistry,
    host,
    cacheDirectory,
    hasActiveAuth: () => activeAuth,
  };
  const service = new CredentialMigrationService(options);
  services.push(service);
  return {
    directory,
    vaultDirectory,
    storage,
    cipher,
    mutations,
    credentials,
    switcher,
    options,
    initialize,
    call,
    service,
    disconnected: () => disconnected,
    deleteShared: () => {
      sharedRecords = [];
      eventSequence++;
    },
    updateShared: (apiKey: string) => {
      for (const record of sharedRecords) {
        const payload = JSON.parse(Buffer.from(record.payload, "base64url").toString()) as {
          credentials: { secrets: { apiKey: string } };
        };
        payload.credentials.secrets.apiKey = apiKey;
        record.payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
        record.description.revision = String(Number(record.description.revision) + 1);
        eventSequence++;
      }
    },
    changeUsageSupport: (supportsUsage: string) => {
      for (const record of sharedRecords) record.description.metadata.supportsUsage = supportsUsage;
      eventSequence++;
    },
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

describe("profile-local credential migration", () => {
  it("verifies a returned SQLite snapshot against the existing local id and immutable creation time", async () => {
    const source = await setup();
    const { migrationKey } = await source.service.exportCredentials(source.vaultDirectory);
    const storage = new SqliteStorage(":memory:");
    const mutations = new CredentialMutationGate();
    const credentials = new CredentialVault(storage, source.cipher, undefined, mutations);
    const switcher = new SwitchingCredentialService(credentials);
    const receiver = new CredentialMigrationService({
      ...source.options,
      cacheDirectory: path.join(source.directory, "receiver"),
      storage,
      mutations,
      switcher,
    });
    try {
      const local = { ...account, id: "local-account", createdAt: "2026-01-01T00:00:00.000Z" };
      await credentials.saveAccount(local, {
        ...(await source.credentials.load(account.id)),
        accountId: local.id,
        secrets: { apiKey: "FICTIONAL-LOCAL" },
      });
      const preview = await receiver.verifyImport({
        vaultDirectory: source.vaultDirectory,
        migrationKey,
      });
      expect(preview.conflicts?.map((a) => a.id)).toEqual([account.id]);
      await receiver.confirmImport(preview.previewId);
      await receiver.enableShared();
      await receiver.returnToPrivate(true);
      expect(await receiver.getStatus()).toMatchObject({
        migrationState: "private-ready",
        recordCount: 1,
        rememberedKey: true,
      });
      expect(storage.accounts.list()).toEqual([local]);
      await receiver.switchToPrivate();
      expect((await switcher.load(local.id)).secrets.apiKey).toBe("FICTIONAL-ONLY");
      expect(await receiver.getStatus()).toMatchObject({
        migrationState: "private",
        rememberedKey: false,
      });
    } finally {
      await receiver.stop();
      storage.close();
    }
  });
  it("verifies one publication, releases local writers and can migrate without a receiver or key acknowledgement", async () => {
    const f = await setup();
    const delivery = await f.service.exportCredentials(f.vaultDirectory);
    expect(await f.service.getStatus()).toMatchObject({
      migrationState: "export-ready",
      activeBackend: "private",
      rememberedKey: true,
      frozen: false,
    });
    await f.service.enableShared();
    expect((await f.service.resumeExport())?.migrationKey).toBe(delivery.migrationKey);
    expect(await f.service.getStatus()).toMatchObject({
      migrationState: "shared",
      activeBackend: "shared",
    });
    await f.service.acknowledgeDelivery();
    await expect(f.service.resumeExport()).resolves.toBeNull();
    expect(JSON.stringify(await f.service.getStatus())).not.toContain(delivery.migrationKey);
    expect(f.initialize).toHaveBeenCalledOnce();
    expect(f.call.mock.calls.map((c) => c[0])).not.toContain("handoff");
  });
  it("recovers the published receipt after process restart and local changes, then explicitly reviews divergence", async () => {
    const f = await setup();
    f.loseResponse();
    await expect(f.service.exportCredentials(f.vaultDirectory)).rejects.toThrow();
    expect(await f.service.getStatus()).toMatchObject({
      migrationState: "private",
      frozen: false,
      rememberedKey: false,
      operation: { kind: "export" },
    });
    const envelope = await f.credentials.load(account.id);
    await f.credentials.saveAccount(account, {
      ...envelope,
      secrets: { apiKey: "FICTIONAL-LOCAL-CHANGED" },
    });
    await f.service.stop();
    const resumed = new CredentialMigrationService(f.options);
    services.push(resumed);
    await resumed.exportCredentials(f.vaultDirectory);
    expect(f.initialize).toHaveBeenCalledOnce();
    await expect(resumed.enableShared()).rejects.toThrow("migration-review-required");
    const review = (await resumed.getStatus()).migrationReview!;
    expect(review.accounts[0]?.id).toBe(account.id);
    f.updateShared("FICTIONAL-REMOTE-CHANGED");
    await expect(resumed.enableShared(review.id)).rejects.toThrow("migration-review-required");
    await resumed.enableShared((await resumed.getStatus()).migrationReview!.id);
    expect((await f.switcher.load(account.id)).secrets.apiKey).toBe("FICTIONAL-REMOTE-CHANGED");
    expect((await f.credentials.load(account.id)).secrets.apiKey).toBe("FICTIONAL-LOCAL-CHANGED");
  });
  it("keeps an encrypted private-ready snapshot and key through restart, and refuses a stale snapshot", async () => {
    const f = await setup();
    const delivery = await f.service.exportCredentials(f.vaultDirectory);
    await f.service.enableShared();
    await expect(f.service.returnToPrivate(false)).rejects.toThrow(
      "independent-refresh-risk-not-accepted",
    );
    f.updateShared("FICTIONAL-CURRENT");
    await f.service.returnToPrivate(true);
    expect(await f.service.getStatus()).toMatchObject({
      migrationState: "private-ready",
      selectedBackend: "shared",
      rememberedKey: true,
      frozen: false,
    });
    await f.service.stop();
    const resumed = new CredentialMigrationService(f.options);
    services.push(resumed);
    await resumed.start();
    expect(await resumed.getStatus()).toMatchObject({
      migrationState: "private-ready",
      activeBackend: "shared",
    });
    f.updateShared("FICTIONAL-NEWER");
    await expect(resumed.switchToPrivate()).rejects.toThrow("private-snapshot-stale");
    expect(await resumed.getStatus()).toMatchObject({
      migrationState: "private-ready",
      rememberedKey: true,
      frozen: false,
    });
    await resumed.returnToPrivate(true);
    await resumed.switchToPrivate();
    expect((await f.switcher.load(account.id)).secrets.apiKey).toBe("FICTIONAL-NEWER");
    expect(await resumed.getStatus()).toMatchObject({
      migrationState: "private",
      rememberedKey: false,
      activeBackend: "private",
    });
    await resumed.rejoinShared(delivery.migrationKey);
    expect(await resumed.getStatus()).toMatchObject({
      migrationState: "import-ready",
      activeBackend: "private",
    });
  });
  it("reconciles an authorized empty snapshot while preserving unrelated private accounts", async () => {
    const f = await setup();
    await f.service.exportCredentials(f.vaultDirectory);
    await f.service.enableShared();
    const separate = { ...account, id: "independent", stableIdentity: "different" };
    await f.credentials.saveAccount(separate, {
      ...(await f.credentials.load(account.id)),
      accountId: separate.id,
    });
    f.deleteShared();
    await f.service.returnToPrivate(true);
    expect(await f.service.getStatus()).toMatchObject({
      migrationState: "private-ready",
      recordCount: 0,
    });
    await f.service.switchToPrivate();
    expect(f.storage.accounts.list().map((a) => a.id)).toEqual(["independent"]);
  });
  it("does not commit an export binding if authenticated metadata or payload differs from the original snapshot", async () => {
    const f = await setup();
    f.tamper();
    await expect(f.service.exportCredentials(f.vaultDirectory)).rejects.toThrow(
      "export-readback-mismatch",
    );
    expect(await f.service.getStatus()).toMatchObject({
      migrationState: "private",
      rememberedKey: false,
      frozen: false,
    });
  });
  it("cannot publish a nonempty location, when authorization is underway, or without secure protection", async () => {
    const f = await setup();
    await mkdir(f.vaultDirectory);
    await writeFile(path.join(f.vaultDirectory, "keep"), "data");
    await expect(f.service.exportCredentials(f.vaultDirectory)).rejects.toThrow(
      "vault-directory-not-empty",
    );
    await rm(path.join(f.vaultDirectory, "keep"));
    f.activeAuth();
    await expect(f.service.exportCredentials(f.vaultDirectory)).rejects.toThrow(
      "authorization-in-progress",
    );
    f.cipher.isAvailable = async () => false;
    await expect(f.service.exportCredentials(f.vaultDirectory)).rejects.toThrow(
      "secure-storage-unavailable",
    );
    expect(f.initialize).not.toHaveBeenCalled();
    expect(f.mutations.isFrozen).toBe(false);
  });
  it("keeps the original export recoverable after a system key protection failure", async () => {
    const f = await setup();
    const encrypt = f.cipher.encrypt;
    f.cipher.encrypt = async () => {
      throw Error();
    };
    await expect(f.service.exportCredentials(f.vaultDirectory)).rejects.toThrow();
    expect((await f.service.getStatus()).migrationState).toBe("private");
    f.cipher.encrypt = encrypt;
    await f.service.resumeExport();
    expect(f.initialize).toHaveBeenCalledOnce();
    const profile = await readFile(
      path.join(f.options.cacheDirectory, "migration-state.json"),
      "utf8",
    );
    expect(profile).not.toContain("FICTIONAL-ONLY");
    expect(profile).not.toContain("acm1_");
  });
  it("preserves shared selection and keys when the destination business read fails", async () => {
    const f = await setup();
    await f.service.exportCredentials(f.vaultDirectory);
    await f.service.enableShared();
    await f.service.returnToPrivate(true);
    vi.spyOn(f.switcher, "load").mockRejectedValueOnce(Error("private business read failed"));
    await expect(f.service.switchToPrivate()).rejects.toThrow();
    expect(await f.service.getStatus()).toMatchObject({
      migrationState: "private-ready",
      activeBackend: "shared",
      rememberedKey: true,
      frozen: false,
    });
    await f.service.switchToPrivate();
    expect((await f.service.getStatus()).rememberedKey).toBe(false);
  });
  it("commits private selection before key deletion, and retries cleanup without restoring the snapshot", async () => {
    const f = await setup();
    await f.service.exportCredentials(f.vaultDirectory);
    await f.service.enableShared();
    await f.service.returnToPrivate(true);
    const forget = vi.fn().mockRejectedValueOnce(Error("locked")).mockResolvedValue(undefined);
    f.options.host.forgetGrant = forget;
    await f.service.switchToPrivate();
    expect(await f.service.getStatus()).toMatchObject({
      migrationState: "private",
      keyCleanupPending: true,
      rememberedKey: true,
    });
    await f.credentials.saveAccount(account, {
      ...(await f.credentials.load(account.id)),
      secrets: { apiKey: "FICTIONAL-AFTER-RETURN" },
    });
    await f.service.retry();
    expect(await f.service.getStatus()).toMatchObject({
      migrationState: "private",
      keyCleanupPending: false,
      rememberedKey: false,
    });
    expect((await f.switcher.load(account.id)).secrets.apiKey).toBe("FICTIONAL-AFTER-RETURN");
  });
  it("accepts an explicitly selected verified offline copy and rejects damaged or incomplete snapshots", async () => {
    const f = await setup();
    await f.service.exportCredentials(f.vaultDirectory);
    await f.service.enableShared();
    f.options.host.connect = async () => {
      throw new BrokerError("broker-disconnected");
    };
    const snapshotAt = (await f.service.getStatus()).snapshotAt!;
    const ciphertext = f.storage.credentials.get(account.id)!;
    f.storage.credentials.save({ ...ciphertext, ciphertext: Buffer.from("damaged") });
    await expect(f.service.returnToPrivate(true, snapshotAt)).rejects.toThrow();
    expect(await f.service.getStatus()).toMatchObject({
      migrationState: "shared",
      rememberedKey: true,
    });
    f.storage.credentials.save(ciphertext);
    await expect(f.service.returnToPrivate(true)).rejects.toThrow("confirm-offline-snapshot");
    await f.service.returnToPrivate(true, snapshotAt);
    await f.service.switchToPrivate();
    expect((await f.service.getStatus()).migrationState).toBe("private");
  });
  it("rejects legacy settings without a migration profile and uses the current profile once present", async () => {
    const f = await setup();
    f.storage.settings.save("credentialSharing.frozen", true);
    expect(() => new CredentialMigrationService(f.options)).toThrow(
      MigrationProfileUpgradeRequired,
    );
    await mkdir(f.options.cacheDirectory);
    await writeFile(
      path.join(f.options.cacheDirectory, "migration-state.json"),
      JSON.stringify({
        product: "polyquota",
        formatVersion: 1,
        migrationState: "private",
        selectedBackend: "private",
        binding: null,
      }),
    );
    const loaded = new CredentialMigrationService(f.options);
    services.push(loaded);
    expect(await loaded.getStatus()).toMatchObject({ migrationState: "private", frozen: false });
  });
  it("does not register or initialize the missing old location during a bound reconnect or delivery", async () => {
    const f = await setup();
    await f.service.exportCredentials(f.vaultDirectory);
    await f.service.enableShared();
    await f.service.stop();
    const { rename } = await import("node:fs/promises");
    await rename(f.vaultDirectory, path.join(f.directory, "moved"));
    const connect = vi.spyOn(f.options.host, "connect");
    const restored = new CredentialMigrationService(f.options);
    services.push(restored);
    await restored.start();
    expect(await restored.getStatus()).toMatchObject({
      migrationState: "shared",
      activeBackend: "unavailable",
    });
    await expect(restored.resumeExport()).rejects.toThrow("vault-directory-missing");
    await expect(restored.acknowledgeDelivery()).rejects.toThrow("vault-directory-missing");
    expect(connect).not.toHaveBeenCalled();
  });
  it("resumes an existing shared binding using only its registered grant", async () => {
    const f = await setup();
    await f.service.exportCredentials(f.vaultDirectory);
    await f.service.enableShared();
    await f.service.stop();
    const connect = vi.spyOn(f.options.host, "connect");
    const restored = new CredentialMigrationService(f.options);
    services.push(restored);
    await restored.start();
    expect(restored.getBackendContext().active).toBe("shared");
    expect(connect).toHaveBeenCalled();
    for (const call of connect.mock.calls)
      expect(call).toEqual([
        f.vaultDirectory,
        expect.any(String),
        expect.any(String),
        { existingGrantOnly: true },
      ]);
  });
  it("recovers a private snapshot transaction committed immediately before its B3 profile receipt", async () => {
    const f = await setup();
    await f.service.exportCredentials(f.vaultDirectory);
    await f.service.enableShared();
    const filename = path.join(f.options.cacheDirectory, "migration-state.json");
    const shared = JSON.parse(await readFile(filename, "utf8"));
    await f.service.returnToPrivate(true);
    await f.service.stop();
    const receipt = JSON.parse(
      f.storage.settings.get("credentialSharing.privateSnapshot.vault") as string,
    );
    shared.operation = {
      id: receipt.operationId,
      kind: "prepare-private",
      clientId: shared.binding.clientId,
      vaultDirectory: f.vaultDirectory,
    };
    await writeFile(filename, JSON.stringify(shared));
    const restored = new CredentialMigrationService(f.options);
    services.push(restored);
    await restored.start();
    expect(await restored.getStatus()).toMatchObject({
      migrationState: "private-ready",
      activeBackend: "shared",
      rememberedKey: true,
    });
  });
  it("reconciles records deleted between two memberships in the same vault", async () => {
    const f = await setup();
    const { migrationKey } = await f.service.exportCredentials(f.vaultDirectory);
    await f.service.enableShared();
    await f.service.returnToPrivate(true);
    await f.service.switchToPrivate();
    await f.service.rejoinShared(migrationKey);
    await f.service.enableShared();
    f.deleteShared();
    await f.service.returnToPrivate(true);
    await f.service.switchToPrivate();
    expect(f.storage.accounts.get(account.id)).toBeNull();
  });
});
