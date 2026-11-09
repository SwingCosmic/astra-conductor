import { app } from "electron";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { CoreServices, silentLogger } from "@astra-conductor/core/internal";
import { registerElectronServices } from "../dist/platform/electron/register-electron-services.js";
import { startRuntime } from "../dist/server/runtime/start-runtime.js";

const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const root = path.resolve(option("--root"));
const phase = option("--phase");
const product = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.LOCALAPPDATA = path.join(root, "local");
app.setPath("userData", path.join(root, "electron-profile"));

async function seed(vault) {
  for (const offeringId of ["bigmodel-coding-plan", "fictional-inference"]) {
    const account = {
      id: offeringId,
      provider: offeringId === "bigmodel-coding-plan" ? "glm" : "fictional",
      offeringId,
      authMethod: "api-key",
      stableIdentity: offeringId,
      displayName: "Fictional account",
      maskedIdentifier: "fic***",
      enabled: true,
      credentialState: "available",
      publicMetadata: {},
      createdAt: "2026-11-09T00:00:00Z",
      updatedAt: "2026-11-09T00:00:00Z",
    };
    await vault.saveAccount(account, {
      version: 1,
      accountId: account.id,
      provider: account.provider,
      authMethod: account.authMethod,
      expiresAt: null,
      secrets: { apiKey: "FICTIONAL-SMOKE-NOT-A-REAL-TOKEN" },
    });
  }
}

async function run() {
  let runtime;
  let providerCalls = 0;
  try {
    runtime = await startRuntime((registry) =>
      registerElectronServices(registry, {
        dataDirectory: path.join(root, "product"),
        nativeBinding: path.join(product, "lib", "better-sqlite3", "better_sqlite3.node"),
        session: {
          fetch: () => {
            providerCalls++;
            throw new Error("Unexpected provider request");
          },
        },
        signal: new AbortController().signal,
        logger: silentLogger,
        credentialsAvailable: true,
        openExternal: async () => {
          throw new Error("Unexpected authorization");
        },
        showWindow() {},
      }),
    );
    runtime.application.saveSettings({
      ...runtime.application.getSettings(),
      pollingEnabled: false,
    });
    const service = runtime.credentialSharing;
    const vaultDirectory = path.join(root, "vault");
    if (phase === "export") {
      const initial = await service.getStatus();
      assert.equal(initial.installState, "not-installed");
      await cp(path.resolve(option("--publish")), initial.localPackageDirectory, {
        recursive: true,
      });
      await service.install();
      await mkdir(vaultDirectory);
      await seed(runtime.registry.get(CoreServices.vault));
    }

    const delivery =
      phase === "export"
        ? await service.exportCredentials(vaultDirectory)
        : await service.resumeExport();
    assert.match(delivery.migrationKey, /^acm1_[a-zA-Z0-9_-]{43}$/);
    const state = await service.getStatus();
    assert.equal(state.migrationState, "export-ready");
    assert.equal(state.frozen, false);
    assert.equal(state.activeBackend, "private");
    assert.equal(state.rememberedKey, true);
    assert.equal(state.recordCount, 2);
    assert.equal(state.brokerOwnership, "broker");
    assert(!JSON.stringify(state).includes(delivery.migrationKey));
    assert(!JSON.stringify(state).includes("FICTIONAL-SMOKE-NOT-A-REAL-TOKEN"));

    if (phase === "resume") {
      const first = JSON.parse(await readFile(path.join(root, "export-result.json"), "utf8"));
      assert.equal(first.storageVersion, state.storageVersion);
      await service.enableShared();
      assert.equal((await service.getStatus()).activeBackend, "shared");
      const resumed = await service.resumeExport();
      assert.equal(resumed.storageVersion, delivery.storageVersion);
      assert(resumed.migrationKey === delivery.migrationKey, "wrong delivery");
      await service.acknowledgeDelivery();
      await service.returnToPrivate(true);
      assert.equal((await service.getStatus()).migrationState, "private-ready");
      await service.switchToPrivate();
      const returned = await service.getStatus();
      assert.equal(returned.migrationState, "private");
      assert.equal(returned.activeBackend, "private");
      assert.equal(returned.rememberedKey, false);
      await service.uninstall();
      await service.install();
      assert.equal((await service.getStatus()).installState, "installed");
      await service.uninstall();
    }
    assert.equal(providerCalls, 0);
    await writeFile(
      path.join(root, phase + "-result.json"),
      JSON.stringify({
        phase,
        passed: true,
        storageVersion: state.storageVersion,
        records: state.recordCount,
        realSafeStorage: true,
        realBroker: true,
        brokerOwnership: state.brokerOwnership,
        providerCalls,
      }),
    );
  } catch (error) {
    console.error(
      "credential-sharing smoke failed",
      error.code ?? error.name,
      error instanceof Error && error.name !== "AssertionError" ? error.message : "state assertion",
    );
    process.exitCode = 1;
  } finally {
    await runtime?.stop();
    app.exit(process.exitCode ?? 0);
  }
}
app.whenReady().then(run);
