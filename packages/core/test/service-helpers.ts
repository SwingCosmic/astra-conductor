import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  CoreServices,
  ServiceRegistry,
  type ClockPort,
  type CredentialVault,
  type HttpPort,
  type StoragePort,
  type StartOAuthCallbackServer,
} from "../src/internal.js";

export function httpServices(
  http: typeof fetch,
  clock: ClockPort = { now: () => new Date() },
): ServiceRegistry {
  return new ServiceRegistry()
    .value(CoreServices.http, { fetch: http })
    .value(CoreServices.clock, clock);
}

export function providerServices(options: {
  http: HttpPort;
  storage: StoragePort;
  vault: CredentialVault;
  callbackServer: { start: StartOAuthCallbackServer };
  clock?: ClockPort;
}): ServiceRegistry {
  return httpServices(options.http.fetch, options.clock)
    .value(CoreServices.storage, options.storage)
    .value(CoreServices.vault, options.vault)
    .value(CoreServices.callbackServer, options.callbackServer)
    .value(CoreServices.files, { readText: (filename) => readFile(filename, "utf8") })
    .value(CoreServices.environment, { homeDirectory: homedir, env: (name) => process.env[name] });
}
