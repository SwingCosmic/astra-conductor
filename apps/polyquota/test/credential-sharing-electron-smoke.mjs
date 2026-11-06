import { app, BrowserWindow, protocol, session } from "electron";
import { mkdtemp, mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { CredentialVault, CredentialMutationGate } from "@astra-conductor/core/internal";
import { BROKER_DISTRIBUTION } from "@astra-conductor/credentials";
import { SqliteStorage } from "../dist/sqlite-storage.js";
import { ElectronSafeStorageCipher } from "../dist/safe-storage-cipher.js";
import { WindowsBrokerHost, runPrivate } from "../dist/credential-sharing/broker-host.js";
import { CredentialSharingService, sharingFrozenKey } from "../dist/credential-sharing/service.js";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const root = path.resolve(option("--root"));
const phase = option("--phase");
const product = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
app.setName("PolyQuota");
app.on("window-all-closed", () => {});
app.setPath("userData", path.join(root, "electron-profile"));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "polyquota-app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
app
  .whenReady()
  .then(async () => {
    let storage;
    let host;
    try {
      const home = path.join(root, "service-home");
      const localPackageDirectory = path.join(
        root,
        "downloads",
        "win-x64",
        BROKER_DISTRIBUTION.version,
      );
      const vaultDirectory = path.join(root, "shared-vault");
      const cacheDirectory = path.join(root, "product", "credential-sharing");
      host = new WindowsBrokerHost(home, localPackageDirectory, cacheDirectory);
      const connect = host.connect.bind(host);
      host.connect = async (...args) => {
        const client = await connect(...args);
        console.log("broker-authenticated");
        return client;
      };
      if (phase === "export") {
        await mkdir(path.dirname(localPackageDirectory), { recursive: true });
        await cp(path.resolve(option("--publish")), localPackageDirectory, { recursive: true });
        assert.equal((await host.inspect()).installState, "not-installed");
        await host.install();
        assert.equal((await host.inspect()).installState, "installed");
      }
      const cipher = new ElectronSafeStorageCipher();
      assert.equal(await cipher.isAvailable(), true);
      storage = new SqliteStorage(path.join(root, "product", "polyquota.db"), {
        nativeBinding: path.join(product, "lib", "better-sqlite3", "better_sqlite3.node"),
      });
      const mutations = new CredentialMutationGate(storage.settings.get(sharingFrozenKey) === true);
      const credentials = new CredentialVault(storage, cipher, undefined, mutations);
      if (phase === "export") {
        for (const [index, provider] of ["codex", "example-inference-only"].entries()) {
          const account = {
            id: `fictional-${index}`,
            provider,
            offeringId: provider,
            authMethod: "api-key",
            stableIdentity: `fictional-${index}`,
            displayName: "Fictional smoke account",
            maskedIdentifier: "fic***",
            enabled: true,
            credentialState: "available",
            publicMetadata: {},
            createdAt: "2026-11-05T00:00:00Z",
            updatedAt: "2026-11-05T00:00:00Z",
          };
          await credentials.saveAccount(account, {
            version: 1,
            accountId: account.id,
            provider,
            authMethod: "api-key",
            expiresAt: null,
            secrets: { apiKey: "FICTIONAL-SMOKE-NOT-A-REAL-TOKEN" },
          });
        }
      } else assert.equal(mutations.isFrozen, true);
      const service = new CredentialSharingService({
        storage,
        credentials,
        cipher,
        mutations,
        providers: { getUsage: (provider) => (provider === "codex" ? {} : null) },
        host,
        cacheDirectory,
        hasActiveAuth: () => false,
      });
      const delivered = await service.exportCredentials(vaultDirectory);
      assert.match(delivered.migrationKey, /^acm1_[a-zA-Z0-9_-]{43}$/);
      const state = await service.getStatus();
      assert.equal(state.exportState, "exported");
      assert.equal(state.frozen, true);
      assert.equal(state.rememberedKey, true);
      assert.equal(state.activeBackend, "private");
      assert.equal(state.brokerOwnership, "source");
      assert.equal(state.recordCount, 2);
      assert(!JSON.stringify(state).includes(delivered.migrationKey));
      assert(!JSON.stringify(state).includes("FICTIONAL-SMOKE-NOT-A-REAL-TOKEN"));
      if (phase === "resume") {
        const previous = JSON.parse(await readFile(path.join(root, "export-result.json"), "utf8"));
        assert.equal(previous.storageVersion, state.storageVersion);
        await service.acknowledgeDelivery();
        assert.equal((await service.getStatus()).deliveryAcknowledged, true);
        const { startRuntime } = await import("../dist/runtime/start-runtime.js");
        const { registerElectronServices } = await import(
          "../dist/platform/electron/register-electron-services.js"
        );
        const { createHonoApp } = await import("../dist/http/create-hono-app.js");
        const { ElectronProtocolAdapter } = await import(
          "../dist/platform/electron/protocol-adapter.js"
        );
        const { ElectronDynamicResourceService } = await import(
          "../dist/platform/electron/dynamic-resources.js"
        );
        storage.settings.save("pollingEnabled", false, new Date().toISOString());
        const runtime = await startRuntime((registry) =>
          registerElectronServices(registry, {
            dataDirectory: path.join(root, "product"),
            nativeBinding: path.join(product, "lib", "better-sqlite3", "better_sqlite3.node"),
            session: session.defaultSession,
            signal: new AbortController().signal,
            logger: { info() {}, error() {} },
            credentialsAvailable: true,
            openExternal: async () => {
              throw new Error("unexpected browser launch");
            },
            showWindow() {},
          }),
        );
        runtime.credentialSharing = service;
        const adapter = new ElectronProtocolAdapter(
          createHonoApp(runtime),
          new ElectronDynamicResourceService(
            path.join(product, "assets", "icons"),
            new Map([["product-icon", "polyquota.png"]]),
          ),
          new Set(["null"]),
        );
        await protocol.handle("polyquota-app", (request) => adapter.handle(request));
        const window = new BrowserWindow({
          show: false,
          width: 1280,
          height: 1350,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
        });
        try {
          await window.loadFile(path.join(product, "renderer", "index.html"));
          await window.webContents.executeJavaScript(`(async () => {
        const waitFor = async predicate => { const deadline = Date.now()+15000; while (!predicate()) { if(Date.now()>deadline) throw new Error('settings-render-timeout'); await new Promise(resolve=>setTimeout(resolve,30)); } };
        await waitFor(()=>document.querySelector('.sidebar nav button'));
        [...document.querySelectorAll('.sidebar nav button')].find(button=>button.textContent.includes('设置')).click();
        await waitFor(()=>[...document.querySelectorAll('button')].some(button=>button.textContent.includes('管理凭据存储')));
        if(document.querySelector('.credential-sharing-settings')) throw new Error('sharing-flow-in-settings');
        [...document.querySelectorAll('button')].find(button=>button.textContent.includes('管理凭据存储')).click();
        await waitFor(()=>document.querySelector('.credential-sharing-settings')?.textContent.includes('导出成功，等待建立共享') && !document.querySelector('.credential-storage-manager')?.textContent.includes('正在处理'));
        document.querySelector('.credential-storage-manager').scrollIntoView({ block: 'start' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if(document.querySelector('[aria-label="迁移密钥"]')) throw new Error('key-visible-after-ack');
      })()`);
          await writeFile(
            path.join(root, "credential-sharing-settings.png"),
            (await window.webContents.capturePage()).toPNG(),
          );
          await window.webContents.executeJavaScript(
            `document.querySelector('.credential-sharing-settings').scrollIntoView({ block: 'start' })`,
          );
          await writeFile(
            path.join(root, "credential-storage-export.png"),
            (await window.webContents.capturePage()).toPNG(),
          );
          await window.webContents.executeJavaScript(`(async () => {
            window.confirm = () => true;
            [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '取消共享切换').click();
            const deadline = Date.now() + 30000;
            while (!document.querySelector('.credential-sharing-settings')?.textContent.includes('已恢复使用内置存储独立更新凭据') || document.querySelector('.credential-storage-manager')?.textContent.includes('正在处理')) {
              if (Date.now() > deadline) throw new Error('cancel-render-timeout');
              await new Promise(resolve => setTimeout(resolve, 30));
            }
            const text = document.querySelector('.credential-sharing-settings').textContent;
            if (text.includes('等待') || text.includes('接收方') || text.includes('共享凭据更新权')) throw new Error('cancelled-sharing-hint-remains');
            document.querySelector('.credential-sharing-settings').scrollIntoView({ block: 'start' });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          })()`);
          await writeFile(
            path.join(root, "credential-storage-cancelled.png"),
            (await window.webContents.capturePage()).toPNG(),
          );
        } finally {
          window.destroy();
          adapter.abortRequests();
          protocol.unhandle("polyquota-app");
          await runtime.stop();
        }

        await host.uninstall();
        assert.equal((await host.inspect()).installState, "not-installed");
        await host.install();
        assert.equal((await service.getStatus()).rememberedKey, true);
        await assert.rejects(service.exportCredentials(vaultDirectory), /export-cancelled/);
        assert.equal((await service.getStatus()).exportState, "cancelled");
        assert.equal((await service.getStatus()).frozen, false);
        await host.uninstall();
      } else {
        const installation = await host.inspect();
        await runPrivate(path.join(installation.installationDirectory, "brokerctl.exe"), [
          "stop",
          "--home",
          home,
          "--vault",
          vaultDirectory,
        ]);
      }
      await writeFile(
        path.join(root, `${phase}-result.json`),
        JSON.stringify(
          {
            phase,
            passed: true,
            storageVersion: state.storageVersion,
            records: state.recordCount,
            realSafeStorage: true,
            realBroker: true,
            brokerOwnership: state.brokerOwnership,
            providerNetworkCalls: 0,
          },
          null,
          2,
        ),
      );
      console.log(
        `credential-sharing-${phase}: passed (real Electron safeStorage / broker, fictional credentials)`,
      );
    } catch (error) {
      // Assertion messages contain field names and status codes only; never print delivery or payloads.
      console.error(
        "credential-sharing-smoke failed",
        error instanceof Error ? error.message : "unknown-error",
      );
      try {
        await host?.uninstall();
      } catch {
        /* retain the isolated root for diagnosis */
      }
      app.exit(1);
      return;
    } finally {
      storage?.close();
    }
    app.exit(0);
  })
  .catch(() => app.exit(1));
