import { app, BrowserWindow, protocol, session } from "electron";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CoreServices,
  CredentialVault,
  SharedCredentialService,
} from "@astra-conductor/core/internal";
import {
  BrokerClient,
  SharedBrokerClient,
  BROKER_DISTRIBUTION,
} from "@astra-conductor/credentials";
import { WindowsBrokerHost } from "@astra-conductor/credentials/host/windows";
import { SqliteStorage } from "../dist/platform/common/sqlite-storage.js";
import { ElectronSafeStorageCipher } from "../dist/platform/electron/safe-storage-cipher.js";
import { registerElectronServices } from "../dist/platform/electron/register-electron-services.js";
import { startRuntime } from "../dist/server/runtime/start-runtime.js";
import { Services } from "../dist/server/runtime/register-common-services.js";
import { createHonoApp } from "../dist/server/http/create-hono-app.js";
import { GraphStorage } from "../../graph-agent/dist/platform/storage.js";
import { graphUiResource } from "../../graph-agent/dist/platform/resources.js";
import { createGraphServices } from "../../graph-agent/dist/server/services.js";
import { createGraphHonoApp } from "../../graph-agent/dist/server/create-hono-app.js";
import { serve } from "@hono/node-server";

const [product, root, seed] = process.argv.slice(2);
assert(["polyquota", "graph-agent"].includes(product));
const graph = product === "graph-agent";
const apps = fileURLToPath(new URL("../../", import.meta.url));
const directory = path.join(root, product);
const sharing = path.join(directory, "credential-sharing");
const home = path.join(process.env.LOCALAPPDATA, "AstraCredentialBroker");
const host = new WindowsBrokerHost(
  path.join(home, "v1"),
  path.join(home, "downloads", "win-x64", BROKER_DISTRIBUTION.version),
  sharing,
);
const profile = async () =>
  JSON.parse(await readFile(path.join(sharing, "migration-state.json"), "utf8"));
