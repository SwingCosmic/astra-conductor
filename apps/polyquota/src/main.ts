import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  net,
  session,
  shell,
  type NativeImage,
} from "electron";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodexAccountProvisioner,
  CodexAdapter,
  CredentialVault,
  GlmAccountProvisioner,
  GlmAdapter,
  RefreshCoordinator,
} from "@astra-conductor/core/internal";
import { AuthService } from "./auth-service.js";
import { registerIpcHandlers, unregisterIpcHandlers, waitForIpcHandlersToDrain } from "./ipc.js";
import { PollingService } from "./polling-service.js";
import { ElectronSafeStorageCipher } from "./safe-storage-cipher.js";
import { SqliteStorage } from "./sqlite-storage.js";
import { runStorageSmoke } from "./storage-smoke.js";

const devServer = process.env.POLYQUOTA_DEV_SERVER;
const smoke = process.env.POLYQUOTA_SMOKE === "1";
const storageSmoke = process.env.POLYQUOTA_STORAGE_SMOKE === "1";
const resetData = process.env.POLYQUOTA_RESET_DATA === "1";
const codexCliSmoke = process.env.POLYQUOTA_CODEX_CLI_SMOKE === "1";
const userDataOverride = process.env.POLYQUOTA_USER_DATA;
const productUserData = path.join(app.getPath("appData"), "AstraConductor", "PolyQuota");
const databaseName = "polyquota.db";
let storage: SqliteStorage | null = null;
let polling: PollingService | null = null;
let auth: AuthService | null = null;
let tray: Tray | null = null;
let quitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;

app.setName("PolyQuota");
app.setPath("userData", userDataOverride ? path.resolve(userDataOverride) : productUserData);
if (process.platform === "win32") app.setAppUserModelId("io.astraconductor.polyquota");

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

function loadTrayIcon(): NativeImage {
  const icon = loadProductIcon("tray-16.png");
  const highDpi = loadProductIcon("tray-32.png");
  icon.addRepresentation({ scaleFactor: 2, dataURL: highDpi.toDataURL() });
  return icon;
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

async function configureNetworkProxy(): Promise<void> {
  const raw = process.env.HTTPS_PROXY?.trim() || process.env.HTTP_PROXY?.trim();
  if (!raw) {
    await session.defaultSession.setProxy({ mode: "system" });
    return;
  }
  const proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (!new Set(["http:", "https:", "socks:", "socks4:", "socks5:"]).has(proxy.protocol)) {
    throw new Error("Unsupported HTTP_PROXY or HTTPS_PROXY scheme");
  }
  const rule = `${proxy.protocol}//${proxy.hostname}${proxy.port ? `:${proxy.port}` : ""}`;
  const environmentBypass = process.env.NO_PROXY?.trim().replaceAll(",", ";");
  await session.defaultSession.setProxy({
    mode: "fixed_servers",
    proxyRules: rule,
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
    icon: loadProductIcon("polyquota.png"),
    webPreferences: {
      preload: path.join(appDir(), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  win.on("close", (event) => {
    if (!quitting && !smoke) {
      event.preventDefault();
      win.hide();
    }
  });

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

  win.webContents.on("did-finish-load", () => {
    if (smoke) {
      console.log("POLYQUOTA_SMOKE_OK");
      setTimeout(() => app.quit(), 250);
    }
  });

  if (devServer) {
    await win.loadURL(devServer);
    return;
  }

  await win.loadFile(path.join(appDir(), "../renderer/index.html"));
}

function createTray(): void {
  tray = new Tray(loadTrayIcon());
  tray.setToolTip("PolyQuota");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 PolyQuota", click: () => BrowserWindow.getAllWindows()[0]?.show() },
      { label: "刷新全部账号", click: () => void polling?.refreshAll() },
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
  unregisterIpcHandlers();
  auth?.cancelAll();
  polling?.stop();
  tray?.destroy();
  tray = null;
  await Promise.all([waitForIpcHandlersToDrain(), polling?.stopAndDrain()]);
  polling = null;
  storage?.close();
  storage = null;
  auth = null;
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
      await configureNetworkProxy();
      storage = new SqliteStorage(databaseFile, { nativeBinding: sqliteNativeBindingPath() });
      const vault = new CredentialVault(storage, new ElectronSafeStorageCipher());
      const fetchImpl: typeof fetch = (input, init) =>
        net.fetch(input instanceof URL ? input.toString() : input, init);
      const adapter = new CodexAdapter(fetchImpl);
      const glmAdapter = new GlmAdapter(fetchImpl);
      const coordinator = new RefreshCoordinator(storage, vault, [adapter, glmAdapter]);
      const provisioner = new CodexAccountProvisioner(storage, vault);
      const glmProvisioner = new GlmAccountProvisioner(storage, vault);
      auth = new AuthService(
        adapter,
        provisioner,
        (url) => shell.openExternal(url),
        glmAdapter,
        glmProvisioner,
      );
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
      registerIpcHandlers(storage, vault, polling, auth, () =>
        session.defaultSession.resolveProxy("https://chatgpt.com/backend-api/wham/usage"),
      );
      polling.start();
      if (!devServer) installProductionCsp();
      await createWindow();
      createTray();
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
