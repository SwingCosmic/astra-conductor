import { app, BrowserWindow, dialog, net, protocol, safeStorage, shell } from "electron";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AppError, MigrationProfileUpgradeRequired } from "@astra-conductor/core/internal";
import { createGraphServices, type GraphServices } from "../../server/services.js";
import { createGraphHonoApp } from "../../server/create-hono-app.js";
import { claimGraphProfile } from "../storage.js";
import { createGraphBrokerHost } from "../broker-host.js";
import { startOAuthCallbackServer } from "../callback-server.js";
import { graphUiResource } from "../resources.js";

const scheme = "graph-agent-app";
const origin = `${scheme}://app`;
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
app.setName("GraphAgent");
if (process.env.GRAPH_AGENT_USER_DATA)
  app.setPath("userData", path.resolve(process.env.GRAPH_AGENT_USER_DATA));
if (process.platform === "win32") app.setAppUserModelId("com.astraconductor.graphagent");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow | undefined;
  let services: GraphServices | undefined;
  let release: (() => void) | undefined;
  let closing = false;
  const requests = new AbortController();
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      const directory = app.getPath("userData");
      release = claimGraphProfile(directory);
      const requireCipher = () => {
        if (!safeStorage.isEncryptionAvailable())
          throw new AppError("secure-storage", "系统安全存储不可用");
      };
      services = await createGraphServices({
        directory,
        host: createGraphBrokerHost(directory),
        http: {
          fetch: (input, init) => net.fetch(input instanceof Request ? input : String(input), init),
        },
        cipher: {
          isAvailable: async () => safeStorage.isEncryptionAvailable(),
          encrypt: async (plaintext) => {
            requireCipher();
            return safeStorage.encryptString(plaintext);
          },
          decrypt: async (ciphertext) => {
            requireCipher();
            return {
              plaintext: safeStorage.decryptString(Buffer.from(ciphertext)),
              shouldReEncrypt: false,
            };
          },
        },
        files: { readText: (filename) => readFile(filename, "utf8") },
        callbackServer: { start: startOAuthCallbackServer },
        authorization: {
          present: async ({ url }) => {
            if (new URL(url).protocol !== "https:")
              throw new AppError("validation", "授权地址必须使用 HTTPS");
            await shell.openExternal(url);
            return "opened";
          },
        },
        selectDirectory: async () => {
          const selected = await dialog.showOpenDialog({
            title: "选择共享凭据目录",
            properties: ["openDirectory"],
          });
          return selected.canceled ? null : (selected.filePaths[0] ?? null);
        },
      });
      const hono = createGraphHonoApp(services);
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
      protocol.handle(scheme, (request) => {
        const url = new URL(request.url);
        const source = request.headers.get("origin");
        if (
          url.protocol !== `${scheme}:` ||
          url.host !== "app" ||
          url.username ||
          url.password ||
          (source !== null && source !== origin)
        )
          return new Response(null, { status: 403 });
        const scoped = new Request(request, {
          signal: AbortSignal.any([request.signal, requests.signal]),
        });
        if (url.pathname.startsWith("/api/")) return hono.fetch(scoped);
        return graphUiResource(path.join(root, "ui/dist"), url.pathname);
      });
      window = new BrowserWindow({
        width: 1180,
        height: 830,
        minWidth: 820,
        minHeight: 600,
        title: "GraphAgent",
        icon: path.join(root, "assets/icons/graphagent.ico"),
        backgroundColor: "#f6f7fa",
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (new URL(url).protocol === "https:") void shell.openExternal(url);
        return { action: "deny" };
      });
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      await window.loadURL(`${origin}/`);
    })
    .catch(async (error: unknown) => {
      await services?.stop();
      release?.();
      release = undefined;
      dialog.showErrorBox(
        "GraphAgent",
        error instanceof MigrationProfileUpgradeRequired
          ? error.message
          : "应用启动失败，请检查本机组件、数据目录与安全存储后重试。",
      );
      app.exit(1);
    });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    requests.abort();
    void (async () => {
      await services?.stop();
      release?.();
      app.quit();
    })();
  });
}
