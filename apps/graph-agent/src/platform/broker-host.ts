import path from "node:path";
import os from "node:os";
import { lstat, readFile } from "node:fs/promises";
import { id, object, parseJson, requireValue } from "@astra-conductor/credentials";
import { BROKER_DISTRIBUTION, WindowsBrokerHost } from "@astra-conductor/credentials/host/windows";

/** Web may reuse a granted identity; it cannot implicitly mint a new all-record grant. */
class ExistingGrantBrokerHost extends WindowsBrokerHost {
  constructor(
    home: string,
    packageDirectory: string,
    private readonly grants: string,
  ) {
    super(home, packageDirectory, grants);
  }
  override async connect(vault: string, clientId: string, instanceId: string) {
    const manifest = object(parseJson(await readFile(path.join(vault, "manifest.json"))));
    const filename = path.join(this.grants, `${id(manifest.vaultId)}.${id(clientId)}.dpapi`);
    let exists = false;
    try {
      exists = (await lstat(filename)).isFile();
    } catch {
      /* No implicit Web grant. */
    }
    requireValue(exists, "access-denied");
    return super.connect(vault, clientId, instanceId);
  }
}

export function createGraphBrokerHost(
  directory: string,
  existingAuthorizationOnly = false,
): WindowsBrokerHost {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const Host = existingAuthorizationOnly ? ExistingGrantBrokerHost : WindowsBrokerHost;
  return new Host(
    path.join(local, "AstraCredentialBroker", "v1"),
    path.join(local, "AstraCredentialBroker", "downloads", "win-x64", BROKER_DISTRIBUTION.version),
    path.join(directory, "credential-sharing"),
  );
}
