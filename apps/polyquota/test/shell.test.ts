import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hostSource = readFileSync(
  new URL("../src/platform/electron/register-electron-services.ts", import.meta.url),
  "utf8",
);
const runtimeSource = readFileSync(
  new URL("../src/runtime/start-runtime.ts", import.meta.url),
  "utf8",
);

const securitySource = readFileSync(
  new URL("../src/platform/electron/page-security.ts", import.meta.url),
  "utf8",
);
const mainSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/main.ts"),
  "utf8",
);
const preloadSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/preload.ts"),
  "utf8",
);
const proxyDetectionSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/proxy-detection.ts"),
  "utf8",
);
const developmentRunnerSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/run-electron-mode.mjs"),
  "utf8",
);

describe("PolyQuota desktop shell", () => {
  it("isolates the renderer and keeps provider protocols outside the shell", () => {
    expect(mainSource).toContain("contextIsolation: true");
    expect(mainSource).toContain("nodeIntegration: false");
    expect(mainSource).toContain("sandbox: true");
    expect(mainSource).not.toMatch(/omniroute/i);
    expect(preloadSource).toContain('exposeInMainWorld("polyQuotaElectronService"');
    expect(preloadSource).not.toContain('exposeInMainWorld("llmUsage"');
  });

  it("provides tray, proxy-aware networking, notifications, and recoverable data reset", () => {
    expect(mainSource).toContain("new Tray");
    expect(mainSource).toContain("setProgressBar");
    expect(mainSource).toContain("applyQuotaChrome");
    expect(mainSource).not.toContain("setOverlayIcon");
    expect(mainSource).toContain("trayIconFilename");
    expect(hostSource).toContain("options.session.fetch");
    expect(mainSource).toContain("configureSessionProxy");
    expect(hostSource).toContain("detectProxyStatus");
    expect(mainSource).toContain('mode: "system"');
    expect(mainSource).toContain('mode: "fixed_servers"');
    expect(proxyDetectionSource).toContain("env.HTTPS_PROXY?.trim()");
    expect(proxyDetectionSource).toContain('"ProxyEnable"');
    expect(proxyDetectionSource).toContain('"ProxyServer"');
    expect(proxyDetectionSource).toContain('"scutil"');
    expect(proxyDetectionSource).toContain('"gsettings"');
    expect(proxyDetectionSource).toContain('"unknown"');
    expect(proxyDetectionSource).not.toContain("resolveProxy");
    expect(mainSource).toContain("setWindowOpenHandler");
    expect(mainSource).toContain('url.startsWith("https://")');
    expect(mainSource).toContain("POLYQUOTA_RESET_DATA_OK");
    expect(mainSource).toContain("`${databaseFile}-wal`");
    expect(mainSource).toContain('"lib", "better-sqlite3", "better_sqlite3.node"');
    expect(mainSource).toContain("nativeBinding: sqliteNativeBindingPath()");
    expect(mainSource).toContain('const productAppUserModelId = "io.astraconductor.polyquota"');
    expect(mainSource).toContain("isWindowsNsisInstall");
    expect(mainSource).toContain('"Uninstall PolyQuota.exe"');
    expect(mainSource).toContain("app.setAppUserModelId(productAppUserModelId)");
    expect(mainSource).not.toContain("${productAppUserModelId}.dev");
    expect(mainSource).not.toContain("ensureWindowsTaskbarIdentity");
    expect(mainSource).not.toContain("writeShortcutLink");
    expect(mainSource).not.toContain("readShortcutLink");
    expect(mainSource).not.toContain("windowsProductShortcutPaths");
    expect(mainSource).not.toContain("readdirSync");
    expect(mainSource).toContain('app.setName("PolyQuota")');
    expect(mainSource).toContain('"AstraConductor", "PolyQuota"');
    expect(mainSource).toContain('const databaseName = "polyquota.db"');

    const pollingSource = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../src/platform/electron/notifications.ts",
      ),
      "utf8",
    );
    expect(pollingSource).toContain("new Notification");

    expect(preloadSource).toContain("startAuth");
    expect(preloadSource).toContain("cancelAuth");
    expect(preloadSource).toContain("redeemResetCredit");
    expect(preloadSource).toContain("polyQuotaIpcEvents.stateChanged");
    expect(preloadSource).toContain("ipcRenderer.removeListener");
    expect(preloadSource).not.toMatch(/accessToken|refreshToken|idToken|safeStorage/);
  });

  it("keeps executable code local while allowing external HTTPS presentation resources", () => {
    expect(securitySource).toContain("script-src ${scripts}");
    expect(mainSource).not.toContain("script-src 'self' https:");
    expect(securitySource).toContain("style-src 'self' 'unsafe-inline' https:");
    expect(securitySource).toContain("img-src 'self' data: https:");
    expect(securitySource).toContain("font-src 'self' data: https:");
    expect(mainSource).toContain("webSecurity: true");
  });

  it("rebuilds and gracefully restarts Electron without watching Core", () => {
    expect(developmentRunnerSource).toContain("watch(sourceRoot, { recursive: true }");
    expect(developmentRunnerSource).toContain('relativePath.endsWith(".ts")');
    expect(developmentRunnerSource).not.toContain('relativePath !== "preload.cjs"');
    expect(developmentRunnerSource).toContain('"build:main"');
    expect(developmentRunnerSource).toContain('type: "polyquota:dev-restart"');
    expect(developmentRunnerSource).not.toContain("packages/core");
    expect(mainSource).toContain("waitForIpcHandlersToDrain");
    expect(runtimeSource).toContain("stopAndDrain");
  });
});
