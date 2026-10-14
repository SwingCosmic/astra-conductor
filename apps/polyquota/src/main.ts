import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  net,
  powerMonitor,
  session,
  shell,
  type NativeImage,
} from "electron";
import { polyQuotaIpcEvents } from "@astra-conductor/polyquota-contract";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthCoordinator,
  CredentialVault,
  ProviderRegistry,
  RefreshCoordinator,
  createProviderContributions,
  type LoggerPort,
} from "@astra-conductor/core/internal";
import { startOAuthCallbackServer } from "./auth/callback-server.js";
import { registerIpcHandlers, unregisterIpcHandlers, waitForIpcHandlersToDrain } from "./ipc.js";
import { PollingService } from "./polling-service.js";
import { PolyQuotaApplicationService } from "./polyquota-application-service.js";
import { detectProxyStatus, envProxyAddress } from "./proxy-detection.js";
import { taskbarProgress, trayIconFilename, trayTooltip } from "./quota-chrome.js";
import { RefreshScheduler } from "./refresh-scheduler.js";
import { ElectronSafeStorageCipher } from "./safe-storage-cipher.js";
import { SqliteStorage } from "./sqlite-storage.js";
import { runStorageSmoke } from "./storage-smoke.js";

const devServer = process.env.POLYQUOTA_DEV_SERVER;
const smoke = process.env.POLYQUOTA_SMOKE === "1";
const ipcSmoke = process.env.POLYQUOTA_IPC_SMOKE === "1";
const storageSmoke = process.env.POLYQUOTA_STORAGE_SMOKE === "1";
const resetData = process.env.POLYQUOTA_RESET_DATA === "1";
const codexCliSmoke = process.env.POLYQUOTA_CODEX_CLI_SMOKE === "1";
const userDataOverride = process.env.POLYQUOTA_USER_DATA;
const productUserData = path.join(app.getPath("appData"), "AstraConductor", "PolyQuota");
const databaseName = "polyquota.db";
const productAppUserModelId = "io.astraconductor.polyquota";
let storage: SqliteStorage | null = null;
let polling: PollingService | null = null;
let polyQuotaService: PolyQuotaApplicationService | null = null;
let refreshScheduler: RefreshScheduler | null = null;
let auth: AuthCoordinator | null = null;
let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;

function isWindowsNsisInstall(): boolean {
  return (
    process.platform === "win32" &&
    app.isPackaged &&
    existsSync(path.join(path.dirname(process.execPath), "Uninstall PolyQuota.exe"))
  );
}

app.setName("PolyQuota");
app.setPath("userData", userDataOverride ? path.resolve(userDataOverride) : productUserData);
if (isWindowsNsisInstall()) {
  app.setAppUserModelId(productAppUserModelId);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  if (resetData) {
    console.error("无法清除数据：PolyQuota 仍在运行，请先退出应用");
    app.exit(2);
  } else {
    app.quit();
  }
}

function appDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** 主进程统一控制台日志：协调器的失败原因在此可见，便于真实账号排查。 */
const mainLogger: LoggerPort = {
  info: (message, context) => console.info("PolyQuota", message, context ?? {}),
  error: (message, context) => console.error("PolyQuota", message, context ?? {}),
};

function sqliteNativeBindingPath(): string {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return path.join(root, "lib", "better-sqlite3", "better_sqlite3.node");
}

function iconResourcePath(filename: string): string {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, "icons")
    : path.join(app.getAppPath(), "assets", "icons");
  return path.join(root, filename);
}

function loadProductIcon(filename: string, fallback = "polyquota.png"): NativeImage {
  for (const candidate of new Set([filename, fallback])) {
    const icon = nativeImage.createFromPath(iconResourcePath(candidate));
    if (!icon.isEmpty()) return icon;
  }
  throw new Error(`Unable to load PolyQuota icon: ${filename}`);
}

function loadTrayStatusIcon(filename: string): NativeImage {
  for (const candidate of [filename, "tray-unknown-24.png", "tray-24.png", "polyquota.png"]) {
    const icon = nativeImage.createFromPath(iconResourcePath(candidate));
    if (!icon.isEmpty()) return icon;
  }
  throw new Error(`Unable to load PolyQuota tray icon: ${filename}`);
}

function windowOnTaskbar(): boolean {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return false;
  return win.isVisible() || win.isMinimized();
}

function applyTaskbarProgress(
  remaining: Parameters<typeof taskbarProgress>[0],
  enabled: boolean,
): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const mapped = taskbarProgress(remaining, { enabled, windowOnTaskbar: windowOnTaskbar() });
  if (!mapped) {
    win.setProgressBar(-1);
    return;
  }
  win.setProgressBar(mapped.progress, { mode: mapped.mode });
}

