import { app, BrowserWindow, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAdapter, CredentialVault, RefreshCoordinator } from "@llm-usage/core/internal";
import { registerIpcHandlers, unregisterIpcHandlers } from "./ipc.js";
import { ElectronSafeStorageCipher } from "./safe-storage-cipher.js";
import { SqliteStorage } from "./sqlite-storage.js";
import { runStorageSmoke } from "./storage-smoke.js";

const devServer = process.env.LLM_USAGE_DEV_SERVER;
const smoke = process.env.LLM_USAGE_SMOKE === "1";
const storageSmoke = process.env.LLM_USAGE_STORAGE_SMOKE === "1";
const userDataOverride = process.env.LLM_USAGE_USER_DATA;
let storage: SqliteStorage | null = null;

if (userDataOverride) app.setPath("userData", path.resolve(userDataOverride));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function appDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
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

  win.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`renderer failed: ${code} ${description}`);
    if (smoke) {
      app.exit(1);
    }
  });

  win.webContents.on("did-finish-load", () => {
    if (smoke) {
      console.log("LLM_USAGE_SMOKE_OK");
      app.quit();
    }
  });

  if (devServer) {
    await win.loadURL(devServer);
    return;
  }

  await win.loadFile(path.join(appDir(), "../renderer/index.html"));
}

if (hasSingleInstanceLock) {
  app
    .whenReady()
    .then(async () => {
      const databaseFile = path.join(app.getPath("userData"), "llm-usage.db");
      if (storageSmoke) {
        await runStorageSmoke(databaseFile);
        console.log("LLM_USAGE_STORAGE_SMOKE_OK");
        app.quit();
        return;
      }
      storage = new SqliteStorage(databaseFile);
      const vault = new CredentialVault(storage, new ElectronSafeStorageCipher());
      const coordinator = new RefreshCoordinator(storage, vault, new CodexAdapter());
      registerIpcHandlers(storage, coordinator);
      if (!devServer) installProductionCsp();
      await createWindow();
    })
    .catch(() => {
      console.error("llm-usage startup failed");
      app.exit(1);
    });

  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
}

app.on("before-quit", () => {
  unregisterIpcHandlers();
  storage?.close();
  storage = null;
});

app.on("window-all-closed", () => {
  app.quit();
});
