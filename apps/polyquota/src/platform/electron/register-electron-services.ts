import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { BrowserWindow, dialog, type Session } from "electron";
import {
  CoreServices,
  SelectedBusinessStorage,
  serviceId,
  type LoggerPort,
  type ServiceRegistry,
} from "@astra-conductor/core/internal";
import { startOAuthCallbackServer } from "../common/auth/callback-server.js";
import { detectProxyStatus } from "../common/proxy-detection.js";
import { ElectronSafeStorageCipher } from "./safe-storage-cipher.js";
import { SqliteStorage } from "../common/sqlite-storage.js";
import { Services } from "../../server/runtime/register-common-services.js";
import { acquireDataOwner } from "../node/data-owner.js";
import { ElectronSystemNotificationPort } from "./notifications.js";

const dataOwner = serviceId<ReturnType<typeof acquireDataOwner>>("electron.data-owner");

export function registerElectronServices(
  registry: ServiceRegistry,
  options: {
    dataDirectory: string;
    nativeBinding: string;
    session: Session;
    signal: AbortSignal;
    logger: LoggerPort;
    credentialsAvailable: boolean;
    openExternal(url: string): Promise<void>;
    showWindow(): void;
  },
): void {
  registry
    .register(
      dataOwner,
      [],
      () => acquireDataOwner(options.dataDirectory),
      (owner) => owner.dispose(),
    )
    .register(
      Services.businessStorage,
      [dataOwner],
      (services) => {
        const directory = services.get(dataOwner).directory;
        const open = (name: string) =>
          new SqliteStorage(path.join(directory, name), { nativeBinding: options.nativeBinding });
        return new SelectedBusinessStorage(open("polyquota.db"), (identity) =>
          open(`shared-business.${identity}.db`),
        );
      },
      (storage) => storage.close(),
    )
    .value(CoreServices.http, {
      fetch: (input, init) =>
        options.session.fetch(input instanceof URL ? input.toString() : input, {
          ...init,
          signal: AbortSignal.any([
            options.signal,
            AbortSignal.timeout(30_000),
            ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : []),
          ]),
        }),
    })
    .value(CoreServices.files, { readText: (filename) => readFile(filename, "utf8") })
    .value(CoreServices.environment, { homeDirectory: homedir, env: (name) => process.env[name] })
    .value(CoreServices.clock, { now: () => new Date() })
    .value(CoreServices.logger, options.logger)
    .value(CoreServices.callbackServer, { start: startOAuthCallbackServer })
    .value(CoreServices.authorization, {
      present: async ({ url }) => {
        await options.openExternal(url);
        return "opened" as const;
      },
    })
    .value(Services.sharingPaths, {
      dataDirectory: options.dataDirectory,
      selectDirectory: async () => {
        const parent = BrowserWindow.getFocusedWindow();
        const config = {
          title: "选择共享凭据目录",
          buttonLabel: "选择此文件夹",
          properties: ["openDirectory", "createDirectory", "dontAddToRecent"] as (
            | "openDirectory"
            | "createDirectory"
            | "dontAddToRecent"
          )[],
        };
        const result = parent
          ? await dialog.showOpenDialog(parent, config)
          : await dialog.showOpenDialog(config);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
    })
    .value(Services.cipher, new ElectronSafeStorageCipher())
    .value(Services.host, {
      capabilities: {
        desktop: true,
        notifications: "host",
        credentials: options.credentialsAvailable,
      },
      showWindow: options.showWindow,
    })
    .value(Services.proxyStatus, () => detectProxyStatus())
    .value(Services.notifications, new ElectronSystemNotificationPort());
}
