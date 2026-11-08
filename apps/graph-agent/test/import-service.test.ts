import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { BrokerError, canonical, type TransferSnapshot } from "@astra-conductor/credentials";
import type { CredentialCipherPort } from "@astra-conductor/core/internal";
import type { ComponentInstallation } from "@astra-conductor/credentials/host/windows";
import { GraphSharingService, type GraphSharingOptions } from "../src/server/import-service.js";
import { transferFixture } from "./transfer-fixture.js";

const roots: string[] = [];
const services: GraphSharingService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
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
  let ownership = "source";
  let failPrepare = false;
  let installState: ComponentInstallation["installState"] = "installed";
  let installedVersion = "0.0.1";
  let installedApiLevel = "2.125";
  const prepared = new Set<string>();
  const calls: string[] = [];
  const activate = vi.fn(async () => undefined);
  const host = {
    localPackageDirectory: path.join(root, "package"),
    inspect: vi.fn(async () => ({
      installState,
      installedVersion,
      installedApiLevel,
      installationDirectory: path.join(root, "component"),
    })),
    inspectPackage: async () => "ready" as const,
    status: vi.fn(async () => ({ serviceState: "READY", brokerOwnership: ownership })),
    install: async () => undefined,
    uninstall: async () => undefined,
    connect: vi.fn(async (_vault: string, clientId: string) => ({
      close() {},
      call: async (method: string, params?: unknown) => {
        calls.push(method);
        if (method === "getSharingState")
          return {
            ...transfer.version,
            sourceWatermark: "watermark",
            sourceClientId: "polyquota",
            ownership,
            preparedClientIds: [...prepared],
          };
        if (method === "prepareChallenge") return { challengeId: "challenge", nonce: "nonce" };
        if (method === "prepareClient") {
          if (failPrepare) throw new Error("offline");
          const request = params as {
            operationId: string;
            sourceWatermark: string;
            challengeId: string;
            proof: string;
          };
          const expected = createHmac("sha256", Buffer.alloc(32, 9))
            .update(
              canonical([
                "astra.prepare.v1",
                "vault",
                "version",
                clientId,
                request.operationId,
                "watermark",
                "challenge",
                "nonce",
              ]),
            )
            .digest("base64url");
          expect(request.proof).toBe(expected);
          prepared.add(clientId);
          return { storageVersion: "version", state: "prepared" };
        }
        throw new Error("unexpected method");
      },
    })),
  };
  const make = (overrides: Partial<GraphSharingOptions> = {}) => {
    const service = new GraphSharingService({
      host,
      cipher,
      directory,
      selectDirectory: async () => vault,
      canRefresh: (provider) => provider === "codex",
      activate,
      accounts: async () => [],
      refresh: async () => undefined,
      deactivate: async () => undefined,
      ...overrides,
    });
    services.push(service);
    return service;
  };
  return {
    root,
    vault,
    directory,
    transfer,
    host,
    calls,
    make,
    activate,
    cipher,
    setInstallation: (value: ComponentInstallation["installState"]) => {
      installState = value;
    },
    setComponentInfo: (version: string, apiLevel: string) => {
      installedVersion = version;
      installedApiLevel = apiLevel;
    },
    handoff: () => {
      ownership = "broker";
    },
    sourceOwns: () => {
      ownership = "source";
    },
    failPrepare: (value: boolean) => {
      failPrepare = value;
    },
  };
}
describe("GraphAgent import", () => {
  it("can replace a pending import with a newly exported location only after confirmation", async () => {
    const f = await fixture();
    const selectShared = vi.fn();
    const service = f.make({ selectShared });
    const first = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    await service.confirmImport(first.previewId);
    const before = await readFile(path.join(f.directory, "binding.json"));
    const secondVault = path.join(f.root, "new-vault");
    await mkdir(path.join(secondVault, "versions", "version"), { recursive: true });
    await writeFile(path.join(secondVault, "manifest.json"), JSON.stringify({ vaultId: "vault" }));
    await writeFile(
      path.join(secondVault, "versions", "version", "migration.json"),
      f.transfer.bytes,
    );
    await writeFile(
      path.join(secondVault, "versions", "version", "version.json"),
      f.transfer.versionBytes,
    );
    const next = await service.verifyImport({
      vaultDirectory: secondVault,
      migrationKey: f.transfer.migrationKey,
    });
    expect(await readFile(path.join(f.directory, "binding.json"))).toEqual(before);
    await service.confirmImport(next.previewId);
    const after = JSON.parse(await readFile(path.join(f.directory, "binding.json"), "utf8"));
    expect(after.vaultDirectory).toBe(secondVault);
    expect(after.clientId).not.toBe(JSON.parse(before.toString()).clientId);
    expect(selectShared).not.toHaveBeenCalled();
    f.handoff();
    await service.retry();
    await expect(
      service.verifyImport({ vaultDirectory: f.vault, migrationKey: f.transfer.migrationKey }),
    ).rejects.toMatchObject({ code: "import-location-fixed" });
    f.sourceOwns();
    const sharedBinding = await readFile(path.join(f.directory, "binding.json"));
    await expect(
      service.verifyImport({ vaultDirectory: secondVault, migrationKey: f.transfer.migrationKey }),
    ).rejects.toMatchObject({ code: "sharing-not-active" });
    expect(await readFile(path.join(f.directory, "binding.json"))).toEqual(sharedBinding);
  });
  it("keeps a prepared or restored pending import out of the selected shared backend", async () => {
    const f = await fixture();
    const selectShared = vi.fn();
    const first = f.make({ selectShared });
    const preview = await first.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    await first.confirmImport(preview.previewId);
    expect(await first.status()).toMatchObject({
      state: "import-ready",
      connected: false,
      accounts: [{ id: "account" }],
    });
    expect(selectShared).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
    await first.dispose();
    const restored = f.make({ selectShared });
    await restored.restore();
    expect((await restored.status()).state).toBe("import-ready");
    expect(selectShared).not.toHaveBeenCalled();
    f.handoff();
    await restored.retry();
    expect((await restored.status()).state).toBe("shared");
    expect(f.activate).toHaveBeenCalledOnce();
  });

  it("preserves a previously shared selection when its owner becomes unavailable", async () => {
    const f = await fixture();
    const deactivate = vi.fn(async () => undefined);
    const selectShared = vi.fn();
    const service = f.make({ deactivate, selectShared });
    const preview = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    await service.confirmImport(preview.previewId);
    f.handoff();
    await service.retry();
    f.sourceOwns();
    await expect(service.retry()).rejects.toMatchObject({ code: "sharing-not-active" });
    expect(await service.status()).toMatchObject({ state: "shared", connected: false });
    await service.dispose();
    const restored = f.make({ selectShared });
    await restored.restore();
    expect(selectShared).toHaveBeenCalledOnce();
    expect(await restored.status()).toMatchObject({ state: "shared", connected: false });
  });
  it("rejects insufficient API capability even when the component version is newer", async () => {
    const f = await fixture();
    f.setComponentInfo("9.9.9", "1.9");
    f.setInstallation("incompatible");
    const encrypt = vi.spyOn(f.cipher, "encrypt");
    const service = f.make();
    expect(await service.status()).toMatchObject({
      installState: "incompatible",
      state: "none",
      connected: false,
      installedVersion: "9.9.9",
      installedApiLevel: "1.9",
      requiredApiLevel: "2",
    });
    expect(f.host.status).not.toHaveBeenCalled();
    await expect(
      service.verifyImport({ vaultDirectory: f.vault, migrationKey: f.transfer.migrationKey }),
    ).rejects.toMatchObject({ code: "component-incompatible" });
    expect(f.host.connect).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    await expect(readdir(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rechecks compatibility before confirming a previously validated preview", async () => {
    const f = await fixture();
    const service = f.make();
    const preview = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    f.setInstallation("incompatible");
    f.host.connect.mockClear();
    f.calls.length = 0;
    const encrypt = vi.spyOn(f.cipher, "encrypt");
    await expect(service.confirmImport(preview.previewId)).rejects.toMatchObject({
      code: "component-incompatible",
    });
    expect(f.host.connect).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    await expect(readdir(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("blocks restoration, reconnect and refresh before contacting an incompatible broker", async () => {
    const f = await fixture();
    const refresh = vi.fn(async () => undefined);
    const service = f.make({ refresh });
    const preview = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    await service.confirmImport(preview.previewId);
    f.handoff();
    await service.retry();
    const before = await readFile(path.join(f.directory, "binding.json"));
    f.setInstallation("incompatible");
    f.host.connect.mockClear();
    f.host.status.mockClear();
    f.calls.length = 0;
    await expect(service.retry()).rejects.toMatchObject({ code: "component-incompatible" });
    await expect(service.refresh("account")).rejects.toMatchObject({
      code: "component-incompatible",
    });
    await service.restore();
    expect(await service.status()).toMatchObject({
      installState: "incompatible",
      connected: false,
      lastError: "component-incompatible",
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(f.host.connect).not.toHaveBeenCalled();
    expect(f.host.status).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(await readFile(path.join(f.directory, "binding.json"))).toEqual(before);
  });
  it("preserves an old broker's missing-method diagnostic without creating an import", async () => {
    const f = await fixture();
    const service = f.make({
      host: {
        ...f.host,
        connect: async () => ({
          close() {},
          call: async () => {
            throw new BrokerError("method-not-found");
          },
        }),
      },
    });
    await expect(
      service.verifyImport({ vaultDirectory: f.vault, migrationKey: f.transfer.migrationKey }),
    ).rejects.toMatchObject({ code: "method-not-found" });
    expect(await service.status()).toMatchObject({
      state: "none",
      rememberedKey: false,
      lastError: "method-not-found",
    });
    await expect(readdir(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("wrong migration key writes no binding or key and never prepares a client", async () => {
    const f = await fixture();
    const service = f.make();
    await expect(
      service.verifyImport({
        vaultDirectory: f.vault,
        migrationKey: `acm1_${Buffer.alloc(32, 8).toString("base64url")}`,
      }),
    ).rejects.toThrow();
    expect((await service.status()).state).toBe("none");
    expect(f.calls).not.toContain("prepareClient");
    await expect(readdir(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("accepts an older component with sufficient API and safely confirms a masked import", async () => {
    const f = await fixture();
    const service = f.make();
    expect(await service.status()).toMatchObject({
      installState: "installed",
      installedVersion: "0.0.1",
      installedApiLevel: "2.125",
      requiredApiLevel: "2",
    });
    const preview = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    expect(preview.accounts).toEqual([
      {
        id: "account",
        provider: "codex",
        maskedIdentifier: "fic***",
        canRefresh: true,
        revision: "1",
      },
    ]);
    expect(JSON.stringify(preview)).not.toContain(fictionalSecret);
    expect(f.calls).not.toContain("prepareClient");
    await service.confirmImport(preview.previewId);
    expect(await service.status()).toMatchObject({ state: "import-ready", rememberedKey: true });
    for (const file of await readdir(f.directory)) {
      const bytes = await readFile(path.join(f.directory, file));
      expect(bytes.includes(Buffer.from(fictionalSecret))).toBe(false);
      expect(bytes.includes(Buffer.from(f.transfer.migrationKey))).toBe(false);
      expect(bytes.includes(Buffer.from(f.transfer.snapshot.masterKey))).toBe(false);
    }
    f.handoff();
    await service.retry();
    expect(f.activate).toHaveBeenCalledTimes(1);
    expect((await service.status()).state).toBe("shared");
  });
  it("cancelled previews cannot import and do not create protected files", async () => {
    const f = await fixture();
    const service = f.make();
    const preview = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    await service.cancelPreview();
    await expect(service.confirmImport(preview.previewId)).rejects.toThrow(
      "import-preview-expired",
    );
    expect((await service.status()).state).toBe("none");
  });
  it("recovers preparation after failure and application restart without storing migration keys", async () => {
    const f = await fixture();
    const first = f.make();
    const preview = await first.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    f.failPrepare(true);
    await expect(first.confirmImport(preview.previewId)).rejects.toThrow();
    expect(await first.status()).toMatchObject({ state: "preparing", rememberedKey: true });
    await first.dispose();
    f.failPrepare(false);
    const second = f.make();
    await second.restore();
    expect(await second.status()).toMatchObject({ state: "import-ready", rememberedKey: true });
    expect(f.activate).not.toHaveBeenCalled();
  });
  it("joins concurrent reconnect requests without merging installation or refresh operations", async () => {
    const f = await fixture();
    const service = f.make();
    const preview = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    f.failPrepare(true);
    await expect(service.confirmImport(preview.previewId)).rejects.toThrow();
    f.failPrepare(false);
    f.handoff();
    const installation = await f.host.inspect();
    f.host.inspect.mockClear();
    f.host.connect.mockClear();
    f.calls.length = 0;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.host.inspect.mockImplementationOnce(async () => {
      entered();
      await blocked;
      return installation;
    });
    const first = service.retry();
    await started;
    let second: Promise<void>;
    try {
      second = service.retry();
      expect(second).toBe(first);
      expect(() => service.install()).toThrow("operation-in-progress");
      expect(() => service.refresh("account")).toThrow("operation-in-progress");
    } finally {
      release();
    }
    await expect(Promise.all([first, second!])).resolves.toEqual([undefined, undefined]);
    expect(f.host.inspect).toHaveBeenCalledTimes(1);
    expect(f.host.connect).toHaveBeenCalledTimes(1);
    expect(f.calls.filter((method) => method === "prepareClient")).toHaveLength(1);
    expect(f.activate).toHaveBeenCalledTimes(1);
    expect(await service.status()).toMatchObject({ state: "shared", connected: true });
  });
  it("drains the shared reconnect promise before disposing without activating late", async () => {
    const f = await fixture();
    const deactivate = vi.fn(async () => undefined);
    const service = f.make({ deactivate });
    const preview = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    await service.confirmImport(preview.previewId);
    f.handoff();
    const installation = await f.host.inspect();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.host.inspect.mockImplementationOnce(async () => {
      entered();
      await blocked;
      return installation;
    });
    const first = service.retry();
    await started;
    const second = service.retry();
    const rejected = expect(Promise.all([first, second])).rejects.toThrow("client-closed");
    const closing = service.dispose();
    try {
      expect(deactivate).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await rejected;
    await closing;
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(f.activate).not.toHaveBeenCalled();
  });
  it("status inspection never starts the broker and an empty directory cannot be imported", async () => {
    const f = await fixture();
    const service = f.make();
    await service.status();
    expect(f.host.connect).not.toHaveBeenCalled();
    await expect(
      service.verifyImport({ vaultDirectory: f.root, migrationKey: f.transfer.migrationKey }),
    ).rejects.toThrow();
    expect(f.host.connect).not.toHaveBeenCalled();
  });
  it("drains confirmation on exit without filling a late key or binding", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = f.make({
      cipher: {
        ...f.cipher,
        encrypt: async (value) => {
          entered();
          await blocked;
          return f.cipher.encrypt(value);
        },
      },
    });
    const preview = await service.verifyImport({
      vaultDirectory: f.vault,
      migrationKey: f.transfer.migrationKey,
    });
    const confirmation = service.confirmImport(preview.previewId);
    const rejected = expect(confirmation).rejects.toThrow("client-closed");
    await started;
    const closing = service.dispose();
    release();
    await rejected;
    await closing;
    await expect(readdir(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.calls).not.toContain("prepareClient");
  });
});
