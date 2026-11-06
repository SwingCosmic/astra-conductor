import { app, BrowserWindow, session } from "electron";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerElectronServices } from "../dist/platform/electron/register-electron-services.js";
import { Services } from "../dist/runtime/register-common-services.js";

// Interactive smoke: select a directory or cancel the native picker; no data is exported.
app
  .whenReady()
  .then(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "polyquota-picker-"));
    const values = new Map();
    const registry = {
      register() {
        return this;
      },
      value(id, value) {
        values.set(id, value);
        return this;
      },
    };
    registerElectronServices(registry, {
      dataDirectory: root,
      nativeBinding: "unused",
      session: session.defaultSession,
      signal: new AbortController().signal,
      logger: { info() {}, error() {} },
      credentialsAvailable: true,
      openExternal: async () => {},
      showWindow() {},
    });
    const window = new BrowserWindow({
      show: true,
      width: 520,
      height: 220,
      title: "PolyQuota 目录选择验证",
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    await window.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          "<h2>PolyQuota 系统目录选择器验证</h2><p>隔离测试，不访问实际账号。选择文件夹或取消后自动关闭。</p>",
        ),
    );
    const timer = setTimeout(() => app.exit(2), 120_000);
    const selected = await values.get(Services.sharingPaths).selectDirectory();
    clearTimeout(timer);
    const passed = selected === null || (typeof selected === "string" && path.isAbsolute(selected));
    const result = {
      passed,
      cancelled: selected === null,
      selectedDirectory: typeof selected === "string",
    };
    await writeFile(path.join(root, "result.json"), JSON.stringify(result));
    console.log(JSON.stringify({ root, ...result }));
    app.exit(passed ? 0 : 1);
  })
  .catch(() => app.exit(1));
