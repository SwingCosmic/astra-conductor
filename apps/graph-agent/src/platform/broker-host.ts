import path from "node:path";
import os from "node:os";
import {
  localBrokerPackageDirectory,
  WindowsBrokerHost,
} from "@astra-conductor/credentials/host/windows";

export function createGraphBrokerHost(
  directory: string,
  existingAuthorizationOnly = false,
  releaseFetch?: typeof fetch,
): WindowsBrokerHost {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return new WindowsBrokerHost(
    path.join(local, "AstraCredentialBroker", "v1"),
    localBrokerPackageDirectory(path.join(local, "AstraCredentialBroker")),
    path.join(directory, "credential-sharing"),
    existingAuthorizationOnly,
    releaseFetch,
  );
}