function applyQuotaChrome(): void {
  if (!polyQuotaService || quitting) return;
  void polyQuotaService
    .getSnapshot()
    .then((snapshot) => {
      if (quitting) return;
      const remaining = snapshot.compositeRemaining;
      if (tray) {
        tray.setImage(loadTrayStatusIcon(trayIconFilename(remaining)));
        tray.setToolTip(trayTooltip(remaining));
      }
      applyTaskbarProgress(remaining, snapshot.settings.taskbarProgressEnabled);
    })
    .catch((error: unknown) => {
      console.error(
        "PolyQuota quota chrome failed",
        error instanceof Error ? error.message : "unknown error",
      );
    });
}

function installProductionCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self'",
        ],
      },
    });
  });
}

/**
 * 启动时仅按环境变量决定会话代理；没有环境变量则让 Chromium 遵循系统设置。
 * 不读取系统配置、不做检测——设置页"当前代理"的检测结论由 proxy-detection
 * 在被查询时按需得出。
 */
async function configureSessionProxy(): Promise<void> {
  const address = envProxyAddress(process.env);
  if (!address) {
    await session.defaultSession.setProxy({ mode: "system" });
    return;
  }
  const environmentBypass = process.env.NO_PROXY?.trim().replaceAll(",", ";");
  await session.defaultSession.setProxy({
    mode: "fixed_servers",
    proxyRules: address,
    proxyBypassRules: ["<local>", "localhost", "127.0.0.1", environmentBypass]
      .filter(Boolean)
      .join(";"),
  });
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: "#f3f4f6",
    title: "PolyQuota",
    icon: loadProductIcon(process.platform === "win32" ? "polyquota.ico" : "polyquota.png"),
    webPreferences: {
      preload: path.join(appDir(), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = win;

  win.once("ready-to-show", () => {
    win.show();
  });

  win.on("close", (event) => {
    if (!quitting && !smoke && !ipcSmoke) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.on("show", () => applyQuotaChrome());
  win.on("hide", () => applyQuotaChrome());
  win.on("minimize", () => applyQuotaChrome());
  win.on("restore", () => applyQuotaChrome());

  win.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`renderer failed: ${code} ${description}`);
    if (smoke) {
      app.exit(1);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-finish-load", async () => {
    if (smoke) {
      console.log("POLYQUOTA_SMOKE_OK");
      setTimeout(() => app.quit(), 250);
      return;
    }
    if (ipcSmoke) {
      try {
        const result = (await win.webContents.executeJavaScript(`
          (async () => {
            const service = window.polyQuotaElectronService;
            if (!service) throw new Error("missing-service");
            const initialResult = await service.getSnapshot();
            if (!initialResult.ok) throw new Error(initialResult.error.code);
            const invalidResult = await service.deleteAccount("../invalid-account");
            if (invalidResult.ok || invalidResult.error.code !== "validation") {
              throw new Error("invalid-input-not-rejected");
            }
            const initial = initialResult.value;
            let timeout;
            const eventPromise = new Promise((resolve, reject) => {
              timeout = setTimeout(() => reject(new Error("event-timeout")), 5000);
              const dispose = service.subscribe((event) => {
                if (event.revision <= initial.revision) return;
                clearTimeout(timeout);
                dispose();
                resolve(event);
              });
            });
            const changedSettings = {
              ...initial.settings,
              pollingEnabled: !initial.settings.pollingEnabled,
            };
            const saveResult = await service.saveSettings(changedSettings);
            if (!saveResult.ok) throw new Error(saveResult.error.code);
            const event = await eventPromise;
            const changedResult = await service.getSnapshot();
            if (!changedResult.ok) throw new Error(changedResult.error.code);
            if (changedResult.value.revision < event.revision) throw new Error("stale-snapshot");
            if (changedResult.value.settings.pollingEnabled !== changedSettings.pollingEnabled) {
              throw new Error("settings-not-applied");
            }
            const restoreResult = await service.saveSettings(initial.settings);
            if (!restoreResult.ok) throw new Error(restoreResult.error.code);
            return { revision: changedResult.value.revision, reasons: event.reasons };
          })()
        `)) as { revision: number; reasons: string[] };
        console.log(
          `POLYQUOTA_IPC_SMOKE_OK revision=${result.revision} reasons=${result.reasons.join(",")}`,
        );
        app.quit();
      } catch (error) {
        console.error(
          "POLYQUOTA_IPC_SMOKE_FAILED",
          error instanceof Error ? error.message : "unknown error",
        );
        app.exit(1);
      }
    }
  });

  if (devServer) {
    await win.loadURL(devServer);
    return;
  }

  await win.loadFile(path.join(appDir(), "../renderer/index.html"));
}

function createTray(): void {
  tray = new Tray(loadTrayStatusIcon("tray-unknown-24.png"));
  tray.setToolTip("PolyQuota");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 PolyQuota", click: () => BrowserWindow.getAllWindows()[0]?.show() },
      {
        label: "刷新全部账号",
        click: () => void polyQuotaService?.refreshAll("tray"),
      },
      { type: "separator" },
      {
        label: "退出",
        click: requestGracefulQuit,
      },
    ]),
  );
  tray.on("double-click", () => BrowserWindow.getAllWindows()[0]?.show());
}

