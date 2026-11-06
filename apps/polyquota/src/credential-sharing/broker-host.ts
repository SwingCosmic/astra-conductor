import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  BrokerClient,
  BrokerError,
  id,
  object,
  parseJson,
  requireValue,
  text,
  type BrokerIdentity,
} from "@astra-conductor/credentials";
import type { CredentialSharingStatus } from "@astra-conductor/polyquota-contract";

export interface BrokerConnection {
  call(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}
export interface BrokerHost {
  localPackageDirectory: string;
  inspect(): Promise<
    Pick<CredentialSharingStatus, "installState" | "installedVersion" | "installationDirectory">
  >;
  status?(vault: string): Promise<{ serviceState: string; brokerOwnership: string }>;
  inspectPackage?(): Promise<CredentialSharingStatus["localPackageState"]>;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  connect(vault: string, clientId: string, instanceId: string): Promise<BrokerConnection>;
}
// Only documented, non-sensitive error codes may cross the native controller boundary.
const controllerErrors = new Set([
  "directory-permissions-too-broad",
  "directory-owner-mismatch",
  "file-permissions-too-broad",
  "file-owner-mismatch",
  "vault-not-registered",
  "vault-identity-mismatch",
  "service-maintenance",
  "lock-busy",
  "vault-directory-not-empty",
  "vault-already-running",
  "access-denied",
  "io-failure",
  "control-database-missing",
]);
/** Arguments never pass through a shell; stdin/stdout stay private to the backend. */
export function runPrivate(
  executable: string,
  args: string[],
  input = "",
  timeout = 90_000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let errorLength = 0;
    let length = 0;
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(new BrokerError("controller-timeout")), timeout);
    child.on("error", () => finish(new BrokerError("controller-unavailable")));
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 3 * 1024 * 1024) finish(new BrokerError("message-too-large"));
      else chunks.push(chunk);
    });
    // Never forward raw stderr, exception text, or unknown controller output.
    child.stderr.on("data", (chunk: Buffer) => {
      errorLength += chunk.length;
      if (errorLength <= 4096) errorChunks.push(chunk);
    });
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => {
      let errorCode = "controller-command-failed";
      if (code !== 0 && errorLength <= 4096) {
        try {
          const result = object(parseJson(Buffer.concat(errorChunks)), ["error"]);
          if (typeof result.error === "string" && controllerErrors.has(result.error))
            errorCode = result.error;
        } catch {
          /* Malformed or untrusted stderr stays private. */
        }
      }
      for (const chunk of errorChunks) chunk.fill(0);
      finish(code === 0 ? undefined : new BrokerError(errorCode));
    });
    child.stdin.end(input);
  });
}
const dpapiScript = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $entropy = [Text.Encoding]::UTF8.GetBytes('astra-credential-broker.v1:' + $request.purpose)
  $bytes = [Convert]::FromBase64String($request.ciphertext)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($plain))
  [Array]::Clear($plain, 0, $plain.Length)
} catch { exit 1 }
`;
async function unprotectCli(filename: string, vaultId: string): Promise<unknown> {
  const shell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const output = await runPrivate(
    shell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(dpapiScript, "utf16le").toString("base64"),
    ],
    JSON.stringify({
      purpose: `cli-secret:${vaultId}`,
      ciphertext: (await readFile(filename)).toString("base64"),
    }),
    15_000,
  );
  const bytes = Buffer.from(output.toString("utf8"), "base64");
  output.fill(0);
  try {
    return parseJson(bytes);
  } finally {
    bytes.fill(0);
  }
}
async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Validate every listed file and reject unlisted files/reparse points before executing a controller. */
export async function verifyComponent(
  directory: string,
  expectedManifestHash?: string,
): Promise<void> {
  requireValue(path.isAbsolute(directory), "invalid-component-path");
  let ancestor = path.resolve(directory);
  for (;;) {
    requireValue(!(await lstat(ancestor)).isSymbolicLink(), "unsafe-component-path");
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const bytes = await readFile(path.join(directory, "component.json"));
  if (expectedManifestHash)
    requireValue(
      createHash("sha256").update(bytes).digest("base64url") === expectedManifestHash,
      "component-integrity-failed",
    );
  const manifest = object(parseJson(bytes));
  requireValue(
    manifest.component === "astra-credential-broker" &&
      manifest.rid === "win-x64" &&
      typeof manifest.protocolMin === "number" &&
      manifest.protocolMin <= 1 &&
      typeof manifest.protocolMax === "number" &&
      manifest.protocolMax >= 1 &&
      typeof manifest.storageMin === "number" &&
      manifest.storageMin <= 1 &&
      typeof manifest.storageMax === "number" &&
      manifest.storageMax >= 1,
    "component-incompatible",
  );
  requireValue(
    Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 2000,
  );
  const files = new Set<string>();
  for (const value of manifest.files) {
    const file = object(value, ["path", "size", "sha256"]);
    const relative = text(file.path);
    requireValue(
      relative
        .split("/")
        .every(
          (part) =>
            /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== ".." && !part.endsWith("."),
        ),
      "unsafe-component-path",
    );
    requireValue(!files.has(relative.toLowerCase()), "duplicate-component-file");
    files.add(relative.toLowerCase());
    const content = await readFile(path.join(directory, relative));
    requireValue(
      content.length === file.size &&
        createHash("sha256").update(content).digest("hex") === file.sha256,
      "component-integrity-failed",
    );
  }
  for (const required of [
    "brokerctl.exe",
    "brokerctl.dll",
    "brokerctl.deps.json",
    "brokerctl.runtimeconfig.json",
    "hostfxr.dll",
    "hostpolicy.dll",
    "coreclr.dll",
    "system.private.corelib.dll",
    "e_sqlite3.dll",
  ])
    requireValue(files.has(required), "component-integrity-failed");
  const walk = async (current: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      requireValue(!entry.isSymbolicLink(), "unsafe-component-path");
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), `${relative}/`);
      else
        requireValue(
          entry.isFile() && (relative === "component.json" || files.has(relative.toLowerCase())),
          "unlisted-component-file",
        );
    }
  };
  await walk(directory);
}
export class WindowsBrokerHost implements BrokerHost {
  constructor(
    readonly home: string,
    readonly localPackageDirectory: string,
    private readonly clientDirectory: string,
  ) {}
  async inspectPackage(): Promise<CredentialSharingStatus["localPackageState"]> {
    if (!(await exists(this.localPackageDirectory))) return "missing";
    try {
      await verifyComponent(this.localPackageDirectory);
      return "ready";
    } catch {
      return "invalid";
    }
  }
  async inspect(): ReturnType<BrokerHost["inspect"]> {
    const empty = { installedVersion: null, installationDirectory: null };
    if (process.platform !== "win32" || process.arch !== "x64")
      return { ...empty, installState: "incompatible" };
    try {
      const filename = path.join(this.home, "installation.json");
      if (!(await exists(filename))) return { ...empty, installState: "not-installed" };
      const installation = object(parseJson(await readFile(filename)), [
        "version",
        "directory",
        "manifestHash",
      ]);
      const directory = text(installation.directory);
      requireValue(
        path.dirname(directory).toLowerCase() === path.join(this.home, "components").toLowerCase(),
        "unsafe-installation-path",
      );
      await verifyComponent(directory, text(installation.manifestHash));
      return {
        installState: "installed",
        installedVersion: text(installation.version),
        installationDirectory: directory,
      };
    } catch (error) {
      return {
        ...empty,
        installState:
          error instanceof BrokerError && error.code === "component-incompatible"
            ? "incompatible"
            : "damaged",
      };
    }
  }
  private async controller(
    command: string,
    args: string[] = [],
    input?: unknown,
    external = false,
  ): Promise<unknown> {
    let directory = this.localPackageDirectory;
    if (!external) {
      const installed = await this.inspect();
      requireValue(
        installed.installState === "installed" && installed.installationDirectory,
        "component-not-installed",
      );
      directory = installed.installationDirectory;
    } else await verifyComponent(directory);
    const output = await runPrivate(
      path.join(directory, "brokerctl.exe"),
      [command, "--home", this.home, ...args],
      input === undefined ? "" : JSON.stringify(input),
    );
    try {
      return parseJson(output);
    } finally {
      output.fill(0);
    }
  }
  async status(vault: string): Promise<{ serviceState: string; brokerOwnership: string }> {
    try {
      const result = object(await this.controller("status", ["--vault", vault]));
      if (result.runtime === null)
        return { serviceState: text(result.offlineState), brokerOwnership: "NOT_CHECKED" };
      const runtime = object(result.runtime);
      return {
        serviceState: text(runtime.serviceStatus),
        brokerOwnership: text(runtime.ownership),
      };
    } catch (error) {
      if (error instanceof BrokerError && error.code === "vault-not-registered")
        return { serviceState: "NOT_REGISTERED", brokerOwnership: "NOT_CHECKED" };
      return { serviceState: "UNAVAILABLE", brokerOwnership: "NOT_CHECKED" };
    }
  }
  async install(): Promise<void> {
    await this.controller(
      "install-local",
      ["--source", this.localPackageDirectory],
      undefined,
      true,
    );
  }
  async uninstall(): Promise<void> {
    await this.controller("uninstall", [], undefined, true);
  }
  async connect(vault: string, clientId: string, instanceId: string): Promise<BrokerConnection> {
    requireValue(
      process.platform === "win32" && process.arch === "x64",
      "platform-feature-unavailable",
    );
    const registration = object(await this.controller("register-vault", ["--vault", vault]));
    const vaultId = id(registration.vaultId);
    const ownerSid = text(registration.ownerSid);
    requireValue(
      path.resolve(text(registration.root)).toLowerCase() === path.resolve(vault).toLowerCase(),
      "vault-identity-mismatch",
    );
    await this.controller("ensure-running", ["--vault", vault]);
    const clientFile = path.join(this.clientDirectory, `${vaultId}.${id(clientId)}.dpapi`);
    if (!(await exists(clientFile)))
      await this.controller("grant", ["--vault", vault, "--out", clientFile], {
        clientId,
        scopes: ["initialize", "import", "handoff", "describe", "read", "events", "update"],
        credentialIds: [],
        allCredentials: true,
      });
    const access = object(await unprotectCli(clientFile, vaultId), ["clientId", "accessToken"]);
    requireValue(access.clientId === clientId, "client-identity-mismatch");
    return BrokerClient.connect({
      vaultId,
      ownerSid,
      clientId,
      instanceId,
      accessToken: text(access.accessToken),
    } satisfies BrokerIdentity);
  }
}
