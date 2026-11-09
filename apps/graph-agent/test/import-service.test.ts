import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { BrokerError, type TransferSnapshot } from "@astra-conductor/credentials";
import {
  CredentialMigrationService,
  CredentialVault,
  CredentialMutationGate,
  MemoryStorage,
  SwitchingCredentialService,
  type ProviderRegistry,
  type CredentialCipherPort,
} from "@astra-conductor/core/internal";
import type { ComponentInstallation } from "@astra-conductor/credentials/host/windows";
import { transferFixture } from "./transfer-fixture.js";

const roots: string[] = [];
const services: CredentialMigrationService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fictionalSecret = "FICTIONAL-ONLY-SECRET-123456";
function record(): TransferSnapshot["records"][number] {
  const account = {
    id: "account",
    provider: "codex",
    offeringId: "codex",
    authMethod: "cli-import",
    stableIdentity: "fictional",
    displayName: "test",
    maskedIdentifier: "fic***",
    enabled: true,
    credentialState: "available",
    publicMetadata: {},
    createdAt: "2026-11-06T00:00:00Z",
    updatedAt: "2026-11-06T00:00:00Z",
  };
  return {
    description: {
      credentialId: "account",
      revision: "1",
      createdByClientId: "polyquota",
      lastUpdatedByClientId: "polyquota",
      contentType: "application/vnd.astraconductor.account-credential+json",
      payloadFormatVersion: 1,
      metadata: {
        provider: "codex",
        offeringId: "codex",
        authMethod: "cli-import",
        maskedIdentifier: "fic***",
        supportsUsage: "true",
      },
    },
    payload: Buffer.from(
      JSON.stringify({
        version: 1,
        account,
        credentials: {
          version: 1,
          accountId: "account",
          provider: "codex",
          authMethod: "cli-import",
          expiresAt: null,
          secrets: { refreshToken: fictionalSecret },
        },
      }),
    ).toString("base64url"),
  };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "graph-import-test-"));
  roots.push(root);
  const vault = path.join(root, "vault");
  const directory = path.join(root, "graph");
  const transfer = transferFixture([record()]);
  await mkdir(path.join(vault, "versions", "version"), { recursive: true });
  await writeFile(path.join(vault, "manifest.json"), JSON.stringify({ vaultId: "vault" }));
  await writeFile(path.join(vault, "versions", "version", "migration.json"), transfer.bytes);
  await writeFile(path.join(vault, "versions", "version", "version.json"), transfer.versionBytes);
  const key = randomBytes(32);
  const cipher: CredentialCipherPort = {
    isAvailable: async () => true,
    encrypt: async (plain) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    },
    decrypt: async (encrypted) => {
      const bytes = Buffer.from(encrypted);
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return {
        plaintext: Buffer.concat([
          decipher.update(bytes.subarray(12, -16)),
          decipher.final(),
        ]).toString(),
        shouldReEncrypt: false,
      };
    },
  };
  let installState: ComponentInstallation["installState"] = "installed";
  let owned = true;
  const host = {
    localPackageDirectory: root,
    inspect: vi.fn(async () => ({
      installState,
      installedVersion: "0.3.0",
      installedApiLevel: "3",
      installationDirectory: root,
    })),
    install: async () => {},
    uninstall: async () => {},
    forgetGrant: vi.fn(async () => {}),
    revokeGrant: vi.fn(async () => {}),
    connect: vi.fn(async () => ({
      close() {},
      call: async (method: string) => {
        switch (method) {
          case "getSharingState":
            return {
              ...transfer.version,
              sourceWatermark: "watermark",
              sourceClientId: "source",
              preparedClientIds: [],
              ownership: owned ? "broker" : "source",
            };
          case "getSnapshotWatermark":
            return { vaultId: "vault", storageVersion: "version", watermark: "current" };
          case "listCredentials":
            return { items: [record().description], nextCursor: null };
          case "getCredential":
            return record();
          case "getEvents":
            return { items: [], nextCursor: "0" };
          default:
            throw new BrokerError("method-not-found");
        }
      },
    })),
  };
  const storage = new MemoryStorage();
  const mutations = new CredentialMutationGate();
  const credentials = new CredentialVault(storage, cipher, undefined, mutations);
  const switcher = new SwitchingCredentialService(credentials);
  const options = {
    product: "graph-agent" as const,
    cacheDirectory: directory,
    storage,
    cipher,
    mutations,
    switcher,
    providers: {
      getUsage: () => ({}),
      getAccount: () => ({ refreshCredentials: () => {} }),
      findOffering: () => ({
        provider: "codex",
        offering: { authMethods: [{ method: "cli-import" }] },
      }),
    } as unknown as ProviderRegistry,
    host,
    hasActiveAuth: () => false,
  };
  const make = () => {
    const service = new CredentialMigrationService(options);
    services.push(service);
    return service;
  };
  return {
    vault,
    directory,
    transfer,
    cipher,
    host,
    make,
    options,
    storage,
    credentials,
    switcher,
    setOwner: (value: boolean) => {
      owned = value;
    },
    setInstallation: (value: ComponentInstallation["installState"]) => {
      installState = value;
    },
  };
}
describe("GraphAgent local migration binding", () => {
  it("inspects the component without starting a broker, and disallows incompatible components before preview", async () => {
    const f = await fixture(),
      service = f.make();
    expect(await service.getStatus()).toMatchObject({
      migrationState: "private",
      role: "both",
      activeBackend: "private",
    });
    f.setInstallation("incompatible");
    await expect(
      service.verifyImport({ vaultDirectory: f.vault, migrationKey: f.transfer.migrationKey }),
    ).rejects.toThrow("component-incompatible");
    expect(f.host.connect).not.toHaveBeenCalled();
  });
  it("rejects an incorrect key and cancels a valid masked preview without creating any client grant or protected key", async () => {
    const f = await fixture(),
      service = f.make();
    await expect(
      service.verifyImport({ vaultDirectory: f.vault, migrationKey: "incorrect" }),
    ).rejects.toThrow("invalid-migration-key");
    const preview = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    expect(preview.accounts).toMatchObject([
      { id: "account", provider: "codex", maskedIdentifier: "fic***" },
    ]);
    expect(JSON.stringify(preview)).not.toContain(fictionalSecret);
    await service.cancelPreview();
    await expect(service.confirmImport(preview.previewId)).rejects.toThrow(
      "import-preview-expired",
    );
    expect((await readdir(f.directory)).filter((file) => file.endsWith(".key"))).toEqual([]);
    expect(f.host.connect).not.toHaveBeenCalled();
    expect(await service.getStatus()).toMatchObject({
      migrationState: "private",
      operation: null,
      rememberedKey: false,
    });
  });
  it("retains a verified preview when protection fails and commits B2 only after readback", async () => {
    const f = await fixture(),
      service = f.make();
    const preview = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    const encrypt = vi.spyOn(f.cipher, "encrypt").mockRejectedValueOnce(Error("locked"));
    await expect(service.confirmImport(preview.previewId)).rejects.toThrow();
    expect(await service.getStatus()).toMatchObject({
      migrationState: "private",
      rememberedKey: false,
    });
    await service.confirmImport(preview.previewId);
    await service.confirmImport(preview.previewId);
    expect(encrypt).toHaveBeenCalledTimes(2);
    expect(await service.getStatus()).toMatchObject({
      migrationState: "import-ready",
      rememberedKey: true,
      activeBackend: "private",
    });
    const state = await readFile(path.join(f.directory, "migration-state.json"), "utf8");
    expect(state).not.toContain(f.transfer.migrationKey);
    expect(state).not.toContain(fictionalSecret);
  });
  it("cleans a staged key and operation-specific grant on cancellation after a failed registration", async () => {
    const f = await fixture(),
      service = f.make();
    const preview = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    f.setOwner(false);
    await expect(service.confirmImport(preview.previewId)).rejects.toThrow("sharing-not-active");
    expect(await service.getStatus()).toMatchObject({
      migrationState: "private",
      rememberedKey: false,
    });
    await service.cancelPreview();
    expect(f.host.revokeGrant).toHaveBeenCalledOnce();
    expect(f.host.forgetGrant).toHaveBeenCalledOnce();
    expect((await readdir(f.directory)).filter((file) => file.endsWith(".key"))).toEqual([]);
  });
  it("reopens B2 without connecting, and migrates only when the local user requests it", async () => {
    const f = await fixture(),
      service = f.make();
    const preview = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    await service.confirmImport(preview.previewId);
    await service.stop();
    const next = f.make();
    f.host.connect.mockClear();
    await next.start();
    expect(f.host.connect).not.toHaveBeenCalled();
    await next.enableShared();
    expect(await next.getStatus()).toMatchObject({
      migrationState: "shared",
      activeBackend: "shared",
    });
    expect((await f.switcher.load("account")).secrets.refreshToken).toBe(fictionalSecret);
    expect(f.storage.accounts.list()).toHaveLength(0);
    await next.stop();
    const offline = f.make();
    f.setInstallation("not-installed");
    await offline.start();
    expect(await offline.getStatus()).toMatchObject({
      migrationState: "shared",
      activeBackend: "unavailable",
    });
    await expect(offline.returnToPrivate(true)).rejects.toThrow();
    expect(f.host.forgetGrant).not.toHaveBeenCalled();
  });
  it("expires in-memory secrets while retaining the public directory for revalidation", async () => {
    const f = await fixture(),
      service = f.make();
    vi.useFakeTimers();
    try {
      const preview = await service.verifyImport({
        vaultDirectory: f.vault,
        migrationKey: f.transfer.migrationKey,
      });
      await vi.advanceTimersByTimeAsync(300_001);
      await expect(service.confirmImport(preview.previewId)).rejects.toThrow(
        "import-preview-expired",
      );
      expect((await service.getStatus()).operation?.vaultDirectory).toBe(f.vault);
      expect(f.host.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
