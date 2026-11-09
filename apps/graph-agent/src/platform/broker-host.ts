import path from "node:path";
import os from "node:os";
import { BROKER_DISTRIBUTION, WindowsBrokerHost } from "@astra-conductor/credentials/host/windows";

export function createGraphBrokerHost(
  directory: string,
  existingAuthorizationOnly = false,
): WindowsBrokerHost {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return new WindowsBrokerHost(
    path.join(local, "AstraCredentialBroker", "v1"),
    path.join(local, "AstraCredentialBroker", "downloads", "win-x64", BROKER_DISTRIBUTION.version),
    path.join(directory, "credential-sharing"),
    existingAuthorizationOnly,
  );
}
