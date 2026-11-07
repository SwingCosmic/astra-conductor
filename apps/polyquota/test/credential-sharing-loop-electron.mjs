import { app } from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer, createConnection } from "node:net";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
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
import { WindowsBrokerHost } from "@astra-conductor/credentials/host/windows";
import { SqliteStorage } from "../dist/sqlite-storage.js";
import { ElectronSafeStorageCipher } from "../dist/safe-storage-cipher.js";
import {
  CredentialSharingService,
  sharingStateKey,
  sharingFrozenKey,
} from "../dist/credential-sharing/service.js";
import { GraphSharingService } from "../../graph-agent/dist/import-service.js";
import { GraphCredentialRuntime } from "../../graph-agent/dist/runtime.js";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const root = path.resolve(option("--root"));
const graph = args.includes("--graph");
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
    const runtime = new GraphCredentialRuntime(host, {
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
    });
    let graphService;
    let polyService;
    let storage;
    let child;
    let stopChild;
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
            else if (request.method === "stop") {
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
              error: error instanceof BrokerError ? error.code : "graph-smoke-failed",
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
          await host.uninstall();
        } catch {
          /* Preserve isolated diagnostic data. */
        }
        app.exit(process.exitCode ?? 0);
      }
    }
  })
  .catch(() => app.exit(1));
