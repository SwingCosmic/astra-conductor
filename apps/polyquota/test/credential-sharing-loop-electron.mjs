import { app } from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer, createConnection } from "node:net";
import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  CredentialVault,
  CredentialMutationGate,
  SwitchingCredentialService,
  encodeSharedCredential,
} from "@astra-conductor/core/internal";
import { SharedBrokerClient, BrokerError } from "@astra-conductor/credentials";
import { WindowsBrokerHost, runPrivate } from "@astra-conductor/credentials/host/windows";
import { SqliteStorage } from "../dist/platform/common/sqlite-storage.js";
import { ElectronSafeStorageCipher } from "../dist/platform/electron/safe-storage-cipher.js";
import {
  CredentialSharingService,
  sharingStateKey,
  sharingFrozenKey,
  sharingHistoryKey,
} from "../dist/server/credential-sharing/service.js";
import { GraphSharingService } from "../../graph-agent/dist/server/import-service.js";
import { GraphCredentialRuntime } from "../../graph-agent/dist/server/runtime.js";
import { createGraphServices } from "../../graph-agent/dist/server/services.js";
import { createGraphHonoApp } from "../../graph-agent/dist/server/create-hono-app.js";
import { serve } from "@hono/node-server";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const root = path.resolve(option("--root"));
const graph = args.includes("--graph");
const restartExportScenario = args.includes("--restart-export");
const filename = fileURLToPath(import.meta.url);
const product = path.resolve(path.dirname(filename), "..");
app.setName(graph ? "GraphAgent" : "PolyQuota");
app.setPath("userData", path.join(root, graph ? "graph-profile" : "poly-profile"));
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const vaultDirectory = path.join(root, "vault");
    const directory = path.join(root, graph ? "graph-data" : "poly-data", "credential-sharing");
    const host = new WindowsBrokerHost(
      path.join(root, "broker-home"),
      path.join(root, "download"),
      directory,
    );
    const cipher = new ElectronSafeStorageCipher();
    let providerCalls = 0;
    const providerHttp = {
      fetch: async (url, init) => {
        assert(
          String(url).includes("/oauth/token"),
          "only the injected refresh endpoint is allowed",
        );
        const body = Object.fromEntries(new URLSearchParams(String(init.body)));
        assert.match(body.refresh_token, /^FICTIONAL-REFRESH-\d+$/);
        providerCalls++;
        const next = Number(body.refresh_token.split("-").at(-1)) + 1;
        return new Response(
          JSON.stringify({
            access_token: `FICTIONAL-ACCESS-${next}`,
            refresh_token: `FICTIONAL-REFRESH-${next}`,
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    };
    const runtime = new GraphCredentialRuntime(host, providerHttp);
    let graphService;
    let polyService;
    let storage;
    let child;
    let stopChild;
    let webServer;
    let webServices;
    let replacementProduct;
    let replacementPost;
    let replacementStage = "none";
    let webUrl;
    let webBaselineGrants;
    const webLeaseMethods = [];
    let offlineInstallation;
    const results = [];
    function check(name, condition) {
      assert(condition, name);
      results.push(name);
      console.log(`PASS ${name}`);
    }
    const waitFor = async (test) => {
      const deadline = Date.now() + 30_000;
      while (!(await test())) {
        assert(Date.now() < deadline, "condition timeout");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    async function restoreOfflineInstallation() {
      if (!offlineInstallation) return;
      const saved = offlineInstallation;
      offlineInstallation = undefined;
      await rename(saved, path.join(host.home, "installation.json"));
    }
    async function disconnectIsolatedBroker() {
      const installationPath = path.join(host.home, "installation.json");
      const installation = JSON.parse(await readFile(installationPath, "utf8"));
      const executable = path.resolve(installation.directory, "brokerctl.exe");
      assert(
        executable
          .toLowerCase()
          .startsWith((path.join(root, "broker-home", "components") + path.sep).toLowerCase()),
      );
      // Pause automatic restart while terminating only this loop's verified process identities.
      offlineInstallation = path.join(host.home, "installation.loop-offline.json");
      await rename(installationPath, offlineInstallation);
      await writeFile(
        path.join(vaultDirectory, "runtime", "stop.request"),
        JSON.stringify({ stop: true }),
      );
      const script = `
$ErrorActionPreference = 'Stop'
$job = [Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($name in @('supervisor.json', 'endpoint.json')) {
  $endpoint = Get-Content -Raw -LiteralPath (Join-Path $job.runtime $name) | ConvertFrom-Json
  $worker = Get-Process -Id $endpoint.pid -ErrorAction SilentlyContinue
  if ($null -eq $worker) { continue }
  if ($worker.StartTime.ToUniversalTime().Ticks.ToString() -ne $endpoint.processStartTime.ToString()) { throw 'process-identity-mismatch' }
  if (![String]::Equals($worker.Path, $job.executable, [StringComparison]::OrdinalIgnoreCase)) { throw 'process-path-mismatch' }
  Stop-Process -InputObject $worker -Force
  if (!$worker.WaitForExit(10000)) { throw 'process-exit-timeout' }
}
`;
      await runPrivate(
        path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        JSON.stringify({ runtime: path.join(vaultDirectory, "runtime"), executable }),
        30_000,
      );
    }
    const graphFiles = () => readdir(path.dirname(directory));
    const grants = async () =>
      (await readdir(directory)).filter((name) => name.endsWith(".dpapi")).sort();
    async function stopWeb() {
      if (!webServer) return;
      const server = webServer;
      webServer = undefined;
      const closed = new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await webServices.stop();
      server.closeAllConnections?.();
      await closed;
      webServices = undefined;
    }
    async function startWeb() {
      const binding = JSON.parse(await readFile(path.join(directory, "binding.json"), "utf8"));
      const manifest = JSON.parse(
        await readFile(path.join(vaultDirectory, "manifest.json"), "utf8"),
      );
      const grantName = `${manifest.vaultId}.${binding.clientId}.dpapi`;
      assert(
        (await grants()).includes(grantName),
        "formal Web must reuse the GraphAgent protected grant",
      );
      webBaselineGrants ??= await grants();
      // The loop's host layout is isolated. Refuse a connect before the SDK could auto-grant.
      const existingGrantHost = {
        localPackageDirectory: host.localPackageDirectory,
        inspect: () => host.inspect(),
        inspectPackage: () => host.inspectPackage(),
        status: (vault) => host.status(vault),
        install: () => host.install(),
        uninstall: () => host.uninstall(),
        connect: async (vault, clientId, instanceId) => {
          assert.equal(path.resolve(vault), vaultDirectory);
          assert.equal(clientId, binding.clientId);
          assert((await grants()).includes(grantName), "Web cannot mint a new broker grant");
          const connection = await host.connect(vault, clientId, instanceId);
          return {
            close: () => connection.close(),
            call: (method, params) => {
              if (["beginUpdate", "markUpdateStarted", "commitUpdate"].includes(method))
                webLeaseMethods.push(method);
              return connection.call(method, params);
            },
          };
        },
      };
      webServices = await createGraphServices({
        directory: path.dirname(directory),
        host: existingGrantHost,
        http: providerHttp,
        files: {
          readText: async () => {
            throw new Error("Web must not read private CLI credentials");
          },
        },
        callbackServer: {
          start: async () => {
            throw new Error("Web shared host must not start private auth");
          },
        },
        authorization: { present: async () => "awaiting-user" },
        brokerBinding: { vaultDirectory, clientId: binding.clientId },
      });
      const hono = createGraphHonoApp(webServices);
      webServer = await new Promise((resolve, reject) => {
        const server = serve(
          { overrideGlobalObjects: false, hostname: "127.0.0.1", port: 0, fetch: hono.fetch },
          () => resolve(server),
        );
        server.once("error", reject);
      });
      webUrl = `http://127.0.0.1:${webServer.address().port}`;
      return webSnapshot();
    }
    async function webSnapshot() {
      const response = await fetch(`${webUrl}/api/v1/providers`);
      const result = await response.json();
      assert.equal(response.status, 200);
      assert.equal(result.ok, true);
      assert(!JSON.stringify(result).includes("FICTIONAL-ACCESS"));
      assert(!JSON.stringify(result).includes("FICTIONAL-REFRESH"));
      return result.value;
    }
    async function webRefresh() {
      const snapshot = await webSnapshot();
      const before = providerCalls;
      const beforeLeases = webLeaseMethods.length;
      const response = await fetch(
        `${webUrl}/api/v1/accounts/fictional-codex/refresh-credentials`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instanceId: snapshot.instanceId,
            contextId: snapshot.backend.contextId,
          }),
        },
      );
      const result = await response.json();
      return {
        status: response.status,
        result,
        calls: providerCalls - before,
        leaseMethods: webLeaseMethods.slice(beforeLeases),
      };
    }
    try {
      assert(await cipher.isAvailable());
      if (graph) {
        graphService = new GraphSharingService({
          host,
          cipher,
          directory,
          selectDirectory: async () => vaultDirectory,
          canRefresh: (provider) => runtime.canRefresh(provider),
          activate: (binding, changed) => runtime.activate(binding, changed),
          accounts: () => runtime.accounts(),
          refresh: (id) => runtime.refresh(id),
          deactivate: () => runtime.deactivate(),
        });
        await graphService.restore();
        const transport = createConnection(option("--pipe"));
        const send = (value) => transport.write(JSON.stringify(value) + "\n");
        send({ id: "ready", ok: true });
        for await (const line of createInterface({ input: transport })) {
          const request = JSON.parse(line);
          try {
            let value;
            if (request.method === "import") {
              await assert.rejects(
                graphService.verifyImport({
                  vaultDirectory,
                  migrationKey: "acm1_" + Buffer.alloc(32, 4).toString("base64url"),
                }),
              );
              assert.equal((await graphService.status()).state, "none");
              const preview = await graphService.verifyImport({
                vaultDirectory,
                migrationKey: request.key,
              });
              assert(!JSON.stringify(preview).includes("FICTIONAL-ACCESS"));
              await graphService.confirmImport(preview.previewId);
              value = await graphService.status();
            } else if (request.method === "retry") {
              await graphService.retry();
              value = await graphService.status();
            } else if (request.method === "refresh") {
              await graphService.refresh("fictional-codex");
              value = { providerCalls };
            } else if (request.method === "status") value = await graphService.status();
            else if (request.method === "pending-private-check") {
              const profile = path.join(root, "graph-pending-private-check");
              await cp(directory, path.join(profile, "credential-sharing"), { recursive: true });
              const product = await createGraphServices({
                directory: profile,
                host,
                cipher,
                http: providerHttp,
                files: {
                  readText: async () => {
                    throw new Error("unexpected CLI access");
                  },
                },
                callbackServer: {
                  start: async () => {
                    throw new Error("unexpected callback");
                  },
                },
                authorization: { present: async () => "awaiting-user" },
              });
              try {
                const hono = createGraphHonoApp(product);
                const providers = await (await hono.request("/api/v1/providers")).json();
                const credentials = await (
                  await hono.request("/api/v1/credential-sharing/status")
                ).json();
                value = { providers: providers.value, credentials: credentials.value };
              } finally {
                await product.stop();
              }
            } else if (request.method === "reimport-replacement") {
              replacementStage = "dispose-legacy";
              await graphService.dispose();
              await runtime.dispose();
              replacementStage = "create-product-services";
              replacementProduct = await createGraphServices({
                directory: path.dirname(directory),
                host,
                cipher,
                http: providerHttp,
                files: {
                  readText: async () => {
                    throw new Error("unexpected CLI access");
                  },
                },
                callbackServer: {
                  start: async () => {
                    throw new Error("unexpected callback");
                  },
                },
                authorization: { present: async () => "awaiting-user" },
              });
              replacementStage = "read-initial-product-status";
              const before = await replacementProduct.credentials.getStatus();
              replacementStage = `assert-import-state-${before.importState}`;
              assert.equal(before.importState, "import-ready");
              replacementStage = `assert-backend-${before.selectedBackend}`;
              assert.equal(before.selectedBackend, "private");
              const hono = createGraphHonoApp(replacementProduct);
              replacementPost = async (action, body = {}) => {
                const deadline = Date.now() + 45_000;
                for (;;) {
                  replacementStage = `before-${action}`;
                  const snapshotResponse = await hono.request("/api/v1/providers");
                  const snapshotResult = await snapshotResponse.json();
                  assert.equal(snapshotResponse.status, 200);
                  assert.equal(snapshotResult.ok, true);
                  const snapshot = snapshotResult.value;
                  replacementStage = `invoke-${action}`;
                  const response = await hono.request(`/api/v1/credential-sharing/${action}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      instanceId: snapshot.instanceId,
                      contextId: snapshot.backend.contextId,
                      ...body,
                    }),
                  });
                  const result = await response.json();
                  replacementStage = `${action}-${response.status}-${result.error?.code ?? "ok"}`;
                  if (
                    response.status === 409 &&
                    result.error?.code === "operation-in-progress" &&
                    Date.now() < deadline
                  ) {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                    continue;
                  }
                  assert.equal(response.status, 200, `replacement import ${action} rejected`);
                  assert.equal(result.ok, true);
                  return result.value;
                }
              };
              const preview = await replacementPost("import/verify", {
                vaultDirectory: request.directory,
                migrationKey: request.key,
              });
              assert(!JSON.stringify(preview).includes("FICTIONAL-ACCESS"));
              await replacementPost("import/confirm", { previewId: preview.previewId });
              value = {
                credentials: await replacementProduct.credentials.getStatus(),
                providers: await replacementProduct.providers.getSnapshot(),
              };
            } else if (request.method === "replacement-retry") {
              await replacementPost("retry");
              value = {
                credentials: await replacementProduct.credentials.getStatus(),
                providers: await replacementProduct.providers.getSnapshot(),
              };
            } else if (request.method === "web-start") {
              await graphService.dispose();
              await runtime.dispose();
              value = await startWeb();
            } else if (request.method === "web-snapshot") value = await webSnapshot();
            else if (request.method === "web-refresh") value = await webRefresh();
            else if (request.method === "web-restart") {
              await stopWeb();
              value = await startWeb();
            } else if (request.method === "web-audit") {
              assert.deepEqual(await grants(), webBaselineGrants, "Web must not create grants");
              const files = await graphFiles();
              assert(
                !files.includes("private-business.json"),
                "Web must not create a private credential repository",
              );
              for (const name of files.filter(
                (name) => name.startsWith("shared-business") && name.endsWith(".json"),
              )) {
                const content = await readFile(path.join(path.dirname(directory), name), "utf8");
                assert(
                  !content.includes("FICTIONAL-ACCESS") && !content.includes("FICTIONAL-REFRESH"),
                  "Web business repository must contain no provider secrets",
                );
              }
              value = { noNewGrants: true, noPrivateVault: true, noProviderSecrets: true };
            } else if (request.method === "stop") {
              await stopWeb();
              await replacementProduct?.stop();
              await graphService.dispose();
              await runtime.dispose();
              send({ id: request.id, ok: true });
              transport.end();
              app.exit(0);
              break;
            } else throw new Error("unknown-command");
            send({ id: request.id, ok: true, value });
          } catch (error) {
            send({
              id: request.id,
              ok: false,
              error:
                request.method.startsWith("reimport-replacement") ||
                request.method.startsWith("replacement-")
                  ? `graph-replacement-${replacementStage}-${error.code ?? error.name ?? "failed"}`
                  : error instanceof BrokerError
                    ? error.code
                    : "graph-smoke-failed",
            });
          }
        }
      } else {
        await mkdir(root, { recursive: true });
        await cp(path.resolve(option("--publish")), host.localPackageDirectory, {
          recursive: true,
        });
        await host.install();
        storage = new SqliteStorage(path.join(root, "poly-data", "polyquota.db"), {
          nativeBinding: path.join(product, "lib", "better-sqlite3", "better_sqlite3.node"),
        });
        const account = {
          id: "fictional-codex",
          provider: "codex",
          offeringId: "codex",
          authMethod: "browser-oauth",
          stableIdentity: "fictional-user",
          displayName: "Fictional test",
          maskedIdentifier: "fic***",
          enabled: true,
          credentialState: "available",
          publicMetadata: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const gate = new CredentialMutationGate();
        const privateVault = new CredentialVault(storage, cipher, undefined, gate);
        const switcher = new SwitchingCredentialService(privateVault);
        await privateVault.saveAccount(account, {
          version: 1,
          accountId: account.id,
          provider: "codex",
          authMethod: "browser-oauth",
          expiresAt: null,
          secrets: { accessToken: "FICTIONAL-ACCESS-1", refreshToken: "FICTIONAL-REFRESH-1" },
        });
        await privateVault.saveAccount(
          {
            ...account,
            id: "inference-only",
            provider: "opaque-example",
            offeringId: "opaque-example",
            authMethod: "api-key",
          },
          {
            version: 1,
            accountId: "inference-only",
            provider: "opaque-example",
            authMethod: "api-key",
            expiresAt: null,
            secrets: { apiKey: "FICTIONAL-INFERENCE-KEY" },
          },
        );
        const makeService = (mutations = gate, credentials = switcher) =>
          new CredentialSharingService({
            storage,
            credentials,
            switcher: credentials,
            cipher,
            mutations,
            providers: runtime.providers,
            host,
            cacheDirectory: directory,
            hasActiveAuth: () => false,
          });
        polyService = makeService();
        const delivery = await polyService.exportCredentials(vaultDirectory);
        await polyService.acknowledgeDelivery();
        check(
          "export remains private and frozen",
          (await polyService.getStatus()).frozen && !switcher.isShared,
        );
        async function startGraph() {
          const pending = new Map();
          const pipe = String.raw`\\.\pipe\astra-sharing-smoke-${randomUUID()}`;
          let connected;
          const transportReady = new Promise((resolve) => {
            connected = resolve;
          });
          const server = createServer((socket) => connected(socket));
          await new Promise((resolve) => server.listen(pipe, resolve));
          child = spawn(process.execPath, [filename, "--graph", "--root", root, "--pipe", pipe], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
            windowsHide: true,
            stdio: ["ignore", "ignore", "inherit"],
          });
          const transport = await transportReady;
          const lines = createInterface({ input: transport });
          let readyResolve;
          const ready = new Promise((resolve) => {
            readyResolve = resolve;
          });
          const timers = new Set();
          lines.on("line", (line) => {
            const reply = JSON.parse(line);
            if (reply.id === "ready") {
              readyResolve();
              return;
            }
            const item = pending.get(reply.id);
            if (!item) return;
            pending.delete(reply.id);
            clearTimeout(item.timer);
            timers.delete(item.timer);
            reply.ok ? item.resolve(reply.value) : item.reject(new Error(reply.error));
          });
          const request = (method, extra = {}) =>
            new Promise((resolve, reject) => {
              const id = randomUUID();
              const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`graph-${method}-timeout`));
              }, 90_000);
              timers.add(timer);
              pending.set(id, { resolve, reject, timer });
              transport.write(JSON.stringify({ id, method, ...extra }) + "\n");
            });
          child.on("exit", () => {
            transport.destroy();
            server.close();
            for (const timer of timers) clearTimeout(timer);
            for (const item of pending.values()) item.reject(new Error("graph-exited"));
          });
          await Promise.race([
            ready,
            new Promise((_, reject) => {
              const timer = setTimeout(() => reject(new Error("graph-boot-timeout")), 30_000);
              timer.unref();
              ready.then(() => clearTimeout(timer));
            }),
          ]);
          stopChild = () => request("stop");
          return request;
        }
        let graphRequest = await startGraph();
        const imported = await graphRequest("import", { key: delivery.migrationKey });
        check(
          "wrong key imports zero; correct key reaches import-ready",
          imported.state === "import-ready" && imported.rememberedKey,
        );
        await polyService.cancel();
        const cancelled = await polyService.getStatus();
        check(
          "cancelling an exported source preserves usable private credentials",
          cancelled.exportState === "cancelled" &&
            cancelled.activeBackend === "private" &&
            !cancelled.frozen &&
            (await switcher.load(account.id)).secrets.accessToken === "FICTIONAL-ACCESS-1",
        );
        const pendingPrivate = await graphRequest("pending-private-check");
        check(
          "a restored import-ready GraphAgent keeps private account management available",
          pendingPrivate.providers.backend.active === "private" &&
            pendingPrivate.providers.actions.startAuth.state === "enabled" &&
            pendingPrivate.credentials.importState === "import-ready" &&
            pendingPrivate.credentials.selectedBackend === "private" &&
            pendingPrivate.credentials.accounts.length > 0,
        );
        if (restartExportScenario) {
          const oldState = JSON.parse(storage.settings.get(sharingStateKey));
          const oldMigration = await readFile(
            path.join(
              vaultDirectory,
              "versions",
              oldState.version.storageVersion,
              "migration.json",
            ),
          );
          const oldKeyCache = await readFile(path.join(directory, oldState.keyRef));
          storage.accounts.save({
            ...storage.accounts.get(account.id),
            displayName: "Updated fictional account",
          });
          await assert.rejects(polyService.resumeExport());
          const changedStatus = await polyService.getStatus();
          check(
            "changed private watermark rejects original-export recovery without freezing private credentials",
            changedStatus.exportState === "cancelled" &&
              !changedStatus.frozen &&
              !gate.isFrozen &&
              changedStatus.activeBackend === "private" &&
              (await privateVault.load(account.id)).secrets.accessToken === "FICTIONAL-ACCESS-1",
          );
          const newDirectory = path.join(root, "replacement-vault");
          const replacement = await polyService.restartExport(newDirectory);
          const newStatus = await polyService.getStatus();
          check(
            "restart exports current private metadata to a fresh vault and new successful version",
            newStatus.vaultDirectory === newDirectory &&
              newStatus.exportState === "exported" &&
              newStatus.frozen &&
              !newStatus.deliveryAcknowledged &&
              replacement.storageVersion !== delivery.storageVersion,
          );
          const history = JSON.parse(storage.settings.get(sharingHistoryKey));
          check(
            "restart preserves the old published migration, protected key and archived export identity",
            (
              await readFile(
                path.join(
                  vaultDirectory,
                  "versions",
                  oldState.version.storageVersion,
                  "migration.json",
                ),
              )
            ).equals(oldMigration) &&
              (await readFile(path.join(directory, oldState.keyRef))).equals(oldKeyCache) &&
              history.some(
                (entry) =>
                  entry.state.operationId === oldState.operationId &&
                  entry.state.state === "cancelled",
              ),
          );
          const reimported = await graphRequest("reimport-replacement", {
            directory: newDirectory,
            key: replacement.migrationKey,
          });
          check(
            "a pending GraphAgent import can be replaced through product Hono while private account management remains available",
            reimported.credentials.vaultDirectory === newDirectory &&
              reimported.credentials.importState === "import-ready" &&
              reimported.credentials.selectedBackend === "private" &&
              reimported.providers.backend.active === "private" &&
              reimported.providers.actions.startAuth.state === "enabled",
          );
          await polyService.acknowledgeDelivery();
          await polyService.enableShared();
          const activated = await graphRequest("replacement-retry");
          check(
            "fresh-vault handoff activates both products and GraphAgent reads the updated private snapshot",
            (await polyService.getStatus()).activeBackend === "shared" &&
              activated.credentials.activeBackend === "shared" &&
              activated.providers.backend.active === "shared" &&
              activated.providers.accounts.some(
                (item) =>
                  item.id === account.id && item.displayName === "Updated fictional account",
              ),
          );
          const publicState = JSON.stringify({
            source: await polyService.getStatus(),
            receiver: activated,
          });
          check(
            "replacement export and import keep provider secrets and both migration keys out of public state",
            !publicState.includes("FICTIONAL-ACCESS") &&
              !publicState.includes("FICTIONAL-REFRESH") &&
              !publicState.includes(delivery.migrationKey) &&
              !publicState.includes(replacement.migrationKey),
          );
          await writeFile(
            path.join(root, "result.json"),
            JSON.stringify(
              {
                passed: true,
                scenario: "restart-export",
                checks: results,
                realBroker: true,
                realSafeStorage: true,
                isolatedProcesses: 2,
                providerNetworkCalls: 0,
              },
              null,
              2,
            ),
          );
          console.log(
            `credential-sharing restart-export passed; results: ${path.join(root, "result.json")}`,
          );
          return;
        }
        const resumed = await polyService.resumeExport();
        const resumedStatus = await polyService.getStatus();
        check(
          "resuming a cancelled unchanged export reuses its acknowledged key and original version",
          resumed === null &&
            resumedStatus.exportState === "exported" &&
            resumedStatus.frozen &&
            resumedStatus.storageVersion === delivery.storageVersion,
        );
        await polyService.enableShared();
        check(
          "PolyQuota handoff activates shared backend and filters inference-only",
          (await polyService.getStatus()).activeBackend === "shared" &&
            polyService.visibleAccountIds().size === 1,
        );
        check(
          "GraphAgent observes unified ownership",
          (await graphRequest("retry")).state === "shared",
        );
        await graphRequest("refresh");
        check(
          "GraphAgent provider refresh C1 to C2 visible in PolyQuota",
          (await switcher.load(account.id)).secrets.accessToken === "FICTIONAL-ACCESS-2",
        );
        const provider = runtime.providers.getAccount("codex");
        await switcher.refresh(account, (envelope, current) =>
          provider.refreshCredentials(current, envelope, { force: true }),
        );
        await waitFor(
          async () =>
            (await graphRequest("status")).accounts.find((item) => item.id === account.id)
              ?.revision === "3",
        );
        check("PolyQuota C2 to C3 reaches GraphAgent through events", true);
        check(
          "shared refresh does not overwrite private ciphertext",
          (await new CredentialVault(storage, cipher).load(account.id)).secrets.accessToken ===
            "FICTIONAL-ACCESS-1",
        );
        const originalState = JSON.parse(storage.settings.get(sharingStateKey));
        const observer = new SharedBrokerClient(() =>
          host.connect(vaultDirectory, "third-party-test", "third-party-instance"),
        );
        const current = await observer.getCredential(account.id);
        let concurrentCalls = 0;
        const update = () =>
          observer.update(account.id, current.description.revision, async (record) => {
            concurrentCalls++;
            await new Promise((resolve) => setTimeout(resolve, 500));
            const data = JSON.parse(Buffer.from(record.payload, "base64url"));
            data.credentials.secrets.accessToken = "FICTIONAL-ACCESS-4";
            data.credentials.secrets.refreshToken = "FICTIONAL-REFRESH-4";
            return {
              value: true,
              commit: { payload: encodeSharedCredential(data.account, data.credentials) },
            };
          });
        const parallel = await Promise.allSettled([update(), update()]);
        check(
          "same revision concurrent update invokes provider once",
          concurrentCalls === 1 &&
            parallel.filter((item) => item.status === "fulfilled").length === 1,
        );
        observer.close();
        await polyService.returnToPrivate(true);
        const privateStatus = await polyService.getStatus();
        check(
          "return snapshots current C4 and forgets only PolyQuota key",
          privateStatus.activeBackend === "private" &&
            !privateStatus.rememberedKey &&
            (await switcher.load(account.id)).secrets.accessToken === "FICTIONAL-ACCESS-4",
        );
        await graphRequest("refresh");
        check(
          "GraphAgent continues refreshing after PolyQuota leaves",
          (await graphRequest("status")).state === "shared",
        );
        await switcher.refresh(account, async (envelope) => ({
          changed: true,
          envelope: {
            ...envelope,
            secrets: { ...envelope.secrets, accessToken: "FICTIONAL-PRIVATE-ONLY" },
          },
        }));
        check(
          "private copy refreshes independently",
          (await switcher.load(account.id)).secrets.accessToken === "FICTIONAL-PRIVATE-ONLY",
        );
        await assert.rejects(
          polyService.rejoinShared("acm1_" + Buffer.alloc(32, 1).toString("base64url")),
        );
        check(
          "wrong reentry key preserves private backend",
          (await polyService.getStatus()).activeBackend === "private",
        );
        await polyService.rejoinShared(delivery.migrationKey);
        check(
          "reentry uses shared C5 without uploading private changes",
          (await switcher.load(account.id)).secrets.accessToken === "FICTIONAL-ACCESS-5",
        );
        await stopChild();
        graphRequest = await startGraph();
        check(
          "GraphAgent restart restores protected binding",
          (await graphRequest("status")).state === "shared",
        );
        await polyService.stop();
        const restartedGate = new CredentialMutationGate(
          storage.settings.get(sharingFrozenKey) === true,
        );
        const restartedSwitcher = new SwitchingCredentialService(
          new CredentialVault(storage, cipher, undefined, restartedGate),
        );
        polyService = makeService(restartedGate, restartedSwitcher);
        await polyService.start();
        check(
          "PolyQuota restart restores shared selection",
          (await polyService.getStatus()).activeBackend === "shared" &&
            (await restartedSwitcher.load(account.id)).secrets.accessToken === "FICTIONAL-ACCESS-5",
        );
        check(
          "handoff reused the original successful version",
          JSON.parse(storage.settings.get(sharingStateKey)).version.storageVersion ===
            originalState.version.storageVersion,
        );
        const webInitial = await graphRequest("web-start");
        check(
          "formal GraphAgent Web reads shared accounts through the product Hono API",
          webInitial.backend.active === "shared" &&
            webInitial.accounts.some((item) => item.id === account.id) &&
            webInitial.actions.startAuth.state === "disabled",
        );
        const webRefreshed = await graphRequest("web-refresh");
        check(
          "formal Web HTTP refresh uses the real broker record lease and reaches PolyQuota",
          webRefreshed.status === 200 &&
            webRefreshed.result.ok &&
            webRefreshed.result.value.status === "updated" &&
            webRefreshed.calls === 1 &&
            ["beginUpdate", "markUpdateStarted", "commitUpdate"].every((method) =>
              webRefreshed.leaseMethods.includes(method),
            ) &&
            (await restartedSwitcher.load(account.id)).secrets.accessToken === "FICTIONAL-ACCESS-6",
        );
        const webRestarted = await graphRequest("web-restart");
        check(
          "formal Web restart reuses the protected broker binding without a private cipher",
          webRestarted.backend.active === "shared" &&
            webRestarted.accounts.some((item) => item.id === account.id),
        );
        check(
          "formal Web creates no broker grant, private vault or persisted provider secret",
          (await graphRequest("web-audit")).noNewGrants,
        );
        await disconnectIsolatedBroker();
        await waitFor(
          async () => (await graphRequest("web-snapshot")).backend.active === "unavailable",
        );
        const webOffline = await graphRequest("web-refresh");
        check(
          "real broker disconnect disables formal Web HTTP refresh before the provider is called",
          webOffline.status >= 400 && webOffline.calls === 0 && !webOffline.result.ok,
        );
        await restoreOfflineInstallation();
        await waitFor(async () => (await graphRequest("web-snapshot")).backend.active === "shared");
        check(
          "formal Web recovers the existing shared backend after broker reconnect",
          (await graphRequest("web-audit")).noPrivateVault,
        );
        const publicData = JSON.stringify({
          poly: await polyService.getStatus(),
          graph: await graphRequest("status"),
        });
        check(
          "public state excludes tokens and migration key",
          !publicData.includes("FICTIONAL-ACCESS") && !publicData.includes(delivery.migrationKey),
        );
        await writeFile(
          path.join(root, "result.json"),
          JSON.stringify(
            {
              passed: true,
              checks: results,
              realBroker: true,
              realSafeStorage: true,
              isolatedProcesses: 2,
              providerNetworkCalls: 0,
            },
            null,
            2,
          ),
        );
        console.log(`credential-sharing-loop passed; results: ${path.join(root, "result.json")}`);
      }
    } catch (error) {
      console.error(
        "credential-sharing-loop failed",
        error instanceof BrokerError
          ? error.code
          : error instanceof Error
            ? error.message
            : "unknown-error",
      );
      process.exitCode = 1;
    } finally {
      if (!graph) {
        try {
          await stopChild?.();
        } catch {
          child?.kill();
        }
        await polyService?.stop();
        storage?.close();
        await runtime.dispose();
        try {
          await restoreOfflineInstallation();
          await host.uninstall();
        } catch {
          /* Preserve isolated diagnostic data. */
        }
        app.exit(process.exitCode ?? 0);
      }
    }
  })
  .catch(() => app.exit(1));
