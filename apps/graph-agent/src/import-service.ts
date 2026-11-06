import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BrokerError,
  canonical,
  id,
  object,
  parseJson,
  requireValue,
  text,
  unpackTransfer,
  type ExportVersion,
  type TransferSnapshot,
} from "@astra-conductor/credentials";
import {
  BROKER_COMPATIBILITY,
  type BrokerConnection,
  type BrokerHost,
} from "@astra-conductor/credential-host";
import {
  decodeSharedCredential,
  sharedCredentialContentType,
  type CredentialCipherPort,
} from "@astra-conductor/core/internal";
import type { AccountPreview, GraphStatus, ImportPreview } from "./contract.js";

interface Binding {
  state: "preparing" | "import-ready" | "shared";
  vaultDirectory: string;
  clientId: string;
  version: ExportVersion;
  sourceWatermark: string;
  keyRef: string;
  accounts: AccountPreview[];
}
interface PendingImport {
  previewId: string;
  expiresAt: number;
  binding: Binding;
  masterKey: Buffer;
}
export interface GraphSharingOptions {
  host: BrokerHost;
  cipher: CredentialCipherPort;
  directory: string;
  selectDirectory(): Promise<string | null>;
  canRefresh(provider: string): boolean;
  activate(
    binding: { vaultDirectory: string; clientId: string },
    changed: () => void,
  ): Promise<void>;
  accounts(): Promise<AccountPreview[]>;
  refresh(accountId: string): Promise<void>;
  deactivate(): Promise<void>;
}
/** Only a protected master key and public record descriptions are persisted by the receiver. */
export class GraphSharingService {
  private pending?: PendingImport;
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private active = false;
  private lastError: string | null = null;
  private readonly instanceId = randomUUID();
  private watcher?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private operation?: Promise<unknown>;
  private reconnecting?: Promise<void>;
  constructor(private readonly options: GraphSharingOptions) {}
  private async requireCompatibleComponent(): Promise<void> {
    const installation = await this.options.host.inspect();
    requireValue(
      installation.installState === "installed",
      installation.installState === "incompatible"
        ? "component-incompatible"
        : "component-not-installed",
    );
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    requireValue(!this.busy && !this.disposed, "operation-in-progress");
    this.busy = true;
    this.lastError = null;
    const pending = Promise.resolve()
      .then(operation)
      .catch((error) => {
        this.lastError = error instanceof BrokerError ? error.code : "sharing-operation-failed";
        throw new BrokerError(this.lastError);
      })
      .finally(() => {
        this.busy = false;
      });
    this.operation = pending;
    return pending;
  }
  private async readBinding(): Promise<Binding | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(this.options.directory, "binding.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const state = object(parseJson(bytes), [
      "state",
      "vaultDirectory",
      "clientId",
      "version",
      "sourceWatermark",
      "keyRef",
      "accounts",
    ]);
    requireValue(
      ["preparing", "import-ready", "shared"].includes(text(state.state)),
      "invalid-binding",
    );
    id(state.clientId);
    requireValue(path.isAbsolute(text(state.vaultDirectory)), "invalid-binding");
    const version = object(state.version, ["vaultId", "storageVersion", "attemptId", "keyId"]);
    for (const field of ["vaultId", "storageVersion", "attemptId", "keyId"]) id(version[field]);
    text(state.sourceWatermark);
    requireValue(/^[A-Za-z0-9_.-]+\.key$/.test(text(state.keyRef)), "invalid-binding");
    requireValue(Array.isArray(state.accounts) && state.accounts.length <= 1000, "invalid-binding");
    for (const item of state.accounts) {
      const account = object(item, [
        "id",
        "provider",
        "maskedIdentifier",
        "canRefresh",
        "revision",
      ]);
      id(account.id);
      text(account.provider);
      text(account.maskedIdentifier);
      text(account.revision);
      requireValue(typeof account.canRefresh === "boolean", "invalid-binding");
    }
    return state as unknown as Binding;
  }
  private async writeBinding(binding: Binding): Promise<void> {
    await this.writeAtomic("binding.json", Buffer.from(JSON.stringify(binding)));
  }
  private async writeAtomic(name: string, content: Uint8Array): Promise<void> {
    requireValue(!this.disposed, "client-closed");
    await mkdir(this.options.directory, { recursive: true });
    const target = path.join(this.options.directory, name);
    const staged = `${target}.${randomUUID()}.next`;
    try {
      await writeFile(staged, content, { flag: "wx", mode: 0o600 });
      requireValue(!this.disposed, "client-closed");
      await rename(staged, target);
    } finally {
      await rm(staged, { force: true });
    }
  }
  private async loadKey(binding: Binding): Promise<Buffer> {
    const decrypted = await this.options.cipher.decrypt(
      await readFile(path.join(this.options.directory, binding.keyRef)),
    );
    const cache = object(parseJson(Buffer.from(decrypted.plaintext)), ["version", "masterKey"]);
    requireValue(canonical(cache.version) === canonical(binding.version), "key-cache-mismatch");
    requireValue(/^[A-Za-z0-9_-]{43}$/.test(text(cache.masterKey)), "key-cache-mismatch");
    return Buffer.from(text(cache.masterKey), "base64url");
  }
  private async sharingState(client: BrokerConnection): Promise<{
    version: ExportVersion;
    sourceWatermark: string;
    ownership: string;
    preparedClientIds: string[];
  }> {
    const state = object(await client.call("getSharingState"));
    return {
      version: {
        vaultId: id(state.vaultId),
        storageVersion: id(state.storageVersion),
        attemptId: id(state.attemptId),
        keyId: id(state.keyId),
      },
      sourceWatermark: text(state.sourceWatermark),
      ownership: text(state.ownership),
      preparedClientIds: Array.isArray(state.preparedClientIds)
        ? state.preparedClientIds.map(id)
        : [],
    };
  }
  private async prepare(client: BrokerConnection, binding: Binding): Promise<void> {
    const current = await this.sharingState(client);
    requireValue(
      canonical(current.version) === canonical(binding.version) &&
        current.sourceWatermark === binding.sourceWatermark,
      "version-mismatch",
    );
    if (current.preparedClientIds.includes(binding.clientId)) {
      const key = await this.loadKey(binding);
      key.fill(0);
      return;
    }
    const challenge = object(await client.call("prepareChallenge"));
    const operationId = randomUUID();
    const key = await this.loadKey(binding);
    try {
      const proof = createHmac("sha256", key)
        .update(
          canonical([
            "astra.prepare.v1",
            binding.version.vaultId,
            binding.version.storageVersion,
            binding.clientId,
            operationId,
            binding.sourceWatermark,
            id(challenge.challengeId),
            text(challenge.nonce),
          ]),
        )
        .digest("base64url");
      await client.call("prepareClient", {
        operationId,
        sourceWatermark: binding.sourceWatermark,
        challengeId: challenge.challengeId,
        proof,
      });
    } finally {
      key.fill(0);
    }
  }
  async status(): Promise<GraphStatus> {
    const binding = await this.readBinding();
    let rememberedKey = false;
    if (binding) {
      try {
        const key = await this.loadKey(binding);
        key.fill(0);
        rememberedKey = true;
      } catch {
        /* A damaged cache requires explicit validation with the migration key again. */
      }
    }
    const installation = await this.options.host.inspect();
    const runtime =
      binding && installation.installState === "installed"
        ? await this.options.host.status?.(binding.vaultDirectory)
        : undefined;
    const connected = this.active && installation.installState === "installed";
    const accounts = connected ? await this.options.accounts() : (binding?.accounts ?? []);
    return {
      ...installation,
      requiredApiLevel: BROKER_COMPATIBILITY.requiredApiLevel,
      localPackageDirectory: this.options.host.localPackageDirectory,
      localPackageState: (await this.options.host.inspectPackage?.()) ?? "unknown",
      downloadState: "not-configured",
      available: await this.options.cipher.isAvailable(),
      state: binding?.state ?? "none",
      vaultDirectory: binding?.vaultDirectory ?? null,
      storageVersion: binding?.version.storageVersion ?? null,
      serviceState: runtime?.serviceState ?? "NOT_CHECKED",
      ownership: runtime?.brokerOwnership ?? "NOT_CHECKED",
      rememberedKey,
      connected,
      accounts,
      lastError: this.lastError,
    };
  }
  selectDirectory(): Promise<string | null> {
    return this.options.selectDirectory();
  }
  install(): Promise<void> {
    return this.exclusive(() => this.options.host.install());
  }
  uninstall(): Promise<void> {
    return this.exclusive(async () => {
      await this.options.deactivate();
      this.active = false;
      await this.options.host.uninstall();
    });
  }
  verifyImport(input: { vaultDirectory: string; migrationKey: string }): Promise<ImportPreview> {
    return this.exclusive(async () => {
      this.clearPreview();
      await this.requireCompatibleComponent();
      requireValue(path.isAbsolute(input.vaultDirectory), "invalid-vault-directory");
      requireValue(await this.options.cipher.isAvailable(), "secure-storage-unavailable");
      const previous = await this.readBinding();
      requireValue(
        !previous ||
          path.resolve(previous.vaultDirectory).toLowerCase() ===
            path.resolve(input.vaultDirectory).toLowerCase(),
        "import-location-fixed",
      );
      // Import can only open an exported vault; it must never initialize an empty location.
      const manifest = object(
        parseJson(await readFile(path.join(input.vaultDirectory, "manifest.json"))),
      );
      id(manifest.vaultId);
      const clientId = previous?.clientId ?? `graphagent-${randomUUID()}`;
      const client = await this.options.host.connect(
        input.vaultDirectory,
        clientId,
        this.instanceId,
      );
      try {
        const current = await this.sharingState(client);
        requireValue(current.version.vaultId === manifest.vaultId, "vault-identity-mismatch");
        const versionDirectory = path.join(
          input.vaultDirectory,
          "versions",
          current.version.storageVersion,
        );
        const snapshot = unpackTransfer(
          await readFile(path.join(versionDirectory, "migration.json")),
          input.migrationKey,
          await readFile(path.join(versionDirectory, "version.json")),
          current.version,
        );
        const accounts = this.previewAccounts(snapshot);
        const binding: Binding = {
          state: "preparing",
          vaultDirectory: path.resolve(input.vaultDirectory),
          clientId,
          version: current.version,
          sourceWatermark: current.sourceWatermark,
          keyRef: `${current.version.vaultId}.${current.version.storageVersion}.${current.version.keyId}.key`,
          accounts,
        };
        const previewId = randomUUID();
        this.pending = {
          previewId,
          expiresAt: Date.now() + 5 * 60_000,
          binding,
          masterKey: Buffer.from(snapshot.masterKey, "base64url"),
        };
        this.pendingTimer = setTimeout(() => this.clearPreview(), 5 * 60_000);
        this.pendingTimer.unref();
        return {
          previewId,
          storageVersion: current.version.storageVersion,
          recordCount: accounts.length,
          accounts,
        };
      } finally {
        client.close();
      }
    });
  }
  private previewAccounts(snapshot: TransferSnapshot): AccountPreview[] {
    const seen = new Set<string>();
    return snapshot.records.map((record) => {
      const description = record.description;
      requireValue(!seen.has(description.credentialId), "duplicate-credential");
      seen.add(description.credentialId);
      const decoded =
        description.contentType === sharedCredentialContentType
          ? decodeSharedCredential(record)
          : null;
      const provider = decoded?.account.provider ?? description.metadata.provider ?? "unknown";
      // Display only explicit public metadata, never an arbitrary decoded payload field.
      return {
        id: description.credentialId,
        provider,
        maskedIdentifier:
          decoded?.account.maskedIdentifier ?? description.metadata.maskedIdentifier ?? "—",
        canRefresh: !!decoded && this.options.canRefresh(provider),
        revision: description.revision,
      };
    });
  }
  confirmImport(previewId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.requireCompatibleComponent();
      const pending = this.pending;
      requireValue(
        pending && pending.previewId === previewId && pending.expiresAt > Date.now(),
        "import-preview-expired",
      );
      const binding = pending.binding;
      try {
        const encrypted = await this.options.cipher.encrypt(
          JSON.stringify({
            version: binding.version,
            masterKey: pending.masterKey.toString("base64url"),
          }),
        );
        await this.writeAtomic(binding.keyRef, encrypted);
        const readback = await this.loadKey(binding);
        try {
          requireValue(readback.equals(pending.masterKey), "key-readback-failed");
        } finally {
          readback.fill(0);
        }
        await this.writeBinding(binding);
      } finally {
        this.clearPreview();
      }
      await this.connectBinding(binding);
    });
  }
  async cancelPreview(): Promise<void> {
    this.clearPreview();
  }
  private clearPreview(): void {
    clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pending?.masterKey.fill(0);
    this.pending = undefined;
  }
  retry(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    const reconnecting = this.exclusive(async () => {
      await this.requireCompatibleComponent();
      const binding = await this.readBinding();
      requireValue(binding, "import-not-ready");
      await this.connectBinding(binding);
    });
    this.reconnecting = reconnecting;
    const clear = () => {
      if (this.reconnecting === reconnecting) this.reconnecting = undefined;
    };
    void reconnecting.then(clear, clear);
    return reconnecting;
  }
  private async connectBinding(binding: Binding): Promise<void> {
    const client = await this.options.host.connect(
      binding.vaultDirectory,
      binding.clientId,
      this.instanceId,
    );
    let ownership: string;
    try {
      await this.prepare(client, binding);
      ownership = (await this.sharingState(client)).ownership;
    } finally {
      client.close();
    }
    binding.state = ownership === "broker" ? "shared" : "import-ready";
    await this.writeBinding(binding);
    if (ownership === "broker" && !this.active) {
      await this.options.activate(binding, () => undefined);
      this.active = true;
    }
    this.scheduleWatch();
  }
  private scheduleWatch(): void {
    clearTimeout(this.watcher);
    if (this.disposed) return;
    this.watcher = setTimeout(() => {
      if (this.busy) {
        this.scheduleWatch();
        return;
      }
      void this.watch()
        .catch((error) => {
          this.lastError = error instanceof BrokerError ? error.code : "broker-unavailable";
        })
        .finally(() => this.scheduleWatch());
    }, 3000);
    this.watcher.unref();
  }
  private async watch(): Promise<void> {
    const binding = await this.readBinding();
    if (!binding || this.disposed) return;
    if (binding.state !== "shared" || !this.active) await this.retry();
  }
  async restore(): Promise<void> {
    if (!(await this.readBinding())) return;
    try {
      await this.retry();
    } catch {
      this.scheduleWatch();
    }
  }
  refresh(accountId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.requireCompatibleComponent();
      requireValue(this.active, "sharing-not-active");
      await this.options.refresh(id(accountId));
    });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.watcher);
    await this.operation?.catch(() => undefined);
    this.clearPreview();
    await this.options.deactivate();
    this.active = false;
  }
}
