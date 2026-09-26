import { app, BrowserWindow, Menu, Tray, nativeImage, net, session, shell } from "electron";
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
} from "@llm-usage/core/internal";
import { AuthService } from "./auth-service.js";
import { registerIpcHandlers, unregisterIpcHandlers } from "./ipc.js";
import { PollingService } from "./polling-service.js";
import { ElectronSafeStorageCipher } from "./safe-storage-cipher.js";
import { SqliteStorage } from "./sqlite-storage.js";
import { runStorageSmoke } from "./storage-smoke.js";

const devServer = process.env.LLM_USAGE_DEV_SERVER;
const smoke = process.env.LLM_USAGE_SMOKE === "1";
const storageSmoke = process.env.LLM_USAGE_STORAGE_SMOKE === "1";
const resetData = process.env.LLM_USAGE_RESET_DATA === "1";
const codexCliSmoke = process.env.LLM_USAGE_CODEX_CLI_SMOKE === "1";
const userDataOverride = process.env.LLM_USAGE_USER_DATA;
let storage: SqliteStorage | null = null;
let polling: PollingService | null = null;
let auth: AuthService | null = null;
let tray: Tray | null = null;
let quitting = false;

if (userDataOverride) app.setPath("userData", path.resolve(userDataOverride));
if (process.platform === "win32") app.setAppUserModelId("local.llm-usage.app");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  if (resetData) {
    console.error("无法清除数据：llm-usage 仍在运行，请先退出应用");
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

function installProductionCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
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
    title: "llm-usage",
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
      console.log("LLM_USAGE_SMOKE_OK");
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
  const icon = nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," +
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#2563eb"/><path d="M8 22V10h4v8h4V6h4v12h4v4z" fill="white"/></svg>',
      ).toString("base64"),
  );
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("llm-usage");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 llm-usage", click: () => BrowserWindow.getAllWindows()[0]?.show() },
      { label: "刷新全部账号", click: () => void polling?.refreshAll() },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => BrowserWindow.getAllWindows()[0]?.show());
}

async function deleteStoredData(databaseFile: string): Promise<void> {
  for (const filename of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
    await rm(filename, { force: true });
  }
}

if (hasSingleInstanceLock) {
  app
    .whenReady()
    .then(async () => {
      const databaseFile = path.join(app.getPath("userData"), "llm-usage.db");
      if (resetData) {
        await deleteStoredData(databaseFile);
        console.log("LLM_USAGE_RESET_DATA_OK");
        app.quit();
        return;
      }
      if (storageSmoke) {
        await runStorageSmoke(databaseFile, sqliteNativeBindingPath());
        console.log("LLM_USAGE_STORAGE_SMOKE_OK");
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
          `LLM_USAGE_CODEX_CLI_SMOKE_OK account=${account.maskedIdentifier} plan=${outcome.snapshot.plan} quotas=${outcome.snapshot.groups
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
        "llm-usage startup failed",
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

app.on("before-quit", () => {
  quitting = true;
  unregisterIpcHandlers();
  auth?.cancelAll();
  polling?.stop();
  tray?.destroy();
  tray = null;
  storage?.close();
  storage = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "win32") app.quit();
});
