import type { ServiceResult, PolyQuotaSnapshot } from "@astra-conductor/polyquota-contract";
import { app, BrowserWindow, protocol, session } from "electron";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { silentLogger } from "@astra-conductor/core/internal";
import { startRuntime } from "../src/runtime/start-runtime.js";
import { registerElectronServices } from "../src/platform/electron/register-electron-services.js";
import { ElectronDynamicResourceService } from "../src/platform/electron/dynamic-resources.js";
import { ElectronProtocolAdapter } from "../src/platform/electron/protocol-adapter.js";
import { installPageCsp, guardPage } from "../src/platform/electron/page-security.js";
import { createHonoApp } from "../src/http/create-hono-app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = process.env.POLYQUOTA_PROTOCOL_DATA!;
const devUrl = process.env.POLYQUOTA_PROTOCOL_VITE!;
const backendUrl = process.env.POLYQUOTA_PROTOCOL_BACKEND!;
app.setPath("userData", dataDirectory);
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
void app
  .whenReady()
  .then(async () => {
    const partition = session.fromPartition("persist:protocol-smoke");
    await partition.setProxy({ mode: "direct" });
    const outgoing = new AbortController();
    const runtime = await startRuntime(
      (registry) =>
        registerElectronServices(registry, {
          dataDirectory,
          nativeBinding: path.join(root, "lib/better-sqlite3/better_sqlite3.node"),
          session: partition,
          signal: outgoing.signal,
          logger: silentLogger,
          credentialsAvailable: false,
          openExternal: async () => {
            throw new Error("Unexpected external auth in smoke");
          },
          showWindow: () => undefined,
        }),
      () => outgoing.abort(),
    );
    const hono = createHonoApp(runtime);
    hono.get("/v1/probe", (c) =>
      c.json({ query: c.req.query("q"), method: c.req.method }, 202, { "X-Probe": "preserved" }),
    );
    hono.post("/v1/probe", async (c) =>
      c.json({
        body: await c.req.json(),
        contentType: c.req.header("content-type"),
        method: c.req.method,
      }),
    );
    const resources = new ElectronDynamicResourceService(
      path.join(root, "assets/icons"),
      new Map([["product-icon", "polyquota.png"]]),
    );
    const adapter = new ElectronProtocolAdapter(
      hono,
      resources,
      new Set(["null", new URL(devUrl).origin]),
    );
    partition.protocol.handle("polyquota-app", (request) => adapter.handle(request));
    let window: BrowserWindow | undefined;
    let exitCode = 0;
    const clientBundle = await readFile(path.join(root, "dist/protocol-client.js"), "utf8");

    async function waitForSubscriptions(count: number): Promise<void> {
      const limit = Date.now() + 3000;
      while (runtime.events.subscriberCount !== count) {
        if (Date.now() > limit)
          throw new Error(
            `Leaked subscriptions: expected ${count}, received ${runtime.events.subscriberCount}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    try {
      for (const mode of ["file", "vite"] as const) {
        const beforeWindow = runtime.events.subscriberCount;
        installPageCsp(
          partition,
          mode === "vite" ? new URL(devUrl).origin : undefined,
          mode === "vite" ? new URL(backendUrl).origin : undefined,
        );
        window = new BrowserWindow({
          width: 1280,
          height: 900,
          show: false,
          webPreferences: {
            session: partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            backgroundThrottling: false,
          },
        });
        guardPage(
          window,
          mode === "file" ? pathToFileURL(path.join(root, "renderer/index.html")).href : devUrl,
          () => adapter.abortRequests(),
        );
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        if (mode === "file") await window.loadFile(path.join(root, "renderer/index.html"));
        else await window.loadURL(devUrl);
        const sourceUrl = window.webContents.getURL();
        if (mode === "file" ? !sourceUrl.startsWith("file:") : !sourceUrl.startsWith(devUrl))
          throw new Error("UI load path changed");
        await window.webContents.executeJavaScript(`(async () => {
          if ("polyQuotaElectronService" in window) throw new Error("Legacy business bridge present");
          const limit = Date.now() + 5000;
          while (!document.querySelector("nav button")) { if (Date.now() > limit) throw new Error("UI did not mount"); await new Promise(r => setTimeout(r, 20)); }
          [...document.querySelectorAll("nav button")].find(button => button.textContent.includes("设置")).click();
          while (!document.querySelector('.host-status')?.textContent.includes(${JSON.stringify(mode === "file" ? "系统通知" : "未配置")})) { if (Date.now() > limit) throw new Error("UI did not load real capabilities"); await new Promise(r => setTimeout(r, 20)); }
        })()`);
        if (mode === "vite") {
          await window.webContents.executeJavaScript(`(async () => {
        const wait = async (check) => { const limit = Date.now() + 5000; while (!check()) { if (Date.now() > limit) throw new Error("Web UI did not load backend state"); await new Promise(r => setTimeout(r, 20)); } };
        [...document.querySelectorAll("nav button")].find(button => button.textContent.includes("设置")).click();
        await wait(() => document.querySelector('.settings-page input[type="number"]'));
        const input = document.querySelector('.settings-page input[type="number"]');
        input.value = "19"; input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector('.settings-page .primary-action').click();
        await wait(() => document.querySelector('.save-message')?.textContent.includes("设置已保存"));
        const saved = await fetch(${JSON.stringify(backendUrl)} + "/v1/polyquota/snapshot").then(response => response.json());
        if (!saved.ok || saved.value.settings.pollingIntervalMinutes !== 19 || saved.value.accounts.length !== 0 || saved.value.providers.length !== 7) throw new Error("Web UI did not persist real backend settings");
      })()`);
          // Use the mounted App bridge, actual SSE and actual HTTP receipt route.
          // The browser API is controlled so OS notification settings cannot make
          // this transport test spuriously fail or display a real user toast.
          await window.webContents.executeJavaScript(`(() => {
            class TestNotification extends EventTarget {
              static permission = "granted";
              constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("show"))); }
              close() {}
            }
            window.Notification = TestNotification;
          })()`);
          const delivered = new Promise<boolean>((resolve) => {
            const receive = (message: unknown): void => {
              const result = message as { type?: string; delivered?: boolean };
              if (result.type !== "polyquota:test-notification-result") return;
              process.removeListener("message", receive);
              resolve(result.delivered === true);
            };
            process.on("message", receive);
          });
          process.send?.({ type: "polyquota:test-notification" });
          if (!(await delivered)) throw new Error("Web notification receipt was not delivered");
          console.info("POLYQUOTA_WEB_NOTIFICATION_OK");
          console.info("POLYQUOTA_WEB_UI_SAVE_OK");
        }
        const baseline = runtime.events.subscriberCount;
        const result = await window.webContents.executeJavaScript(`${clientBundle}\n(async () => {
      const base = "polyquota-app://app";
      const query = await fetch(base + "/v1/probe?q=中文");
      if (query.status !== 202 || query.headers.get("x-probe") !== "preserved") throw new Error("response metadata lost");
      if ((await query.json()).query !== "中文") throw new Error("query lost");
      const posted = await fetch(base + "/v1/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hello: "世界" }) });
      if ((await posted.json()).body.hello !== "世界") throw new Error("POST body lost");
      const client = new ProtocolClient.HttpPolyQuotaService(base);
      let latest = null;
      const dispose = client.subscribe((event) => { latest = event; });
      await client.waitForEvents();
      const initial = await client.getSnapshot();
      if (!initial.ok) throw new Error("snapshot failed");
      const saved = await client.saveSettings({ ...initial.value.settings, pollingEnabled: !initial.value.settings.pollingEnabled });
      if (!saved.ok || saved.value !== undefined) throw new Error("void result failed");
      const limit = Date.now() + 3000;
      while (!latest || latest.revision <= initial.value.revision) { if (Date.now() > limit) throw new Error("SSE did not stream changes"); await new Promise(r => setTimeout(r, 20)); }
      const current = await client.getSnapshot();
      if (!current.ok || current.value.revision < latest.revision) throw new Error("stale snapshot");
      const invalid = await fetch(base + "/v1/polyquota/accounts/x/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"accountId":"x"}' });
      if (invalid.status !== 400 || (await invalid.json()).error.code !== "validation") throw new Error("invalid body accepted");
      await client.saveSettings(initial.value.settings);
      dispose();
      const icon = await fetch("polyquota-app://resources/product-icon");
      if (!icon.ok || icon.headers.get("content-type") !== "image/png" || (await icon.arrayBuffer()).byteLength === 0) throw new Error("dynamic resource failed");
      if ((await fetch("polyquota-app://app/index.html")).status !== 404) throw new Error("unexpected default UI fallback");
      return { source: location.protocol, revision: current.value.revision, appMounted: !!document.querySelector('.app-shell') };
    })()`);
        await waitForSubscriptions(baseline);
        if (!result.appMounted) throw new Error("UI failed to mount");
        // Chromium reader cancellation and explicit AbortSignal are distinct paths.
        for (const method of ["cancel", "abort"] as const) {
          await window.webContents.executeJavaScript(`(async () => {
        const controller = new AbortController();
        const response = await fetch("polyquota-app://app/v1/polyquota/events", { signal: controller.signal });
        const reader = response.body.getReader(); await reader.read();
        ${method === "cancel" ? "await reader.cancel();" : "controller.abort();"}
      })()`);
          await waitForSubscriptions(baseline);
        }
        await window.webContents.executeJavaScript(
          `(async () => { window.pendingStream = await fetch("polyquota-app://app/v1/polyquota/events"); window.pendingReader = window.pendingStream.body.getReader(); await window.pendingReader.read(); })()`,
        );
        window.destroy();
        window = undefined;
        await waitForSubscriptions(beforeWindow);
        console.info(`POLYQUOTA_PROTOCOL_SMOKE_OK ${mode} ${JSON.stringify(result)}`);
      }
      // The Vite page ran against a separate real Node backend, with no demo accounts.
      const backend = await fetch(`${backendUrl}/v1/polyquota/snapshot`).then(
        (response) => response.json() as Promise<ServiceResult<PolyQuotaSnapshot>>,
      );
      if (!backend.ok || backend.value.accounts.length)
        throw new Error("Web verification used demo data");
      console.info("POLYQUOTA_WEB_BACKEND_SMOKE_OK");
    } catch (error) {
      console.error(
        "POLYQUOTA_PROTOCOL_SMOKE_FAILED",
        error instanceof Error ? error.message : "unknown",
      );
      exitCode = 1;
    } finally {
      window?.destroy();
      partition.protocol.unhandle("polyquota-app");
      await runtime.stop();
      app.exit(exitCode);
    }
  })
  .catch((error: unknown) => {
    console.error(
      "PROTOCOL_SMOKE_START_FAILED",
      error instanceof Error ? error.message : "unknown",
    );
    app.exit(1);
  });
