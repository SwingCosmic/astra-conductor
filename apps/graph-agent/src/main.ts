import { app, BrowserWindow, dialog, ipcMain, net, safeStorage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerError, object, requireValue, text } from "@astra-conductor/credentials";
import { BROKER_DISTRIBUTION, WindowsBrokerHost } from "@astra-conductor/credential-host";
import { GraphSharingService } from "./import-service.js";
import { GraphCredentialRuntime } from "./runtime.js";

app.setName("GraphAgent");
if (process.platform === "win32") app.setAppUserModelId("com.astraconductor.graphagent");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow | undefined;
  let sharing: GraphSharingService | undefined;
  let runtime: GraphCredentialRuntime | undefined;
  let closing = false;
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      const directory = path.join(app.getPath("userData"), "credential-sharing");
      const local = process.env.LOCALAPPDATA ?? path.join(app.getPath("home"), "AppData", "Local");
      const host = new WindowsBrokerHost(
        path.join(local, "AstraCredentialBroker", "v1"),
        path.join(
          local,
          "AstraCredentialBroker",
          "downloads",
          "win-x64",
          BROKER_DISTRIBUTION.version,
        ),
        directory,
      );
      runtime = new GraphCredentialRuntime(host, {
        fetch: (input, init) => net.fetch(input instanceof Request ? input : String(input), init),
      });
      sharing = new GraphSharingService({
        host,
        directory,
        cipher: {
          isAvailable: async () => safeStorage.isEncryptionAvailable(),
          encrypt: async (plaintext) => {
            requireValue(safeStorage.isEncryptionAvailable(), "secure-storage-unavailable");
            return safeStorage.encryptString(plaintext);
          },
          decrypt: async (ciphertext) => {
            requireValue(safeStorage.isEncryptionAvailable(), "secure-storage-unavailable");
            return {
              plaintext: safeStorage.decryptString(Buffer.from(ciphertext)),
              shouldReEncrypt: false,
            };
          },
        },
        selectDirectory: async () => {
          const selected = await dialog.showOpenDialog({
            title: "选择 PolyQuota 导出的共享目录",
            properties: ["openDirectory"],
          });
          return selected.canceled ? null : (selected.filePaths[0] ?? null);
        },
        canRefresh: (provider) => runtime!.canRefresh(provider),
        activate: (binding, changed) => runtime!.activate(binding, changed),
        accounts: () => runtime!.accounts(),
        refresh: (accountId) => runtime!.refresh(accountId),
        deactivate: () => runtime!.deactivate(),
      });
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      const entry = path.join(root, "renderer", "index.html");
      window = new BrowserWindow({
        width: 1120,
        height: 790,
        minWidth: 820,
        minHeight: 600,
        title: "GraphAgent",
        icon: path.join(root, "assets", "icons", "graphagent.ico"),
        backgroundColor: "#f6f7fa",
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(root, "dist", "preload.cjs"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      ipcMain.handle("graph-agent:sharing", async (event, method: unknown, input: unknown) => {
        try {
          requireValue(
            event.sender === window?.webContents &&
              event.senderFrame === window.webContents.mainFrame,
            "invalid-ipc-source",
          );
          requireValue(typeof method === "string", "invalid-request");
          let value: unknown;
          switch (method) {
            case "status":
              value = await sharing!.status();
              break;
            case "selectDirectory":
              value = await sharing!.selectDirectory();
              break;
            case "install":
              value = await sharing!.install();
              break;
            case "uninstall":
              value = await sharing!.uninstall();
              break;
            case "verifyImport": {
              const request = object(input, ["vaultDirectory", "migrationKey"]);
              value = await sharing!.verifyImport({
                vaultDirectory: text(request.vaultDirectory),
                migrationKey: text(request.migrationKey),
              });
              break;
            }
            case "confirmImport":
              value = await sharing!.confirmImport(text(input));
              break;
            case "cancelPreview":
              value = await sharing!.cancelPreview();
              break;
            case "retry":
              value = await sharing!.retry();
              break;
            case "refresh":
              value = await sharing!.refresh(text(input));
              break;
            default:
              throw new BrokerError("method-not-found");
          }
          return { ok: true, value };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof BrokerError ? error.code : "operation-failed",
          };
        }
      });
      await window.loadFile(entry);
      await sharing.restore();
    })
    .catch(() => {
      dialog.showErrorBox("GraphAgent", "应用启动失败，请检查本机组件与安全存储后重试。");
      app.exit(1);
    });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    void (async () => {
      await sharing?.dispose();
      await runtime?.dispose();
      app.quit();
    })();
  });
}
