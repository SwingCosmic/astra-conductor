import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { app, BrowserWindow, protocol, safeStorage, session } from "electron";
import { silentLogger } from "@astra-conductor/core/internal";
import { startRuntime, type PolyQuotaRuntime } from "../src/server/runtime/start-runtime.js";
import { registerElectronServices } from "../src/platform/electron/register-electron-services.js";
import { createHonoApp } from "../src/server/http/create-hono-app.js";
import { ElectronProtocolAdapter } from "../src/platform/electron/protocol-adapter.js";
import { ElectronDynamicResourceService } from "../src/platform/electron/dynamic-resources.js";
import { installPageCsp, guardPage } from "../src/platform/electron/page-security.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = process.env.POLYQUOTA_PRIVATE_UI_DATA!;
const secret = "FICTIONAL-POLYQUOTA-STAGE-ONE-SECRET";
app.setPath("userData", path.join(directory, "electron"));
app.on("window-all-closed", () => undefined);
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

void app.whenReady().then(async () => {
  let window: BrowserWindow | undefined;
  let runtime: PolyQuotaRuntime | undefined;
  let isolated: PolyQuotaRuntime | undefined;
  const partition = session.fromPartition("persist:private-ui-smoke");
  const upstream: string[] = [];
  const providerSession = new Proxy(partition, {
    get(target, property, receiver) {
      if (property === "fetch")
        return async (input: string | Request, init?: RequestInit): Promise<Response> => {
          const url = typeof input === "string" ? input : input.url;
          assert(url.startsWith("https://open.bigmodel.cn/"), "Unexpected provider network access");
          assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
          upstream.push(url);
          return url.includes("customer-package-reset")
            ? Response.json({
                success: true,
                code: 200,
                data: { fiveHourResets: [], weekResets: [] },
              })
            : Response.json({
                success: true,
                code: 200,
                data: {
                  planName: "GLM Coding Pro Plan",
                  limits: [
                    {
                      type: "CREDIT_LIMIT",
                      unit: 3,
                      number: 5,
                      percentage: 25,
                      usage: 28000,
                      currentValue: 7000,
                      remaining: 21000,
                      nextResetTime: Date.now() + 3600000,
                    },
                  ],
                },
              });
        };
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const createRuntime = (profile: string) => {
    const outgoing = new AbortController();
    return startRuntime(
      (registry) =>
        registerElectronServices(registry, {
          dataDirectory: path.join(directory, profile),
          nativeBinding: path.join(root, "lib/better-sqlite3/better_sqlite3.node"),
          session: providerSession,
          signal: outgoing.signal,
          logger: silentLogger,
          credentialsAvailable: safeStorage.isEncryptionAvailable(),
          openExternal: async () => {
            throw new Error("Unexpected external auth");
          },
          showWindow: () => {},
        }),
      () => outgoing.abort(),
    );
  };
  let adapter!: ElectronProtocolAdapter;
  const resources = new ElectronDynamicResourceService(
    path.join(root, "assets/icons"),
    new Map([["product-icon", "polyquota.png"]]),
  );
  const useRuntime = (current: PolyQuotaRuntime) => {
    adapter = new ElectronProtocolAdapter(createHonoApp(current), resources, new Set(["null"]));
  };
  try {
    assert(safeStorage.isEncryptionAvailable(), "OS credential protection must be available");
    await partition.setProxy({ mode: "direct" });
    isolated = await createRuntime("isolated");
    runtime = await createRuntime("private");
    useRuntime(runtime);
    partition.protocol.handle("polyquota-app", (request) => adapter.handle(request));
    installPageCsp(partition);
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        session: partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    const renderer = path.join(root, "renderer/index.html");
    guardPage(window, pathToFileURL(renderer).href, () => adapter.abortRequests());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const evaluate = (body: string): Promise<unknown> =>
      window!.webContents.executeJavaScript(`(async () => {
      const wait = async predicate => { const deadline=Date.now()+10000; while(!predicate()) { if(Date.now()>deadline) throw new Error('render-timeout: '+document.body.innerText); await new Promise(resolve=>setTimeout(resolve,20)); } };
      const button=(root,label)=>[...root.querySelectorAll('button')].find(item=>item.textContent.trim().endsWith(label));
      ${body}
    })()`);
    await window.loadFile(renderer);
    await evaluate(`
      if (typeof window.require !== 'undefined' || 'polyQuotaElectronService' in window) throw new Error('business-preload-visible');
      await wait(()=>button(document.querySelector('nav'),'服务商'));
      button(document.querySelector('nav'),'服务商').click();
      await wait(()=>document.querySelectorAll('.provider-row').length===8);
      const row=[...document.querySelectorAll('.provider-row')].find(row=>row.textContent.includes('BigModel Coding Plan'));
      if (!row.textContent.includes('尚未接入')) throw new Error('private-profile-not-empty');
      button(row,'添加账号').click(); await wait(()=>document.querySelector('[role=dialog]'));
      button(document.querySelector('[role=dialog]'),'API Key').click();
      await wait(()=>document.querySelector('#provider-api-key'));
      const input=document.querySelector('#provider-api-key'); input.value=${JSON.stringify(secret)}; input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,20));
      button(document.querySelector('[role=dialog]'),'验证并添加').click();
      await wait(()=>!document.querySelector('[role=dialog]'));
      await wait(()=>row.textContent.includes('已接入 · 1 个账号'));
      row.querySelector('[aria-label="展开账号"]').click();
      await wait(()=>button(row,'停用'));
      if (document.body.innerText.includes(${JSON.stringify(secret)})) throw new Error('secret-rendered');
      button(row,'停用').click(); await wait(()=>row.textContent.includes('已停用'));
    `);
    const first = await runtime.providers.getSnapshot();
    assert.equal(first.accounts.length, 1);
    assert.equal(first.accounts[0]!.enabled, false);
    const accountId = first.accounts[0]!.id;
    assert.equal((await isolated.providers.getSnapshot()).accounts.length, 0);
    assert(
      upstream.length >= 2,
      "Account validation and initial quota refresh must use controlled upstream",
    );
    const disk = await readFile(path.join(directory, "private/polyquota.db"));
    assert(!disk.includes(Buffer.from(secret)), "SQLite must not contain plaintext credentials");
    const artifacts =
      process.env.POLYQUOTA_SMOKE_ARTIFACTS ?? path.join(tmpdir(), "astra-stage1-ui");
    await mkdir(artifacts, { recursive: true });
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(
      path.join(artifacts, "polyquota-providers-private.png"),
      (
        await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      ).toPNG(),
    );
    adapter.abortRequests();
    await runtime.stop();
    runtime = await createRuntime("private");
    useRuntime(runtime);
    const restored = await runtime.providers.getSnapshot();
    assert.equal(restored.accounts[0]!.id, accountId);
    assert.equal(restored.accounts[0]!.enabled, false);
    await window.loadFile(renderer);
    await evaluate(`
      await wait(()=>button(document.querySelector('nav'),'服务商')); button(document.querySelector('nav'),'服务商').click();
      await wait(()=>document.querySelectorAll('.provider-row').length===8);
      const row=[...document.querySelectorAll('.provider-row')].find(row=>row.textContent.includes('BigModel Coding Plan'));
      row.querySelector('[aria-label="展开账号"]').click(); await wait(()=>button(row,'启用'));
      window.confirm=()=>true; button(row,'删除').click(); await wait(()=>row.textContent.includes('尚未接入'));
    `);
    adapter.abortRequests();
    await runtime.stop();
    runtime = await createRuntime("private");
    assert.equal((await runtime.providers.getSnapshot()).accounts.length, 0);
    assert.equal((await isolated.providers.getSnapshot()).accounts.length, 0);
    window.destroy();
    window = undefined;
    await runtime.stop();
    runtime = undefined;
    await isolated.stop();
    isolated = undefined;
    console.info(
      `POLYQUOTA_PRIVATE_UI_SMOKE_OK ${JSON.stringify({ safeStorage: true, sqlite: true, noBusinessPreload: true, privateAuth: true, masked: true, initialQuotaRefresh: true, isolatedProfiles: true, restartIdentity: true, enablementPersistence: true, uiDeletionPersistence: true, screenshot: path.join(artifacts, "polyquota-providers-private.png") })}`,
    );
    app.exit(0);
  } catch (error) {
    console.error(
      "POLYQUOTA_PRIVATE_UI_SMOKE_FAILED",
      error instanceof Error ? error.stack : "unknown",
    );
    window?.destroy();
    adapter!?.abortRequests();
    await runtime?.stop();
    await isolated?.stop();
    app.exit(1);
  }
});
