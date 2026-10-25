import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Session } from "electron";
import {
  CoreServices,
  serviceId,
  type LoggerPort,
  type ServiceRegistry,
} from "@astra-conductor/core/internal";
import { startOAuthCallbackServer } from "../../auth/callback-server.js";
import { detectProxyStatus } from "../../proxy-detection.js";
import { ElectronSafeStorageCipher } from "../../safe-storage-cipher.js";
import { SqliteStorage } from "../../sqlite-storage.js";
import { Services } from "../../runtime/register-common-services.js";
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
      CoreServices.storage,
      [dataOwner],
      (services) =>
        new SqliteStorage(path.join(services.get(dataOwner).directory, "polyquota.db"), {
          nativeBinding: options.nativeBinding,
        }),
      (storage) => (storage as SqliteStorage).close(),
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