const cipher = new ElectronSafeStorageCipher();
const nativeBinding = path.join(root, "better_sqlite3.node");
const scheme = graph ? "graph-agent-app" : "polyquota-app";
const origin = scheme + "://app";
protocol.registerSchemesAsPrivileged([
  {
    scheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
app.setPath("userData", directory);
app.setName(graph ? "GraphAgent" : "PolyQuota");
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(start)
  .catch((error) => {
    console.error(product + " loop startup: " + error.message);
    app.exit(1);
  });
async function start() {
  await mkdir(directory, { recursive: true });
  assert(await cipher.isAvailable());
  const accountId = "fictional-codex";
  const probeId = "usage-probe";
  let expectedUsageToken = "FICTIONAL-USAGE";
  const measurements = new AsyncLocalStorage();
  if (seed === "performance") {
    const original = BrokerClient.prototype.call;
    BrokerClient.prototype.call = function (method, params) {
      const sample = measurements.getStore();
      if (sample) {
        sample.rpc[method] = (sample.rpc[method] ?? 0) + 1;
        if (method === "getCredential") sample.reads.push(params.credentialId);
      }
      return original.call(this, method, params);
    };
  }
  function account(id, name, key = false) {
    const time = new Date().toISOString();
    return {
      id,
      provider: key ? "opaque-example" : "codex",
      offeringId: key ? "opaque-example" : "codex",
      authMethod: key ? "api-key" : "browser-oauth",
      stableIdentity: id,
      displayName: name,
      maskedIdentifier: "fic***",
      enabled: true,
      credentialState: "available",
      publicMetadata: {},
      createdAt: time,
      updatedAt: time,
    };
  }
  function envelope(a, token) {
    return {
      version: 1,
      accountId: a.id,
      provider: a.provider,
      authMethod: a.authMethod,
      expiresAt: null,
      secrets:
        a.authMethod === "api-key"
          ? { apiKey: token }
          : { accessToken: token, refreshToken: "FICTIONAL-REFRESH-1" },
    };
  }
  if (seed) {
    const store = graph
      ? new GraphStorage(path.join(directory, "private-business.json"))
      : new SqliteStorage(path.join(directory, "polyquota.db"), { nativeBinding });
    const vault = new CredentialVault(store, cipher);
    for (const a of [
      account(accountId, seed),
      account(seed === "source" ? "inference-only" : "private-only", seed + " Key", true),
    ])
      await vault.saveAccount(a, envelope(a, "FICTIONAL-" + seed));
    if (seed === "performance") {
      const a = account(probeId, "Usage probe");
      await vault.saveAccount(a, {
        ...envelope(a, "FICTIONAL-USAGE"),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    }
    store.close();
  }

  let refreshCalls = 0;
  let upstreamAttempts = 0;
  const http = {
    fetch: async (url, init) => {
      upstreamAttempts++;
      if (String(url).endsWith("/wham/usage") && seed === "performance") {
        assert.equal(
          new Headers(init.headers).get("authorization"),
          "Bearer " + expectedUsageToken,
        );
        const sample = measurements.getStore();
        if (sample) sample.usageRequests++;
        return Response.json({
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000 } },
        });
      }
      assert(String(url).includes("/oauth/token"), "unexpected provider request");
      const token = new URLSearchParams(String(init.body)).get("refresh_token");
      assert(/^FICTIONAL-REFRESH-\d+$/.test(token));
      const next = Number(token.split("-").at(-1)) + 1;
      refreshCalls++;
      return Response.json({
        access_token: "FICTIONAL-ACCESS-" + next,
        refresh_token: "FICTIONAL-REFRESH-" + next,
        expires_in: 3600,
      });
    },
  };
  const unavailable = async () => {
    throw new Error("unexpected external authentication");
  };
  const dependencies = {
    http,
    files: { readText: unavailable },
    authorization: { present: unavailable },
    callbackServer: { start: unavailable },
  };
  let chosen = path.join(root, "vault");
  let runtime, hono, web, webServer;
  if (graph) {
    runtime = await createGraphServices({
      ...dependencies,
      host,
      directory,
      cipher,
      selectDirectory: async () => chosen,
    });
    hono = createGraphHonoApp(runtime);
  } else {
    runtime = await startRuntime((registry) => {
      registerElectronServices(registry, {
        dataDirectory: directory,
        nativeBinding,
        session: session.defaultSession,
        signal: new AbortController().signal,
        logger: { info() {}, warn() {}, error() {} },
        credentialsAvailable: true,
        openExternal: unavailable,
        showWindow() {},
      });
      registry.override(CoreServices.http, [], () => http);
      registry.override(Services.sharingPaths, [], () => ({
        dataDirectory: directory,
        selectDirectory: async () => chosen,
      }));
    });
    hono = createHonoApp(runtime);
  }
  const scopedRequests = new AbortController();
  protocol.handle(scheme, (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "app") return new Response(null, { status: 404 });
    if (url.pathname.startsWith("/api/"))
      return hono.fetch(
        new Request(request, { signal: AbortSignal.any([request.signal, scopedRequests.signal]) }),
      );
    return graphUiResource(path.join(apps, product, "ui/dist"), url.pathname);
  });
  const win = new BrowserWindow({
    show: false,
    width: 1180,
    height: 830,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  await win.loadURL(seed === "performance" ? "about:blank" : origin + "/");
  const evaluate = (fn, ...args) =>
    win.webContents.executeJavaScript("(" + fn.toString() + ")(..." + JSON.stringify(args) + ")");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function wait(name, condition) {
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      const result = await condition();
      if (result) return result;
      await sleep(125);
    }
    const diagnostic = await evaluate(() => ({
      heading: document.querySelector("h1")?.textContent,
      error: document.querySelector('.credential-storage-manager [role="status"]:last-child')
        ?.textContent,
      buttons: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()),
    }));
    throw new Error(name + " timed out " + JSON.stringify(diagnostic));
  }
  async function click(...names) {
    return wait(names.join("/"), () =>
      evaluate((names) => {
        const b = [...document.querySelectorAll("button")].find(
          (b) =>
            !b.disabled &&
            (names.includes(b.textContent.trim()) ||
              (b.closest("nav") && names.some((n) => b.textContent.trim().endsWith(n)))),
        );
        if (!b) return false;
        b.click();
        return true;
      }, names),
    );
  }
  async function fill(label, value) {
    await wait(label, () =>
      evaluate(
        (label, value) => {
          const input = [...document.querySelectorAll("input")].find(
            (n) => n.getAttribute("aria-label") === label,
          );
          if (!input || input.disabled) return false;
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        },
        label,
        value,
      ),
    );
  }
  await evaluate(() => {
    window.confirm = () => true;
  });
  if (graph) await click("凭据管理");
  else if (seed !== "performance") {
    await click("设置");
    await click("管理凭据存储");
  }
  const credentials = "/api/v1/credential-sharing/status";
  const providers = "/api/v1/providers";
  async function api(pathname, body) {
    let options = {};
    if (body !== undefined) {
      const context = await api(providers);
      options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceId: context.instanceId,
          contextId: context.backend.contextId,
          ...body,
        }),
      };
    }
    const response = await hono.request(pathname, options);
    const result = await response.json();
    if (!result.ok)
      throw new Error(pathname + " " + result.error.code + " " + result.error.message);
    return result.value;
  }
  const captions = {
    private: "初始 · 内置存储",
    "export-ready": "导出完成，等待迁移",
    "import-ready": "导入成功，等待迁移",
    shared: "迁移完成 · 当前使用共享存储",
    "private-ready": "内置写入成功，等待切换",
  };
  async function state(wanted) {
    await wait(wanted, () =>
      evaluate(
        (title) => [...document.querySelectorAll("h2")].some((h) => h.textContent.trim() === title),
        captions[wanted],
      ),
    );
    const status = await api(credentials);
    assert.equal(status.migrationState, wanted);
    assert.equal(
      status.selectedBackend,
      ["private", "import-ready", "export-ready"].includes(wanted) ? "private" : "shared",
    );
    assert.equal(status.activeBackend, status.selectedBackend);
    assert.equal(status.rememberedKey, wanted !== "private");
    assert(
      !JSON.stringify(status).includes("FICTIONAL-") && !JSON.stringify(status).includes("acm1_"),
    );
    return status;
  }
  async function withSharing(fn, instanceId = "loop-record-operations") {
    const { binding } = await profile();
    const broker = new SharedBrokerClient(() =>
      host.connect(binding.vaultDirectory, binding.clientId, instanceId),
    );
    try {
      return await fn(new SharedCredentialService(broker), broker);
    } finally {
      broker.close();
    }
  }
  async function stopWeb() {
    if (!web) return;
    const closed = new Promise((resolve) => webServer.close(resolve));
    webServer.closeAllConnections?.();
    await web.stop();
    await closed;
    web = webServer = undefined;
  }
  async function webStart() {
    await stopWeb();
    const { binding } = await profile();
    const existing = new WindowsBrokerHost(host.home, host.localPackageDirectory, sharing, true);
    web = await createGraphServices({
      ...dependencies,
      directory: path.join(root, "web"),
      host: existing,
      brokerBinding: binding,
    });
    webServer = await new Promise((resolve) => {
      const server = serve(
        {
          fetch: createGraphHonoApp(web).fetch,
          hostname: "127.0.0.1",
          port: 0,
          overrideGlobalObjects: false,
        },
        () => resolve(server),
      );
    });
    const url = "http://127.0.0.1:" + webServer.address().port;
    let result = await (await fetch(url + credentials)).json();
    if (result.value.activeBackend === "unavailable") {
      const retry = await (
        await fetch(url + "/api/v1/credential-sharing/retry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instanceId: result.value.instanceId,
            contextId: result.value.contextId,
          }),
        })
      ).json();
      assert(retry.ok, retry.error?.code + ": " + retry.error?.message);
      result = await (await fetch(url + credentials)).json();
    }
    assert.equal(result.value.migrationState, null);
    assert.equal(result.value.activeBackend, "shared");
    assert.equal(result.value.privateAvailable, false);
    return true;
  }
  async function handle({ op, arg }) {
    switch (op) {
      case "state":
        return state(arg);
      case "offline": {
        const status = await api(credentials);
        assert.equal(status.migrationState, arg);
        assert.equal(status.selectedBackend, "shared");
        assert.equal(status.activeBackend, "unavailable");
        assert(status.rememberedKey);
        return true;
      }
      case "export": {
        await click("导出凭据");
        await fill("导出目录", chosen);
        await click("确认导出");
        await state("export-ready");
        const key = await wait("migration key", () =>
          evaluate(() => document.querySelector("textarea[readonly]")?.value),
        );
        assert(key.startsWith("acm1_"));
        await click("我已保存");
        await wait("delivery acknowledged", () =>
          evaluate(() => !document.querySelector("textarea[readonly]")),
        );
        return key;
      }
      case "import": {
        await click("导入凭据");
        await fill("导入目录", chosen);
        await fill("导入迁移密钥", arg);
        await click("验证导入", "重试导入");
        await click("确认导入");
        return state("import-ready");
      }
      case "bad-key": {
        await click("重新检查");
        const status = await api(credentials);
        if (status.keyCleanupPending || status.sessionCleanupPending) {
          await click("重试清理");
          await wait("retired binding cleanup", async () => {
            const current = await api(credentials);
            return !current.keyCleanupPending && !current.sessionCleanupPending;
          });
        }
        await click("导入凭据");
        await fill("导入目录", chosen);
        await fill("导入迁移密钥", "acm1_" + Buffer.alloc(32, 3).toString("base64url"));
        await click("验证导入");
        await wait("retry form", () =>
          evaluate(() =>
            Array.from(document.querySelectorAll("button")).some(
              (b) => b.textContent.trim() === "重试导入",
            ),
          ),
        );
        assert.equal((await api(credentials)).migrationState, "private");
        await click("取消");
        return true;
      }
      case "shared": {
        await click("迁移到共享存储", "使用共享当前值并迁移", "重试迁移");
        await wait("business activation", async () => {
          const ready = await evaluate(() =>
            [...document.querySelectorAll("h2")].some((h) => h.textContent.includes("迁移完成")),
          );
          if (ready) return true;
          await evaluate(() => {
            const b = [...document.querySelectorAll("button")].find(
              (b) => !b.disabled && b.textContent.trim() === "使用共享当前值并迁移",
            );
            b?.click();
          });
          return false;
        });
        return state("shared");
      }
      case "prepare":
        await click("准备返回内置存储", "更新内置快照", "重试准备");
        await wait("prepare completion", async () => {
          const result = await evaluate(() => {
            const buttons = [...document.querySelectorAll("button")]
              .filter((b) => !b.disabled)
              .map((b) => b.textContent.trim());
            return buttons.includes("重试准备") ? "failed" : buttons.includes("切换到内置存储");
          });
          if (result === "failed")
            throw Error("snapshot preparation failed: " + (await api(credentials)).lastError);
          return result;
        });
        return state("private-ready");
      case "private":
        await click("切换到内置存储", "重试切换");
        return state("private");
      case "list":
        return (await api(providers)).accounts.map((a) => ({ id: a.id, name: a.displayName }));
      case "refresh": {
        const before = refreshCalls;
        await api("/api/v1/accounts/" + accountId + "/refresh-credentials", {});
        assert.equal(refreshCalls, before + 1);
        return true;
      }
      case "no-usage": {
        assert(!graph);
        const before = upstreamAttempts;
        const response = await hono.request("/api/v1/polyquota/accounts/inference-only/refresh", {
          method: "POST",
        });
        const result = await response.json();
        assert(result.ok);
        assert.equal(result.value.status, "skipped");
        assert.equal(upstreamAttempts, before);
        return true;
      }
      case "enable-probe-sharing": {
        assert(!graph && seed === "performance");
        const sharing = runtime.credentialSharing;
        assert.equal(sharing.getBackendContext().active, "private");
        await sharing.exportCredentials(chosen);
        await sharing.acknowledgeDelivery();
        await sharing.enableShared();
        assert.equal(sharing.getBackendContext().active, "shared");
        return true;
      }
      case "rotate-peer-token": {
        assert(!graph && seed === "performance");
        assert([accountId, probeId].includes(arg));
        const revision = await withSharing(async (shared) => {
          const { account, credentials } = await shared.readAccount(arg);
          await shared.saveAccount(account, {
            ...credentials,
            secrets: { ...credentials.secrets, accessToken: "FICTIONAL-ROTATED" },
          });
          return shared.recordRevision(arg);
        });
        assert(revision);
        await wait(
          "peer revision visible in active backend",
          () => runtime.registry.get(CoreServices.vault).recordRevision(arg) === revision,
        );
        if (arg === probeId) expectedUsageToken = "FICTIONAL-ROTATED";
        return true;
      }
      case "read-during-update": {
        assert(!graph && seed === "performance");
        return withSharing(async (_shared, reader) => {
          const committed = await reader.getCredential(probeId);
          return withSharing(async (_writerService, writer) => {
            const result = await writer.update(
              probeId,
              committed.description.revision,
              async () => {
                const sample = { rpc: {}, reads: [] };
                const start = performance.now();
                await measurements.run(sample, async () => {
                  const accounts = await api(providers);
                  assert(accounts.accounts.some((item) => item.id === probeId));
                  const current = await reader.getCredential(probeId);
                  assert.equal(current.description.revision, committed.description.revision);
                  assert(
                    current.payload === committed.payload,
                    "expected the last committed value",
                  );
                });
                assert.deepEqual(sample.rpc, { getCredential: 1 });
                return { value: { ...sample, durationMs: performance.now() - start } };
              },
            );
            return result.value;
          }, "loop-active-writer");
        }, "loop-concurrent-reader");
      }
      case "measure-usage": {
        assert(!graph && seed === "performance");
        const samples = [];
        for (let i = 0; i < 3; i++) {
          const sample = { rpc: {}, reads: [], usageRequests: 0 };
          const start = performance.now();
          await measurements.run(sample, async () => {
            const response = await hono.request(
              "/api/v1/polyquota/accounts/" + probeId + "/refresh",
              {
                method: "POST",
              },
            );
            const result = await response.json();
            assert(result.ok);
            assert.equal(result.value.status, "updated");
            assert.equal(sample.usageRequests, 1);
          });
          samples.push({
            ...sample,
            durationMs: Math.round((performance.now() - start) * 100) / 100,
          });
        }
        return samples;
      }
      case "verify-record":
        return withSharing(async (shared) => {
          const { credentials } = await shared.readAccount(arg.id);
          assert(credentials.secrets[arg.field] === arg.value, "unexpected shared record value");
          return true;
        });
      case "replace":
        return withSharing(async (shared) => {
          const a = account("loop-created-key", arg, true);
          await shared.saveAccount(a, envelope(a, "FICTIONAL-" + arg));
          return true;
        });
      case "competing-create":
        return withSharing(async (shared) => {
          const a = {
            ...account("loop-" + product, "competing Key", true),
            stableIdentity: "same-test-identity",
          };
          try {
            await shared.saveAccount(a, envelope(a, "FICTIONAL-concurrent"));
            return "created";
          } catch (error) {
            if (error.code === "credential-identity-exists") return "identity-conflict";
            throw error;
          }
        });
      case "delete": {
        const snap = await api(providers);
        const c = snap.connections.find((c) => c.accountId === arg);
        assert(c);
        await api("/api/v1/accounts/" + arg + "/delete", {
          expectedRecordRevision: c.recordRevision,
        });
        return true;
      }
      case "web":
        return webStart();
      case "web-stop":
        await stopWeb();
        return true;
      case "relocate":
        chosen = arg;
        await click("变更共享目录");
        await wait("new binding", async () => {
          if ((await profile()).binding.vaultDirectory === arg) return true;
          const error = await evaluate(() => {
            const manager = document.querySelector(".credential-storage-manager");
            const checking = [...manager.querySelectorAll("button")].find(
              (b) => b.textContent.trim() === "重新检查",
            );
            return (
              !checking?.disabled &&
              manager.querySelector('[role="status"]:last-child')?.textContent.trim()
            );
          });
          if (error) throw Error("relocate: " + error);
          return false;
        });
        return true;
      case "screenshot": {
        assert(!(await evaluate(() => !!document.querySelector("textarea[readonly]"))));
        await writeFile(
          path.join(root, product + "-" + arg + ".png"),
          (await win.webContents.capturePage()).toPNG(),
        );
        return true;
      }
      case "stop":
        await stopWeb();
        scopedRequests.abort();
        win.destroy();
        await runtime.stop();
        return true;
      default:
        throw Error("unknown loop operation");
    }
  }
  process.on("message", async (request) => {
    try {
      const value = await handle(request);
      process.send({ id: request.id, value }, () => {
        if (request.op === "stop") app.exit(0);
      });
    } catch (error) {
      process.send({ id: request.id, error: error.message });
    }
  });
  process.send({ ready: true });
}
