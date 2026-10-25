import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  AppError,
  CoreServices,
  serviceId,
  silentLogger,
  type CredentialCipherPort,
  type ServiceRegistry,
} from "@astra-conductor/core/internal";
import { SqliteStorage } from "../../sqlite-storage.js";
import { startOAuthCallbackServer } from "../../auth/callback-server.js";
import { Services } from "../../runtime/register-common-services.js";
import { acquireDataOwner } from "./data-owner.js";
import { NodeHttpService } from "./http-service.js";

const dataOwner = serviceId<ReturnType<typeof acquireDataOwner>>("node.data-owner");

const unavailableCipher: CredentialCipherPort = {
  unavailableReason: "Node credential backend is not configured",
  isAvailable: async () => false,
  encrypt: async () => {
    throw new AppError("secure-storage", "Node credential backend is not configured");
  },
  decrypt: async () => {
    throw new AppError("secure-storage", "Node credential backend is not configured");
  },
};

export function registerNodeServices(
  registry: ServiceRegistry,
  options: {
    dataDirectory: string;
    http: NodeHttpService;
    cipher?: CredentialCipherPort;
    credentialsAvailable?: boolean;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  },
): void {
  const env = options.env ?? process.env;
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
      (services) => new SqliteStorage(path.join(services.get(dataOwner).directory, "polyquota.db")),
      (storage) => (storage as SqliteStorage).close(),
    )
    .value(CoreServices.http, options.http, (http) => (http as NodeHttpService).dispose())
    .value(CoreServices.files, { readText: (filename) => readFile(filename, "utf8") })
    .value(CoreServices.environment, {
      homeDirectory: () => options.homeDirectory ?? homedir(),
      env: (name) => env[name],
    })
    .value(CoreServices.clock, { now: () => new Date() })
    .value(CoreServices.logger, silentLogger)
    .value(CoreServices.callbackServer, { start: startOAuthCallbackServer })
    .value(CoreServices.authorization, { present: async () => "awaiting-user" as const })
    .value(Services.cipher, options.cipher ?? unavailableCipher)
    .value(Services.host, {
      capabilities: {
        desktop: false,
        notifications: "browser",
        credentials: options.credentialsAvailable === true,
      },
      showWindow: () => {
        throw new AppError("service-unavailable", "Desktop is unavailable");
      },
    })
    .value(Services.proxyStatus, async () => {
      const address = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
      if (!address) return { proxyMode: "direct", proxyAddress: null };
      const url = new URL(address.includes("://") ? address : `http://${address}`);
      return {
        proxyMode: "environment",
        proxyAddress: `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`,
      };
    })
    .register(Services.notifications, [Services.browserNotifications], (services) =>
      services.get(Services.browserNotifications),
    );
}
