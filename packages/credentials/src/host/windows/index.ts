import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import {
  BrokerClient,
  BrokerError,
  assertComponentCompatibility,
  apiLevelText,
  id,
  object,
  parseJson,
  parseCompatibilityJson,
  requireValue,
  text,
  unb64,
} from "../../index.js";
export { BROKER_COMPATIBILITY, BROKER_DISTRIBUTION } from "../../index.js";

export interface ComponentInstallation {
  installState: "not-installed" | "installed" | "damaged" | "incompatible" | "unknown";
  installedVersion: string | null;
  installedApiLevel?: string | null;
  installationDirectory: string | null;
}
export type LocalPackageState = "missing" | "ready" | "invalid" | "unknown";

export interface BrokerConnection {
  call(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}
export interface BrokerHost {
  localPackageDirectory: string;
  inspect(): Promise<ComponentInstallation>;
  status?(vault: string): Promise<{ serviceState: string; brokerOwnership: string }>;
  inspectPackage?(): Promise<LocalPackageState>;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  relocateVault?(
    previous: string,
    directory: string,
    vaultId: string,
    storageVersion: string,
  ): Promise<void>;
  forgetGrant?(vaultId: string, clientId: string): Promise<void>;
  revokeGrant?(vault: string, vaultId: string, clientId: string): Promise<void>;
  connect(
    vault: string,
    clientId: string,
    instanceId: string,
    options?: { existingGrantOnly?: boolean },
  ): Promise<BrokerConnection>;
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
  "component-incompatible",
  "protocol-incompatible",
  "api-incompatible",
  "invalid-component-version",
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
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $request.ownerSid) { exit 1 }
  $entropy = [Text.Encoding]::UTF8.GetBytes('astra-credential-broker.v1:' + $request.purpose)
  $bytes = [Convert]::FromBase64String($request.ciphertext)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($plain))
  [Array]::Clear($plain, 0, $plain.Length)
} catch { exit 1 }
`;
async function grantVerifier(
  ciphertext: Buffer,
  vaultId: string,
  ownerSid: string,
  clientId: string,
): Promise<Buffer> {
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
      ownerSid,
      ciphertext: ciphertext.toString("base64"),
    }),
    15_000,
  );
  const bytes = Buffer.from(output.toString("utf8"), "base64");
  output.fill(0);
  try {
    const access = object(parseJson(bytes), ["clientId", "accessToken"]);
    requireValue(access.clientId === clientId, "client-identity-mismatch");
    const token = unb64(access.accessToken, 32);
    try {
      return createHash("sha256").update(token).digest();
    } finally {
      token.fill(0);
    }
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
  let manifest: Record<string, unknown>;
  try {
    manifest = object(parseCompatibilityJson(bytes));
  } catch (error) {
    if (
      error instanceof BrokerError &&
      ["noncanonical-number", "invalid-api-level"].includes(error.code)
    )
      throw new BrokerError("component-incompatible");
    throw error;
  }
  assertComponentCompatibility(manifest);
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
interface RegisteredEndpoint {
  vault: string;
  vaultId: string;
  ownerSid: string;
  generation: string;
  clientId: string;
  file: string;
  ciphertext: Buffer;
  fingerprint: string;
}
interface LiveGrant {
  vault: string;
  clientId: string;
  fingerprint: string;
  verifier: Buffer;
  connections: number;
}
export class WindowsBrokerHost implements BrokerHost {
  private readonly grants = new Map<string, Promise<void>>();
  private readonly live = new Map<string, LiveGrant>();
  private readonly authorizationGenerations = new Map<string, number>();
  private authorizationSequence = 0;
  constructor(
    readonly home: string,
    readonly localPackageDirectory: string,
    private readonly clientDirectory: string,
    private readonly existingAuthorizationOnly = false,
  ) {}
  async inspectPackage(): Promise<LocalPackageState> {
    if (!(await exists(this.localPackageDirectory))) return "missing";
    try {
      await verifyComponent(this.localPackageDirectory);
      return "ready";
    } catch {
      return "invalid";
    }
  }
  async inspect(): ReturnType<BrokerHost["inspect"]> {
    const details: Pick<
      ComponentInstallation,
      "installedVersion" | "installationDirectory" | "installedApiLevel"
    > = {
      installedVersion: null,
      installationDirectory: null,
      installedApiLevel: null,
    };
    if (process.platform !== "win32" || process.arch !== "x64")
      return { ...details, installState: "incompatible" };
    try {
      const filename = path.join(this.home, "installation.json");
      if (!(await exists(filename))) return { ...details, installState: "not-installed" };
      const installation = object(parseJson(await readFile(filename)), [
        "version",
        "directory",
        "manifestHash",
      ]);
      const directory = text(installation.directory);
      details.installedVersion = text(installation.version);
      details.installationDirectory = directory;
      requireValue(
        path.dirname(directory).toLowerCase() === path.join(this.home, "components").toLowerCase(),
        "unsafe-installation-path",
      );
      const manifest = object(
        parseCompatibilityJson(await readFile(path.join(directory, "component.json"))),
      );
      if (typeof manifest.version === "string") details.installedVersion = manifest.version;
      try {
        details.installedApiLevel = apiLevelText(manifest.apiRevision);
      } catch {
        /* Missing or invalid API remains unavailable. */
      }
      await verifyComponent(directory, text(installation.manifestHash));
      return {
        installState: "installed",
        ...details,
      };
    } catch (error) {
      return {
        ...details,
        installState:
          error instanceof BrokerError &&
          ["component-incompatible", "invalid-api-level", "noncanonical-number"].includes(
            error.code,
          )
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
      requireValue(installed.installState !== "incompatible", "component-incompatible");
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
      const grant = [...this.live.values()].find(
        (item) => item.vault.toLowerCase() === path.resolve(vault).toLowerCase(),
      );
      if (grant) {
        const endpoint = await this.registeredEndpoint(vault, grant.clientId);
        if (endpoint?.fingerprint === grant.fingerprint) {
          let connection: BrokerClient | undefined;
          try {
            connection = await this.openPipe(endpoint, grant.verifier, randomUUID());
            const status = object(await connection.call("status"));
            return {
              serviceState: text(status.serviceStatus),
              brokerOwnership: text(status.ownership),
            };
          } catch {
            // A stopped or replacing broker is diagnosed by the verified controller below.
          } finally {
            if (connection) {
              await connection.call("disconnect").catch(() => undefined);
              connection.close();
            }
          }
        }
      }
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
  async relocateVault(
    previous: string,
    directory: string,
    vaultId: string,
    storageVersion: string,
  ): Promise<void> {
    requireValue(!this.existingAuthorizationOnly, "access-denied");
    await this.controller("register-vault", [
      "--vault",
      directory,
      "--previous-root",
      previous,
      "--vault-id",
      id(vaultId),
      "--storage-version",
      id(storageVersion),
    ]);
  }
  private clientFile(vaultId: string, clientId: string): string {
    return path.join(this.clientDirectory, id(vaultId) + "." + id(clientId) + ".dpapi");
  }
  async forgetGrant(vaultId: string, clientId: string): Promise<void> {
    const file = this.clientFile(vaultId, clientId);
    const pending = [this.grants.get(file + ":grant"), this.grants.get(file + ":upgrade")];
    this.clearAuthorization(file);
    await Promise.allSettled(pending);
    await rm(file, { force: true });
  }
  async revokeGrant(vault: string, vaultId: string, clientId: string): Promise<void> {
    requireValue(!this.existingAuthorizationOnly, "access-denied");
    const manifest = object(parseJson(await readFile(path.join(vault, "manifest.json"))));
    requireValue(manifest.vaultId === vaultId, "vault-identity-mismatch");
    await this.controller("ensure-running", ["--vault", vault]);
    await this.controller("rpc", ["--vault", vault, "--admin"], {
      method: "revokeClient",
      params: { clientId: id(clientId) },
    });
    this.clearAuthorization(this.clientFile(vaultId, clientId));
  }
  private clearAuthorization(file: string) {
    this.authorizationGenerations.set(file, ++this.authorizationSequence);
    this.dropLive(file);
    this.grants.delete(file + ":upgrade");
    this.grants.delete(file + ":grant");
  }
  private async authorize(
    vault: string,
    clientFile: string,
    clientId: string,
    upgrade: boolean,
  ): Promise<void> {
    const present = await exists(clientFile);
    if (this.existingAuthorizationOnly) {
      requireValue(present, "access-denied");
      return;
    }
    const previousScopes = [
      "initialize",
      "import",
      "handoff",
      "describe",
      "read",
      "events",
      "update",
    ];
    const grant = {
      clientId,
      scopes: [...previousScopes, "create", "delete"],
      credentialIds: [],
      allCredentials: true,
    };
    if (present) {
      if (upgrade)
        await this.controller("rpc", ["--vault", vault, "--admin"], {
          method: "updateClientGrant",
          params: { ...grant, previousScopes },
        });
    } else {
      requireValue(!upgrade, "access-denied");
      await this.controller("grant", ["--vault", vault, "--out", clientFile], grant);
    }
  }
  private async requireInstalled() {
    const installed = await this.inspect();
    requireValue(installed.installState !== "incompatible", "component-incompatible");
    requireValue(
      installed.installState === "installed" &&
        installed.installationDirectory &&
        installed.installedVersion,
      "component-not-installed",
    );
  }
  private async prepareGrant(
    vault: string,
    clientFile: string,
    clientId: string,
    upgrade = false,
  ): Promise<void> {
    const key = clientFile + (upgrade ? ":upgrade" : ":grant");
    let pending = this.grants.get(key);
    if (pending) return pending;
    pending = this.authorize(vault, clientFile, clientId, upgrade);
    this.grants.set(key, pending);
    try {
      await pending;
    } finally {
      if (this.grants.get(key) === pending) this.grants.delete(key);
    }
  }

  private dropLive(file: string) {
    this.live.get(file)?.verifier.fill(0);
    this.live.delete(file);
  }

  /** Only an already registered, running vault can skip starting a native controller. */
  private async registeredEndpoint(
    vault: string,
    clientId: string,
  ): Promise<RegisteredEndpoint | undefined> {
    const root = path.resolve(vault);
    try {
      const [location, maintenance, journal, manifestBytes] = await Promise.all([
        realpath(root),
        exists(path.join(this.home, "maintenance.json")),
        exists(path.join(this.home, "install-journal.json")),
        readFile(path.join(root, "manifest.json")),
      ]);
      if (maintenance || journal) return;
      requireValue(location.toLowerCase() === root.toLowerCase(), "vault-identity-mismatch");
      const manifest = object(parseJson(manifestBytes));
      const vaultId = id(manifest.vaultId);
      const file = this.clientFile(vaultId, clientId);
      const [registrationBytes, runtimeBytes, installation, ciphertext] = await Promise.all([
        readFile(path.join(this.home, "vaults", vaultId + ".json")),
        readFile(path.join(root, "runtime", "endpoint.json")),
        readFile(path.join(this.home, "installation.json")),
        readFile(file),
      ]);
      const ownerSid = text(manifest.ownerSid);
      const registration = object(parseJson(registrationBytes));
      requireValue(
        manifest.layoutVersion === 1 &&
          registration.vaultId === vaultId &&
          registration.ownerSid === ownerSid &&
          registration.directoryIdentity === manifest.directoryIdentity &&
          path.resolve(text(registration.root)).toLowerCase() === root.toLowerCase(),
        "vault-identity-mismatch",
      );
      // Process start ticks in this local hint can exceed JS safe integers. Only the generation
      // is used, and is checked against the mutually authenticated protocol greeting below.
      const runtime = object(JSON.parse(runtimeBytes.toString("utf8")));
      if (!runtime.generation || ["FAILED", "STOPPED", "STARTING"].includes(String(runtime.state)))
        return;
      const generation = id(runtime.generation);
      const fingerprint = createHash("sha256")
        .update(manifestBytes)
        .update(registrationBytes)
        .update(runtimeBytes)
        .update(installation)
        .update(ciphertext)
        .digest("hex");
      return {
        vault: root,
        vaultId,
        ownerSid,
        generation,
        clientId,
        file,
        ciphertext,
        fingerprint,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async openPipe(endpoint: RegisteredEndpoint, verifier: Buffer, instanceId: string) {
    const signingKey = Buffer.from(verifier);
    let connection: BrokerClient;
    try {
      connection = await BrokerClient.connect({
        vaultId: endpoint.vaultId,
        ownerSid: endpoint.ownerSid,
        clientId: endpoint.clientId,
        instanceId,
        verifier: signingKey,
      });
    } finally {
      signingKey.fill(0);
    }
    if (connection.generation !== endpoint.generation) {
      connection.close();
      throw new BrokerError("broker-generation-changed");
    }
    return connection;
  }

  private async connectRegistered(
    endpoint: RegisteredEndpoint,
    instanceId: string,
    preflight: boolean,
  ): Promise<BrokerConnection> {
    const { file, vault, clientId, fingerprint } = endpoint;
    const generation = this.authorizationGenerations.get(file);
    let grant = this.live.get(file);
    if (grant && grant.fingerprint !== fingerprint) {
      this.dropLive(file);
      grant = undefined;
    }
    const reused = grant !== undefined;
    if (!grant) {
      if (preflight) await this.requireInstalled();
      const verifier = await grantVerifier(
        endpoint.ciphertext,
        endpoint.vaultId,
        endpoint.ownerSid,
        clientId,
      );
      grant = { vault, clientId, fingerprint, verifier, connections: 0 };
    }
    let pipe: BrokerClient | undefined;
    grant.connections++;
    try {
      pipe = await this.openPipe(endpoint, grant.verifier, instanceId);
      let connection = pipe;
      const checked = await this.registeredEndpoint(vault, clientId);
      requireValue(checked?.fingerprint === fingerprint, "client-identity-mismatch");
      requireValue(generation === this.authorizationGenerations.get(file), "access-denied");
      const current = this.live.get(file);
      requireValue(!reused || current === grant, "client-identity-mismatch");
      if (current && current !== grant) {
        requireValue(current.fingerprint === fingerprint, "broker-generation-changed");
        grant.connections--;
        if (!grant.connections) grant.verifier.fill(0);
        grant = current;
        grant.connections++;
      }
      this.live.set(file, grant);
      const held = grant;
      let closed = false;
      const release = () => {
        if (closed) return;
        closed = true;
        if (--held.connections === 0 && this.live.get(file) === held) this.dropLive(file);
      };
      const observeClose = (socket: BrokerClient) =>
        socket.onClose(() => {
          if (socket === connection) release();
        });
      observeClose(connection);
      let repairAttempted = false;
      let tail: Promise<void> = Promise.resolve();
      const call = async (method: string, params?: unknown): Promise<unknown> => {
        requireValue(!closed, "broker-disconnected");
        if (this.live.get(file) !== held) {
          connection.close();
          throw new BrokerError("access-denied");
        }
        try {
          return await connection.call(method, params);
        } catch (error) {
          const needsNewScope =
            method === "createCredential" ||
            (method === "commitUpdate" &&
              params &&
              typeof params === "object" &&
              "delete" in params &&
              params.delete === true);
          if (
            this.existingAuthorizationOnly ||
            repairAttempted ||
            !needsNewScope ||
            !(error instanceof BrokerError) ||
            error.code !== "forbidden"
          )
            throw error;
          const stillCurrent = async () => {
            const latest = await this.registeredEndpoint(vault, clientId);
            requireValue(
              !closed && this.live.get(file) === held && latest?.fingerprint === fingerprint,
              "client-identity-mismatch",
            );
          };
          await stillCurrent();
          await this.prepareGrant(vault, file, clientId, true);
          await stillCurrent();
          const next = await this.openPipe(endpoint, held.verifier, instanceId);
          if (closed || this.live.get(file) !== held) {
            next.close();
            throw new BrokerError("client-closed");
          }
          const previous = connection;
          connection = next;
          observeClose(next);
          previous.close();
          repairAttempted = true;
          return next.call(method, params);
        }
      };
      return {
        call: (method, params) => {
          const result = tail.then(() => call(method, params));
          tail = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        },
        close: () => {
          release();
          connection.close();
        },
      };
    } catch (error) {
      pipe?.close();
      if (--grant.connections === 0) {
        if (this.live.get(file) === grant) this.dropLive(file);
        else grant.verifier.fill(0);
      }
      throw error;
    }
  }

  async connect(
    vault: string,
    clientId: string,
    instanceId: string,
    options?: { existingGrantOnly?: boolean },
  ): Promise<BrokerConnection> {
    const started = this.authorizationSequence;
    requireValue(
      process.platform === "win32" && process.arch === "x64",
      "platform-feature-unavailable",
    );
    const active = await this.registeredEndpoint(vault, clientId);
    if (active) {
      requireValue(
        (this.authorizationGenerations.get(active.file) ?? 0) <= started,
        "access-denied",
      );
      try {
        return await this.connectRegistered(active, instanceId, true);
      } catch (error) {
        if (
          !(error instanceof BrokerError) ||
          !/^broker-(?:disconnected|pipe-|handshake-|generation-changed|request-timeout)/.test(
            error.code,
          )
        )
          throw error;
      }
    }
    const existingOnly = this.existingAuthorizationOnly || options?.existingGrantOnly === true;
    const webManifest = existingOnly
      ? object(parseJson(await readFile(path.join(vault, "manifest.json"))))
      : undefined;
    if (webManifest)
      requireValue(
        await exists(this.clientFile(id(webManifest.vaultId), clientId)),
        "access-denied",
      );
    const registration =
      webManifest ??
      object(await this.controller("register-vault", ["--vault", vault, "--no-relocate"]));
    const vaultId = id(registration.vaultId);
    requireValue(
      existingOnly ||
        path.resolve(text(registration.root)).toLowerCase() === path.resolve(vault).toLowerCase(),
      "vault-identity-mismatch",
    );
    const file = this.clientFile(vaultId, clientId);
    const generation = this.authorizationGenerations.get(file);
    requireValue((generation ?? 0) <= started, "access-denied");
    await this.controller("ensure-running", ["--vault", vault]);
    requireValue(generation === this.authorizationGenerations.get(file), "access-denied");
    if (!existingOnly) await this.prepareGrant(vault, file, clientId);
    const endpoint = await this.registeredEndpoint(vault, clientId);
    requireValue(generation === this.authorizationGenerations.get(file), "access-denied");
    requireValue(endpoint && endpoint.vaultId === vaultId, "vault-identity-mismatch");
    return this.connectRegistered(endpoint, instanceId, false);
  }
}
