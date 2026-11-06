import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import {
  CredentialVault,
  CredentialMutationGate,
  MemoryStorage,
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
import {
  CredentialSharingService,
  sharingFrozenKey,
  sharingStateKey,
} from "../src/credential-sharing/service.js";
import type { BrokerHost } from "../src/credential-sharing/broker-host.js";

const directories: string[] = [];
const services: CredentialSharingService[] = [];
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
  let sourceClientId = "";
  let owner = "uninitialized";
  let loseResponse = false;
  let ack = false;
  let tamper = false;
  let activeAuth = false;
  let handoffResponseLost = false;
  let disconnected = false;
  let sourceWatermark = "";
  let exportOperationId = "";
  let handoffOperationId: string | undefined;
  let sharedRecords: BrokerCredential[] = [];
  let receiverPrepared = false;
  let eventSequence = 0;
  let handoffs = 0;
  const initialize = vi.fn(async (params: unknown) => {
    const request = params as {
      records: InitialRecord[];
      operationId: string;
      sourceWatermark: string;
    };
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
    if (method === "getOperation") {
      const operationId = (params as { operationId: string }).operationId;
      if (operationId === exportOperationId) return initialized;
      if (operationId === handoffOperationId)
        return { ownership: "broker", storageVersion: "version" };
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
        preparedClientIds: receiverPrepared ? [sourceClientId, "graph-agent"] : [sourceClientId],
        ownership: owner,
      };
    if (method === "handoff") {
      handoffs++;
      owner = "broker";
      handoffOperationId = (params as { operationId: string }).operationId;
      if (handoffResponseLost) throw new BrokerError("broker-disconnected");
      return { ownership: "broker", storageVersion: "version" };
    }
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
      installedVersion: "0.2.0",
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
    credentials: switcher,
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
  const service = new CredentialSharingService(options);
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
    receiverReady: () => {
      receiverPrepared = true;
    },
    loseHandoffResponse: () => {
      handoffResponseLost = true;
    },
    handoffs: () => handoffs,
    disconnected: () => disconnected,
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

  it("rejects an incompatible installed component before freezing, reading credentials or connecting", async () => {
    const c = await setup();
    vi.spyOn(c.options.host, "inspect").mockResolvedValue({
      installState: "incompatible",
      installedVersion: "0.1.0",
      installationDirectory: path.join(c.directory, "old-component"),
    });
    const connect = vi.spyOn(c.options.host, "connect");
    const decrypt = vi.spyOn(c.cipher, "decrypt");
    const freeze = vi.spyOn(c.mutations, "freeze");
    await expect(c.service.exportCredentials(c.vaultDirectory)).rejects.toThrow(
      "component-incompatible",
    );
    expect(connect).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(freeze).not.toHaveBeenCalled();
    expect(c.storage.settings.get(sharingStateKey)).toBeNull();
    expect(c.storage.settings.get(sharingFrozenKey)).not.toBe(true);
    expect(await c.service.getStatus()).toMatchObject({
      installState: "incompatible",
      installedVersion: "0.1.0",
      requiredApiLevel: "2",
      activeBackend: "private",
      exportState: "none",
    });
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

describe("PolyQuota shared activation and return to private", () => {
  async function exported() {
    const context = await setup();
    const delivery = await context.service.exportCredentials(context.vaultDirectory);
    await context.service.acknowledgeDelivery();
    context.receiverReady();
    return { ...context, migrationKey: delivery.migrationKey };
  }

  it("blocks activation and reentry before requests or key reads when the installation becomes incompatible", async () => {
    const c = await exported();
    const incompatible = {
      installState: "incompatible" as const,
      installedVersion: "0.1.0",
      installationDirectory: path.join(c.directory, "old-component"),
    };
    const inspect = vi.spyOn(c.options.host, "inspect").mockResolvedValue(incompatible);
    const connect = vi.spyOn(c.options.host, "connect");
    const decrypt = vi.spyOn(c.cipher, "decrypt");
    const freeze = vi.spyOn(c.mutations, "freeze");
    const sourceState = c.storage.settings.get(sharingStateKey);
    await expect(c.service.enableShared()).rejects.toThrow("component-incompatible");
    expect(c.storage.settings.get(sharingStateKey)).toEqual(sourceState);
    expect(connect).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(freeze).not.toHaveBeenCalled();
    inspect.mockRestore();
    await c.service.enableShared();
    await c.service.returnToPrivate(true);
    vi.spyOn(c.options.host, "inspect").mockResolvedValue(incompatible);
    connect.mockClear();
    decrypt.mockClear();
    freeze.mockClear();
    const privateState = c.storage.settings.get(sharingStateKey);
    await expect(c.service.rejoinShared(c.migrationKey)).rejects.toThrow("component-incompatible");
    expect(c.storage.settings.get(sharingStateKey)).toEqual(privateState);
    expect(connect).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(freeze).not.toHaveBeenCalled();
    expect(c.switcher.isShared).toBe(false);
  });

  it("requires a prepared receiver and activates without copying shared tokens into the private database", async () => {
    const c = await setup();
    await c.service.exportCredentials(c.vaultDirectory);
    await c.service.acknowledgeDelivery();
    await expect(c.service.enableShared()).rejects.toThrow("client-not-prepared");
    expect(c.handoffs()).toBe(0);
    const original = c.storage.credentials.get(account.id);
    c.receiverReady();
    await c.service.enableShared();
    c.updateShared("SHARED-C2");
    expect((await c.switcher.load(account.id)).secrets.apiKey).toBe("SHARED-C2");
    expect(c.storage.credentials.get(account.id)).toEqual(original);
    expect(await c.service.getStatus()).toMatchObject({
      selectedBackend: "shared",
      activeBackend: "shared",
      sharingState: "active",
      frozen: false,
    });
    expect(c.service.visibleAccountIds()).toEqual(new Set([account.id]));
  });

  it("recovers a lost handoff response across restart without reexport or private fallback", async () => {
    const c = await exported();
    c.loseHandoffResponse();
    await expect(c.service.enableShared()).rejects.toThrow("broker-disconnected");
    expect(await c.service.getStatus()).toMatchObject({
      selectedBackend: "shared",
      activeBackend: "unavailable",
      frozen: true,
    });
    await expect(c.switcher.load(account.id)).rejects.toThrow("共享凭据暂不可用");
    const restarted = new CredentialSharingService(c.options);
    services.push(restarted);
    await restarted.start();
    expect(await restarted.getStatus()).toMatchObject({ activeBackend: "shared", frozen: false });
    expect(c.handoffs()).toBe(1);
    expect(c.initialize).toHaveBeenCalledTimes(1);
  });

  it("retries an uncommitted handoff from the frozen private source and still rejects a changed watermark", async () => {
    const c = await exported();
    const originalCall = c.call.getMockImplementation()!;
    c.call.mockImplementation(async (method, params) => {
      if (method === "handoff") throw new BrokerError("broker-disconnected");
      return originalCall(method, params);
    });
    await expect(c.service.enableShared()).rejects.toThrow("broker-disconnected");
    expect(c.handoffs()).toBe(0);
    c.call.mockImplementation(originalCall);
    const restarted = new CredentialSharingService(c.options);
    services.push(restarted);
    await restarted.start();
    expect(await restarted.getStatus()).toMatchObject({ activeBackend: "shared", frozen: false });
    expect(c.handoffs()).toBe(1);
    expect(c.initialize).toHaveBeenCalledTimes(1);

    const d = await exported();
    const secondCall = d.call.getMockImplementation()!;
    d.call.mockImplementation(async (method, params) => {
      if (method === "handoff") throw new BrokerError("broker-disconnected");
      return secondCall(method, params);
    });
    await expect(d.service.enableShared()).rejects.toThrow("broker-disconnected");
    d.call.mockImplementation(secondCall);
    const encrypted = d.storage.credentials.get(account.id)!;
    d.storage.credentials.save({ ...encrypted, updatedAt: "external-instance-updated" });
    await expect(d.service.enableShared()).rejects.toThrow("source-watermark-changed");
    expect(d.handoffs()).toBe(0);
    expect(await d.service.getStatus()).toMatchObject({
      activeBackend: "unavailable",
      frozen: true,
    });
  });

  it("saves the latest private snapshot, forgets its key and requires the migration key to rejoin current shared data", async () => {
    const c = await exported();
    await c.service.enableShared();
    c.updateShared("SHARED-C2");
    await expect(c.service.returnToPrivate(false)).rejects.toThrow(
      "independent-refresh-risk-not-accepted",
    );
    await c.service.returnToPrivate(true);
    expect(c.disconnected()).toBe(true);
    expect(await c.service.getStatus()).toMatchObject({
      selectedBackend: "private",
      activeBackend: "private",
      sharingState: "private",
      rememberedKey: false,
      keyCleanupPending: false,
      frozen: false,
    });
    expect((await c.credentials.load(account.id)).secrets.apiKey).toBe("SHARED-C2");
    await c.switcher.saveAccount(account, {
      version: 1,
      accountId: account.id,
      provider: account.provider,
      authMethod: account.authMethod,
      expiresAt: null,
      secrets: { apiKey: "PRIVATE-C3" },
    });
    await expect(c.service.enableShared()).rejects.toThrow("migration-key-required");
    const callsBeforeWrongKey = c.call.mock.calls.length;
    await expect(c.service.rejoinShared("wrong-key")).rejects.toThrow("invalid-migration-key");
    expect(c.call.mock.calls.length).toBe(callsBeforeWrongKey);
    expect((await c.service.getStatus()).rememberedKey).toBe(false);
    c.updateShared("SHARED-C4");
    await c.service.rejoinShared(c.migrationKey);
    expect((await c.switcher.load(account.id)).secrets.apiKey).toBe("SHARED-C4");
    expect((await c.credentials.load(account.id)).secrets.apiKey).toBe("PRIVATE-C3");
    expect(c.handoffs()).toBe(1);
    expect(c.initialize).toHaveBeenCalledTimes(1);
  });

  it("returns offline using the dated prior private copy and retries only its own session cleanup on restart", async () => {
    const c = await exported();
    await c.service.enableShared();
    const date = (await c.service.getStatus()).snapshotAt;
    c.updateShared("SHARED-C2");
    const connectedCall = c.call.getMockImplementation()!;
    c.call.mockImplementation(async () => {
      throw new BrokerError("broker-disconnected");
    });
    await c.service.returnToPrivate(true);
    expect(await c.service.getStatus()).toMatchObject({
      activeBackend: "private",
      snapshotAt: date,
      sessionCleanupPending: true,
      keyCleanupPending: false,
      rememberedKey: false,
      lastError: "using-previous-private-snapshot",
    });
    expect((await c.credentials.load(account.id)).secrets.apiKey).toBe("FICTIONAL-ONLY");
    c.call.mockImplementation(connectedCall);
    const restarted = new CredentialSharingService(c.options);
    services.push(restarted);
    await restarted.start();
    expect(await restarted.getStatus()).toMatchObject({
      activeBackend: "private",
      sharingState: "private",
      sessionCleanupPending: false,
      rememberedKey: false,
    });
    expect(c.handoffs()).toBe(1);
  });

  it("keeps private selection and a durable cleanup marker when key deletion fails", async () => {
    const c = await exported();
    await c.service.enableShared();
    const state = JSON.parse(c.storage.settings.get(sharingStateKey) as string) as {
      keyRef: string;
    };
    const keyPath = path.join(c.options.cacheDirectory, state.keyRef);
    await rm(keyPath);
    await mkdir(keyPath);
    await c.service.returnToPrivate(true);
    expect(await c.service.getStatus()).toMatchObject({
      activeBackend: "private",
      keyCleanupPending: true,
      sharingState: "returning",
      frozen: false,
    });
    await rm(keyPath, { recursive: true });
    const restarted = new CredentialSharingService(c.options);
    services.push(restarted);
    await restarted.start();
    expect(await restarted.getStatus()).toMatchObject({
      activeBackend: "private",
      keyCleanupPending: false,
      sharingState: "private",
    });
  });

  it("does not overwrite the previous private snapshot when staged readback is damaged", async () => {
    const c = await exported();
    await c.service.enableShared();
    c.updateShared("SHARED-C2");
    const prior = c.storage.credentials.get(account.id);
    const encrypt = c.cipher.encrypt;
    vi.spyOn(c.cipher, "encrypt").mockImplementation(async (plaintext) =>
      plaintext.includes("SHARED-C2") ? Buffer.from("encrypted:damaged") : encrypt(plaintext),
    );
    await c.service.returnToPrivate(true);
    expect(c.storage.credentials.get(account.id)).toEqual(prior);
    expect((await c.credentials.load(account.id)).secrets.apiKey).toBe("FICTIONAL-ONLY");
    expect((await c.service.getStatus()).lastError).toBe("using-previous-private-snapshot");
  });

  it("rechecks changed metadata and does not read secrets on empty event polls", async () => {
    const c = await exported();
    vi.useFakeTimers();
    await c.service.enableShared();
    const initialReads = c.call.mock.calls.filter(([method]) => method === "getCredential").length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(c.call.mock.calls.filter(([method]) => method === "getCredential")).toHaveLength(
      initialReads,
    );
    c.storage.accounts.setEnabled(account.id, false, new Date().toISOString());
    c.updateShared("SHARED-C2");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(c.storage.accounts.get(account.id)?.enabled).toBe(false);
    c.changeUsageSupport("false");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(c.service.visibleAccountIds()).toEqual(new Set());
    const filteredReads = c.call.mock.calls.filter(([method]) => method === "getCredential").length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(c.call.mock.calls.filter(([method]) => method === "getCredential")).toHaveLength(
      filteredReads,
    );
  });

  it("keeps the shared backend usable when an unavailable broker and missing private copy prevent return", async () => {
    const c = await exported();
    await c.service.enableShared();
    const state = JSON.parse(c.storage.settings.get(sharingStateKey) as string) as Record<
      string,
      unknown
    >;
    delete state.snapshotAt;
    c.storage.settings.save(sharingStateKey, JSON.stringify(state));
    const connectedCall = c.call.getMockImplementation()!;
    c.call.mockImplementation(async () => {
      throw new BrokerError("broker-disconnected");
    });
    await expect(c.service.returnToPrivate(true)).rejects.toThrow("broker-disconnected");
    expect(c.mutations.isFrozen).toBe(false);
    expect(await c.service.getStatus()).toMatchObject({
      selectedBackend: "shared",
      activeBackend: "shared",
      rememberedKey: true,
    });
    c.call.mockImplementation(connectedCall);
    expect((await c.switcher.load(account.id)).secrets.apiKey).toBe("FICTIONAL-ONLY");
  });
});