function requestGracefulQuit(): void {
  quitting = true;
  app.quit();
}

async function shutdownServices(): Promise<void> {
  mainWindow?.destroy();
  mainWindow = null;
  unregisterIpcHandlers();
  auth?.cancelAll();
  powerMonitor.removeListener("resume", handleSystemResume);
  tray?.destroy();
  tray = null;
  polyQuotaService?.dispose();
  await Promise.all([
    waitForIpcHandlersToDrain(),
    refreshScheduler?.stopAndDrain(),
    polling?.stopAndDrain(),
  ]);
  refreshScheduler = null;
  polyQuotaService = null;
  polling = null;
  storage?.close();
  storage = null;
  auth = null;
}

function handleSystemResume(): void {
  refreshScheduler?.resume();
}

process.on("message", (message: unknown) => {
  if (
    !app.isPackaged &&
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "polyquota:dev-restart"
  ) {
    requestGracefulQuit();
  }
});

async function deleteStoredData(databaseFile: string): Promise<void> {
  for (const filename of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
    await rm(filename, { force: true });
  }
}

if (hasSingleInstanceLock) {
  app
    .whenReady()
    .then(async () => {
      const databaseFile = path.join(app.getPath("userData"), databaseName);
      if (resetData) {
        await deleteStoredData(databaseFile);
        console.log("POLYQUOTA_RESET_DATA_OK");
        app.quit();
        return;
      }
      if (storageSmoke) {
        await runStorageSmoke(databaseFile, sqliteNativeBindingPath());
        console.log("POLYQUOTA_STORAGE_SMOKE_OK");
        app.quit();
        return;
      }
      await configureSessionProxy();
      storage = new SqliteStorage(databaseFile, { nativeBinding: sqliteNativeBindingPath() });
      const vault = new CredentialVault(storage, new ElectronSafeStorageCipher());
      const fetchImpl: typeof fetch = (input, init) =>
        net.fetch(input instanceof URL ? input.toString() : input, init);
      // 组合根只创建宿主端口：供应商的组合细节全部收在 core 组合工厂，新增
      // 供应商时这里零修改（阶段 B，§8.1）。
      const providerRegistry = new ProviderRegistry(
        createProviderContributions({
          http: { fetch: fetchImpl },
          browser: { openExternal: (url) => shell.openExternal(url) },
          callbackServer: { start: startOAuthCallbackServer },
          storage,
          vault,
        }),
      );
      const coordinator = new RefreshCoordinator(
        storage,
        vault,
        providerRegistry,
        undefined,
        mainLogger,
      );
      auth = new AuthCoordinator(providerRegistry, mainLogger);
      polling = new PollingService(storage, coordinator);
      if (codexCliSmoke) {
        const authResult = await auth.start("codex", "cli-import");
        if (authResult.status !== "completed") throw new Error("Codex CLI import did not complete");
        const account = authResult.account;
        const outcome = await polling.refresh(account.id);
        if (outcome.status !== "updated") throw new Error("Codex CLI live refresh failed");
        console.log(
          `POLYQUOTA_CODEX_CLI_SMOKE_OK account=${account.maskedIdentifier} plan=${outcome.snapshot.plan} quotas=${outcome.snapshot.groups
            .flatMap((group) => group.quotas)
            .map((quota) => quota.key)
            .join(",")}`,
        );
        app.quit();
        return;
      }
      polyQuotaService = new PolyQuotaApplicationService(storage, vault, polling, auth, {
        registry: providerRegistry,
        detectProxyStatus: () => detectProxyStatus(),
        publishChanged: (event) => {
          if (quitting) return;
          const webContents = mainWindow?.webContents;
          if (webContents && !webContents.isDestroyed()) {
            webContents.send(polyQuotaIpcEvents.stateChanged, event);
          }
          applyQuotaChrome();
        },
      });
      refreshScheduler = new RefreshScheduler(
        (source) => polyQuotaService!.executeRefreshBatch(source),
        () => polyQuotaService?.schedulerChanged(),
      );
      polyQuotaService.attachScheduler(refreshScheduler);
      registerIpcHandlers(polyQuotaService);
      refreshScheduler.start(polyQuotaService.getSettings());
      powerMonitor.on("resume", handleSystemResume);
      if (!devServer) installProductionCsp();
      await createWindow();
      createTray();
      applyQuotaChrome();
    })
    .catch((error: unknown) => {
      console.error(
        "PolyQuota startup failed",
        error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
      );
      app.exit(1);
    });

  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
}

app.on("before-quit", (event) => {
  quitting = true;
  if (shutdownComplete) return;
  event.preventDefault();
  if (!shutdownPromise) {
    shutdownPromise = shutdownServices()
      .catch((error: unknown) => {
        console.error(
          "PolyQuota shutdown failed",
          error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
        );
      })
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "win32") app.quit();
});
