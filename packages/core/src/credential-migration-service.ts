import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import {
  BROKER_COMPATIBILITY,
  BrokerError,
  SharedBrokerClient,
  canonical,
  hash,
  id,
  object,
  parseJson,
  requireValue,
  text,
  unpackTransfer,
  verifyTransferKey,
  type ExportVersion,
} from "@astra-conductor/credentials";
import type { BrokerHost } from "@astra-conductor/credentials/host/windows";
import type {
  BackendContext,
  CredentialAccountPreview,
  CredentialExportDelivery,
  CredentialImportPreview,
  CredentialManagementStatus,
} from "@astra-conductor/contract/common";
import { AppError } from "./errors.js";
import type { CredentialMutationGate } from "./credential-mutation-gate.js";
import type { SwitchingCredentialService } from "./credential-service.js";
import { CredentialVault } from "./credential-vault.js";
import { MemoryStorage } from "./memory-storage.js";
import type { CredentialCipherPort, StoragePort } from "./ports.js";
import type { ProviderRegistry } from "./providers/registry.js";
import {
  SharedCredentialService,
  decodeSharedCredential,
  sharedCredentialContentType,
} from "./shared-credential-service.js";
import {
  keyFile,
  readMigrationProfile,
  versionFrom,
  writeProfileFile,
  type MigrationBinding,
  type MigrationOperation,
  type MigrationProfile,
  type PrivateSnapshot,
  type Product,
} from "./credential-migration-profile.js";
import {
  exportSnapshot,
  preparePrivateSnapshot,
  protectManifest,
  verifyManifest,
  previewRecord,
  privateBaseline,
  privateSnapshotReceipt,
  readCurrentRecords,
  recordDigest,
  recordInput,
  snapshotWatermark,
  verifyPrivateSnapshot,
} from "./credential-migration-snapshot.js";

export interface CredentialMigrationOptions {
  product: Product;
  cacheDirectory: string;
  privateDataDirectory?: string;
  storage: StoragePort;
  sharedStorage?: StoragePort;
  cipher: CredentialCipherPort;
  mutations: CredentialMutationGate;
  providers: ProviderRegistry;
  host: BrokerHost;
  switcher: SwitchingCredentialService;
  hasActiveAuth(): boolean;
  selectStorage?(
    selection: "private" | "shared",
    binding: MigrationBinding | null,
  ): StoragePort | void;
  selectDirectory?(): Promise<string | null>;
  changed?(): void;
}
const messages: Record<string, string> = {
  "migration-review-required":
    "私有副本或共享记录发生变化，请核对受影响的账号后选择是否使用共享当前值",
  "component-incompatible": `凭据共享组件需要升级到 API level ${BROKER_COMPATIBILITY.requiredApiLevel}`,
  "component-not-installed": "请先安装兼容的凭据共享组件",
  "authorization-in-progress": "请先完成或取消当前账号授权",
  "vault-directory-not-empty": "首次导出请选择新的空目录",
  "invalid-migration-key": "迁移密钥无效，请在当前目录重新验证",
  "import-preview-expired": "导入验证已过期，请重新输入密钥",
  "private-snapshot-stale": "共享数据已更新，请重新准备内置快照",
  "sharing-not-active": "该库尚未由 broker 接管，请先在旧来源端完成交接",
  "private-snapshot-readback-failed": "内置快照验证失败，请重新准备",
  "key-cache-mismatch": "此绑定的本地密钥不可用，请重新验证迁移密钥",
};
function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === "";
}
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}
function offline(error: unknown): boolean {
  return (
    error instanceof BrokerError &&
    [
      "broker-disconnected",
      "broker-request-timeout",
      "broker-pipe-enoent",
      "broker-pipe-econnreset",
      "broker-pipe-econnrefused",
      "broker-pipe-epipe",
      "component-not-installed",
      "controller-unavailable",
      "vault-directory-missing",
    ].includes(error.code)
  );
}
async function unpack(directory: string, version: ExportVersion, migrationKey: string) {
  const folder = path.join(directory, "versions", version.storageVersion);
  const [pack, metadata] = await Promise.all([
    readFile(path.join(folder, "migration.json")),
    readFile(path.join(folder, "version.json")),
  ]);
  try {
    return unpackTransfer(pack, migrationKey, metadata, version);
  } catch (error) {
    if (error instanceof BrokerError) throw error;
    throw new BrokerError("invalid-migration-key");
  }
}

/** One instance per exclusively locked product profile. Only explicit local commands select a backend. */
export class CredentialMigrationService {
  private readonly instanceId = randomUUID();
  private contextId = randomUUID();
  private profile: MigrationProfile;
  private operation?: Promise<unknown>;
  private lastError: string | null = null;
  private broker?: SharedBrokerClient;
  private shared?: SharedCredentialService;
  private sharedStorage?: StoragePort;
  private selectedIdentity?: string;
  private recordCount = 0;
  private visible = new Set<string>();
  private visibleUsage = new Set<string>();
  private previews: CredentialAccountPreview[] = [];
  private cursor = "0";
  private watcher?: ReturnType<typeof setTimeout>;
  private syncing?: Promise<void>;
  private stopped = false;
  private review: NonNullable<CredentialManagementStatus["migrationReview"]> | null = null;
  private pending?: {
    preview: CredentialImportPreview;
    binding: MigrationBinding;
    key: Buffer;
    expiresAt: number;
  };
  private timer?: ReturnType<typeof setTimeout>;

  get operationId(): string | null {
    return this.profile.operation?.id ?? null;
  }
  constructor(private readonly options: CredentialMigrationOptions) {
    this.profile = readMigrationProfile(options.cacheDirectory, options.product, options.storage);
    if (this.profile.selectedBackend === "shared") this.selectUnavailable(this.requireBinding());
  }
  private persist(next: MigrationProfile): void {
    writeProfileFile(
      path.join(this.options.cacheDirectory, "migration-state.json"),
      JSON.stringify(next, null, 2) + "\n",
    );
    this.profile = next;
  }
  private save(update: Partial<MigrationProfile>): void {
    this.persist({ ...this.profile, ...update });
  }
  private requireBinding(): MigrationBinding {
    const binding = this.profile.binding;
    requireValue(binding, "binding-required");
    return binding;
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.operation || this.stopped)
      return Promise.reject(new AppError("conflict", "本端凭据操作正在执行，请刷新后重试"));
    this.lastError = null;
    clearTimeout(this.watcher);
    const result = Promise.resolve()
      .then(async () => {
        await this.syncing;
        return action();
      })
      .catch((error) => {
        this.lastError =
          error instanceof BrokerError || error instanceof AppError
            ? error.code
            : "sharing-operation-failed";
        if (error instanceof AppError) throw error;
        throw new AppError(
          "service-unavailable",
          `${messages[this.lastError] ?? "凭据操作未完成，可重试"}（${this.lastError}）`,
          true,
        );
      })
      .finally(() => {
        this.operation = undefined;
        this.watch();
        this.options.changed?.();
      });
    this.operation = result;
    return result;
  }
  private async barrier<T>(action: () => Promise<T>): Promise<T> {
    requireValue(!this.options.hasActiveAuth(), "authorization-in-progress");
    try {
      await this.options.mutations.freeze();
      requireValue(!this.options.hasActiveAuth(), "authorization-in-progress");
      return await action();
    } finally {
      this.options.mutations.resume();
    }
  }
  private async compatible() {
    const installation = await this.options.host.inspect();
    requireValue(
      installation.installState === "installed",
      installation.installState === "incompatible"
        ? "component-incompatible"
        : "component-not-installed",
    );
    requireValue(await this.options.cipher.isAvailable(), "secure-storage-unavailable");
  }
  private allocate(
    kind: MigrationOperation["kind"],
    directory: string,
    clientId = this.options.product + "-" + randomUUID(),
  ): MigrationOperation {
    return { id: randomUUID(), kind, vaultDirectory: directory, clientId };
  }
  private async directory(raw: string, empty: boolean) {
    requireValue(path.isAbsolute(raw), "invalid-vault-directory");
    const directory = path.resolve(raw);
    // Resolve parents too: a junction must not alias a product's private files.
    const actual = existsSync(directory)
      ? await realpath(directory)
      : path.join(await realpath(path.dirname(directory)), path.basename(directory));
    if (this.options.privateDataDirectory) {
      const own = await realpath(this.options.privateDataDirectory);
      requireValue(
        !isInside(own, actual) && !isInside(actual, own),
        "overlapping-product-and-vault-paths",
      );
    }
    if (existsSync(directory)) {
      const info = await lstat(directory);
      requireValue(info.isDirectory() && !info.isSymbolicLink(), "invalid-vault-directory");
      if (empty) requireValue(!(await readdir(directory)).length, "vault-directory-not-empty");
    }
    return actual;
  }
  private async readKey(binding: MigrationBinding) {
    let plaintext: string;
    try {
      const bytes = await readFile(keyFile(this.options.cacheDirectory, binding.keyRef));
      plaintext = (await this.options.cipher.decrypt(bytes)).plaintext;
    } catch {
      throw new BrokerError("key-cache-unavailable");
    }
    const decoded = object(parseJson(Buffer.from(plaintext)), ["version", "masterKey"]);
    requireValue(
      canonical(decoded.version) === canonical(binding.version) &&
        /^[\w-]{43}$/.test(text(decoded.masterKey)),
      "key-cache-mismatch",
    );
    return text(decoded.masterKey);
  }
  /** A protected snapshot can be checked with a public watermark even if the master-key slot was lost. */
  private async checkSnapshotWatermark(binding: MigrationBinding, snapshot: PrivateSnapshot) {
    await verifyManifest(binding, snapshot, this.options.cipher);
    const broker = new SharedBrokerClient(async () => {
      await this.compatible();
      await this.verifyVaultIdentity(binding.vaultDirectory, binding.version.vaultId);
      return this.options.host.connect(binding.vaultDirectory, binding.clientId, this.instanceId, {
        existingGrantOnly: true,
      });
    });
    try {
      await this.validateBinding(binding, broker);
      requireValue(
        (await snapshotWatermark(broker, binding)) === snapshot.watermark,
        "private-snapshot-stale",
      );
    } catch (error) {
      if (!offline(error)) throw error;
    } finally {
      broker.close();
    }
  }
  private async rememberKey(binding: MigrationBinding, masterKey: string) {
    const encrypted = await this.options.cipher.encrypt(
      JSON.stringify({ version: binding.version, masterKey }),
    );
    writeProfileFile(keyFile(this.options.cacheDirectory, binding.keyRef), encrypted);
    requireValue((await this.readKey(binding)) === masterKey, "key-readback-failed");
  }
  private async validateBinding(binding: MigrationBinding, broker: SharedBrokerClient) {
    const state = await broker.getSharingState();
    requireValue(
      canonical(versionFrom({ ...state })) === canonical(binding.version) &&
        state.sourceWatermark === binding.sourceWatermark,
      "vault-identity-mismatch",
    );
    requireValue(state.ownership === "broker", "sharing-not-active");
  }
  private async verifyVaultIdentity(directory: string, vaultId: string) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(directory, "manifest.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new BrokerError("vault-directory-missing");
      throw error;
    }
    requireValue(object(parseJson(bytes)).vaultId === vaultId, "vault-identity-mismatch");
  }
  private async verifyLocation(binding: MigrationBinding) {
    await this.verifyVaultIdentity(binding.vaultDirectory, binding.version.vaultId);
    const metadata = object(
      parseJson(
        await readFile(
          path.join(
            binding.vaultDirectory,
            "versions",
            binding.version.storageVersion,
            "version.json",
          ),
        ),
      ),
    );
    verifyTransferKey(metadata, binding.version, await this.readKey(binding));
  }
  private async connect(binding: MigrationBinding, existingGrantOnly = true) {
    await this.verifyLocation(binding);
    return this.options.host.connect(binding.vaultDirectory, binding.clientId, this.instanceId, {
      existingGrantOnly,
    });
  }
  private client(binding: MigrationBinding, existingGrantOnly = true) {
    return new SharedBrokerClient(() => this.connect(binding, existingGrantOnly));
  }
  private async boundClient(binding: MigrationBinding) {
    await this.compatible();
    const client = this.client(binding);
    try {
      await this.validateBinding(binding, client);
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  private async delivery(binding: MigrationBinding): Promise<CredentialExportDelivery> {
    requireValue(
      binding.exportOperationId && !binding.deliveryAcknowledged && !binding.deliveryAckPending,
      "delivery-unavailable",
    );
    await this.compatible();
    const conn = await this.connect(binding);
    try {
      const migrationKey = text(object(await conn.call("recoverDelivery")).migrationKey);
      requireValue(
        (await unpack(binding.vaultDirectory, binding.version, migrationKey)).masterKey ===
          (await this.readKey(binding)),
        "key-cache-mismatch",
      );
      return { migrationKey, storageVersion: binding.version.storageVersion };
    } finally {
      conn.close();
    }
  }
  exportCredentials(directory: string) {
    return this.exclusive(() => this.performExport(directory));
  }
  private async performExport(raw: string): Promise<CredentialExportDelivery> {
    if (this.profile.binding) {
      requireValue(samePath(raw, this.profile.binding.vaultDirectory), "export-location-fixed");
      return this.delivery(this.profile.binding);
    }
    await this.compatible();
    let op = this.profile.operation;
    requireValue(
      !op || (op.kind === "export" && samePath(raw, op.vaultDirectory)),
      "operation-in-progress",
    );
    const directory = await this.directory(raw, !op);
    if (!op) {
      requireValue(!this.options.hasActiveAuth(), "authorization-in-progress");
      op = this.allocate("export", directory);
      this.save({ operation: op });
    }
    if (op.grantVaultId) await this.verifyVaultIdentity(directory, op.grantVaultId);
    const conn = await this.options.host.connect(directory, op.clientId, this.instanceId);
    try {
      const status = object(await conn.call("status"));
      if (!op.grantVaultId) {
        op = { ...op, grantVaultId: id(status.vaultId), keyRef: op.id + ".key" };
        this.save({ operation: op });
      }
      let receipt;
      if (status.storageVersion !== null)
        receipt = object(await conn.call("getOperation", { operationId: op.id }));
      else {
        const snapshot = await this.barrier(() =>
          exportSnapshot(this.options.storage, this.options.cipher, this.options.providers),
        );
        if (op.sourceWatermark && op.sourceWatermark !== snapshot.watermark)
          op = { ...op, id: randomUUID() };
        op = {
          ...op,
          sourceWatermark: snapshot.watermark,
          privateBaseline: snapshot.baseline,
          recordDigest: recordDigest(snapshot.records),
          snapshotAt: new Date().toISOString(),
          keyRef: op.id + ".key",
        };
        this.save({ operation: op });
        const request = {
          operationId: op.id,
          sourceWatermark: snapshot.watermark,
          records: snapshot.records,
        };
        requireValue(
          Buffer.byteLength(
            canonical({ protocolVersion: 1, id: randomUUID(), method: "publish", params: request }),
          ) <=
            2 * 1024 * 1024,
          "message-too-large",
        );
        receipt = object(await conn.call("publish", request));
      }
      requireValue(
        receipt.state === "exported" && op.sourceWatermark && op.keyRef,
        "export-receipt-mismatch",
      );
      const version = versionFrom({ ...receipt, vaultId: status.vaultId });
      if (op.version)
        requireValue(canonical(op.version) === canonical(version), "export-receipt-mismatch");
      else this.save({ operation: { ...op, version } });
      const migrationKey = text(
        receipt.migrationKey ?? object(await conn.call("recoverDelivery")).migrationKey,
      );
      const snapshot = await unpack(directory, version, migrationKey);
      const sourceClientId = op.clientId;
      requireValue(
        snapshot.records.every(
          (r) =>
            r.description.createdByClientId === sourceClientId &&
            r.description.lastUpdatedByClientId === sourceClientId,
        ) && recordDigest(snapshot.records.map(recordInput)) === op.recordDigest,
        "export-readback-mismatch",
      );
      const accounts = snapshot.records.map((record) =>
        previewRecord(record, this.options.providers),
      );
      const binding: MigrationBinding = {
        version,
        vaultDirectory: directory,
        clientId: op.clientId,
        sourceWatermark: op.sourceWatermark,
        keyRef: op.keyRef,
        exportOperationId: op.id,
        deliveryAcknowledged: false,
        accounts,
        recordCount: accounts.length,
        managedIds: accounts.map((a) => a.id),
        privateBaseline: op.privateBaseline,
        sharedBaseline: Object.fromEntries(accounts.map((a) => [a.id, a.revision])),
        snapshotAt: op.snapshotAt,
      };
      await this.rememberKey(binding, snapshot.masterKey);
      const broker = this.client(binding);
      try {
        await this.validateBinding(binding, broker);
      } finally {
        broker.close();
      }
      this.save({ migrationState: "export-ready", binding, operation: undefined });
      this.contextId = randomUUID();
      return { migrationKey, storageVersion: version.storageVersion };
    } finally {
      conn.close();
    }
  }
  resumeExport(): Promise<CredentialExportDelivery | null> {
    return this.exclusive(async () => {
      const binding = this.profile.binding;
      if (!binding) return this.performExport(this.requireOperation("export").vaultDirectory);
      if (binding.deliveryAcknowledged && binding.exportOperationId) return null;
      if (binding.deliveryAckPending) {
        await this.acknowledge(binding);
        return null;
      }
      return this.delivery(binding);
    });
  }
  restartExport(directory: string) {
    return this.exportCredentials(directory);
  }
  private requireOperation(kind: MigrationOperation["kind"]) {
    const op = this.profile.operation;
    requireValue(op?.kind === kind, "operation-not-pending");
    return op;
  }
  acknowledgeDelivery() {
    return this.exclusive(() => this.acknowledge(this.requireBinding()));
  }
  private async acknowledge(binding: MigrationBinding) {
    requireValue(binding.exportOperationId, "delivery-unavailable");
    if (binding.deliveryAcknowledged) return;
    if (!binding.deliveryAckPending)
      this.save({ binding: { ...binding, deliveryAckPending: true } });
    const conn = await this.connect(binding);
    try {
      await conn.call("acknowledgeDelivery");
      this.save({
        binding: { ...binding, deliveryAcknowledged: true, deliveryAckPending: undefined },
      });
    } finally {
      conn.close();
    }
  }
  private clearPreview() {
    clearTimeout(this.timer);
    this.pending?.key.fill(0);
    this.pending = undefined;
  }
  private async abandon(kind: "export" | "import") {
    const op = this.profile.operation;
    if (!op) return;
    requireValue(op.kind === kind, "operation-in-progress");
    if (op.grantVaultId && op.keyRef && this.profile.binding?.clientId !== op.clientId) {
      const task = {
        vaultId: op.grantVaultId,
        vaultDirectory: op.vaultDirectory,
        clientId: op.clientId,
        keyRef: op.keyRef,
        keyCleanupPending: true,
        sessionCleanupPending: true,
      };
      this.save({ operation: undefined, cleanup: [...(this.profile.cleanup ?? []), task] });
      await this.cleanup();
    } else if (op.keyRef && this.profile.binding?.keyRef !== op.keyRef)
      await rm(keyFile(this.options.cacheDirectory, op.keyRef), { force: true });
    if (kind === "import") this.clearPreview();
    this.save({ operation: undefined });
    this.contextId = randomUUID();
  }
  cancel() {
    return this.exclusive(() => this.abandon("export"));
  }
  cancelExport() {
    return this.cancel();
  }
  cancelPreview() {
    return this.exclusive(() => this.abandon("import"));
  }
  cancelImport() {
    return this.cancelPreview();
  }
  verifyImport(input: { vaultDirectory: string; migrationKey: string }) {
    return this.exclusive(() => this.verify(input));
  }
  private async verify(input: {
    vaultDirectory: string;
    migrationKey: string;
  }): Promise<CredentialImportPreview> {
    await this.compatible();
    const directory = await this.directory(input.vaultDirectory, false);
    const existing = this.profile.binding;
    requireValue(
      !existing || samePath(directory, existing.vaultDirectory),
      "import-location-fixed",
    );
    let op = this.profile.operation;
    requireValue(
      !op || (op.kind === "import" && samePath(directory, op.vaultDirectory)),
      "operation-in-progress",
    );
    if (!op) {
      op = this.allocate("import", directory, existing?.clientId);
      op.keyRef = op.id + ".key";
      this.save({ operation: op });
    }
    const manifest = object(parseJson(await readFile(path.join(directory, "manifest.json"))));
    const vaultId = id(manifest.vaultId);
    // B2/B3 use one published version. Read and decrypt locally before registering a new client.
    const entries = await readdir(path.join(directory, "versions"), { withFileTypes: true });
    const versions = entries.filter(
      (item) =>
        item.isDirectory() &&
        existsSync(path.join(directory, "versions", item.name, "version.json")),
    );
    requireValue(versions.length === 1, "ambiguous-storage-version");
    const storageVersion = id(versions[0]!.name);
    const metadata = object(
      parseJson(await readFile(path.join(directory, "versions", storageVersion, "version.json"))),
    );
    const version = versionFrom(metadata);
    requireValue(
      version.vaultId === vaultId &&
        version.storageVersion === storageVersion &&
        (!existing || canonical(existing.version) === canonical(version)),
      "vault-identity-mismatch",
    );
    const snapshot = await unpack(directory, version, input.migrationKey);
    if (op.version) requireValue(canonical(op.version) === canonical(version), "version-mismatch");
    else this.save({ operation: { ...op, version } });
    const accounts = snapshot.records.map((record) =>
      previewRecord(record, this.options.providers),
    );
    const conflicts = accounts.filter((_, index) => {
      const record = snapshot.records[index]!;
      if (record.description.contentType !== sharedCredentialContentType) return false;
      const { account } = decodeSharedCredential(record);
      return (
        !!this.options.storage.accounts.get(account.id) ||
        !!this.options.storage.accounts.findByStableIdentity(
          account.provider,
          account.stableIdentity,
        )
      );
    });
    this.clearPreview();
    const binding: MigrationBinding = existing
      ? { ...existing, keyRef: op.keyRef! }
      : {
          vaultDirectory: directory,
          clientId: op.clientId,
          version,
          keyRef: op.keyRef!,
          sourceWatermark: "",
          recordCount: accounts.length,
          accounts,
          privateBaseline: privateBaseline(this.options.storage),
          sharedBaseline: Object.fromEntries(accounts.map((a) => [a.id, a.revision])),
          managedIds: [],
        };
    const preview = {
      previewId: randomUUID(),
      storageVersion,
      recordCount: accounts.length,
      accounts,
      conflicts,
    };
    this.pending = {
      binding,
      preview,
      key: Buffer.from(snapshot.masterKey, "base64url"),
      expiresAt: Date.now() + 300_000,
    };
    this.timer = setTimeout(() => this.clearPreview(), 300_000);
    this.timer.unref();
    return preview;
  }
  confirmImport(previewId: string) {
    return this.exclusive(() => this.confirm(previewId));
  }
  private async confirm(previewId: string) {
    if (this.profile.lastImportId === previewId) return;
    const pending = this.pending;
    requireValue(
      pending && pending.expiresAt > Date.now() && pending.preview.previewId === previewId,
      "import-preview-expired",
    );
    const op = this.requireOperation("import");
    await this.compatible();
    requireValue(op.clientId === pending.binding.clientId, "stale-context");
    await this.rememberKey(pending.binding, pending.key.toString("base64url"));
    this.save({ operation: { ...op, grantVaultId: pending.binding.version.vaultId } });
    // Explicit confirmation can provision the receiving client's first grant.
    const broker = this.client(pending.binding, false);
    try {
      const current = await broker.getSharingState();
      requireValue(
        canonical(versionFrom({ ...current })) === canonical(pending.binding.version),
        "version-mismatch",
      );
      requireValue(current.ownership === "broker", "sharing-not-active");
      const binding = { ...pending.binding, sourceWatermark: current.sourceWatermark };
      if (this.profile.binding) {
        // Revalidation keeps the committed slot untouched until the new key and live grant work.
        binding.keyRef = this.profile.binding.keyRef;
        const staged = keyFile(this.options.cacheDirectory, pending.binding.keyRef);
        writeProfileFile(
          keyFile(this.options.cacheDirectory, binding.keyRef),
          await readFile(staged),
        );
        await rm(staged, { force: true });
      }
      this.save({
        operation: undefined,
        lastImportId: previewId,
        binding,
        migrationState: this.profile.binding ? this.profile.migrationState : "import-ready",
      });
    } finally {
      broker.close();
    }
    this.clearPreview();
    this.contextId = randomUUID();
  }
  rejoinShared(migrationKey: string) {
    return this.exclusive(async () => {
      const directory = this.profile.previousDirectory;
      requireValue(directory, "import-directory-required");
      const preview = await this.verify({ vaultDirectory: directory, migrationKey });
      await this.confirm(preview.previewId);
    });
  }
  private selectUnavailable(binding: MigrationBinding) {
    const identity = canonical([binding.clientId, binding.version, binding.vaultDirectory]);
    const changed =
      this.selectedIdentity !== identity || !!this.shared || !this.options.switcher.isShared;
    this.selectedIdentity = identity;
    this.sharedStorage =
      this.options.selectStorage?.("shared", binding) ||
      this.options.sharedStorage ||
      this.sharedStorage ||
      new MemoryStorage();
    this.options.switcher.useUnavailable();
    this.shared?.dispose();
    this.shared = undefined;
    this.visible.clear();
    this.visibleUsage.clear();
    this.broker?.close();
    this.broker = undefined;
    if (changed) this.contextId = randomUUID();
  }
  private selectPrivate() {
    this.selectedIdentity = undefined;
    this.options.selectStorage?.("private", null);
    this.options.switcher.usePrivate();
    this.shared?.dispose();
    this.broker?.close();
    this.broker = undefined;
    this.shared = undefined;
    this.sharedStorage = undefined;
    this.visible.clear();
    this.visibleUsage.clear();
    this.contextId = randomUUID();
  }
  private async synchronize(shared: SharedCredentialService, broker: SharedBrokerClient) {
    const listed = await broker.listCredentials();
    const accounts = await shared.listAccounts(listed);
    const descriptions = new Map(listed.map((item) => [item.credentialId, item]));
    const projection = this.sharedStorage!;
    const ids = new Set(accounts.map((account) => account.id));
    projection.transaction(() => {
      for (const previous of projection.accounts.list())
        if (!ids.has(previous.id)) projection.accounts.delete(previous.id);
      for (const account of accounts)
        projection.accounts.save({
          ...account,
          enabled: projection.accounts.get(account.id)?.enabled ?? account.enabled,
        });
    });
    this.visible = ids;
    this.recordCount = descriptions.size;
    this.visibleUsage = new Set(
      accounts
        .filter(
          (account) =>
            descriptions.get(account.id)?.metadata.supportsUsage === "true" &&
            !!this.options.providers.getUsage(account.provider),
        )
        .map((account) => account.id),
    );
    this.previews = accounts.map((account) => ({
      id: account.id,
      provider: account.provider,
      maskedIdentifier: account.maskedIdentifier,
      canRefresh: !!this.options.providers.getAccount(account.provider)?.refreshCredentials,
      revision: descriptions.get(account.id)?.revision ?? "1",
    }));
  }
  private async activate(binding: MigrationBinding, broker: SharedBrokerClient) {
    this.selectUnavailable(binding);
    const shared = new SharedCredentialService(broker, {
      providers: this.options.providers,
      storage: this.sharedStorage,
      persistProjectionRevisions: true,
    });
    try {
      await snapshotWatermark(broker, binding);
      await this.synchronize(shared, broker);
      this.options.switcher.useShared(shared);
      // Verify business access before committing a new selection. Resuming C keeps reads lazy.
      if (!this.isSharedSelected()) {
        const first = this.visible.values().next();
        if (!first.done) await this.options.switcher.load(first.value);
      }
    } catch (error) {
      shared.dispose();
      throw error;
    }
    this.shared = shared;
    this.broker = broker;
    this.cursor = "0";
    this.contextId = randomUUID();
  }
  private async checkReview(
    binding: MigrationBinding,
    broker: SharedBrokerClient,
    confirmationId?: string,
  ) {
    const descriptions = await broker.listCredentials();
    const current = Object.fromEntries(descriptions.map((d) => [d.credentialId, d.revision]));
    const local = privateBaseline(this.options.storage);
    const baseline = binding.privateBaseline ?? {};
    const shared =
      binding.sharedBaseline ??
      Object.fromEntries((binding.accounts ?? []).map((a) => [a.id, a.revision]));
    const changed = new Set(
      [
        ...Object.keys(local),
        ...Object.keys(baseline),
        ...Object.keys(current),
        ...Object.keys(shared),
      ].filter((id) => local[id] !== baseline[id] || current[id] !== shared[id]),
    );
    if (!changed.size) {
      this.review = null;
      return;
    }
    const token = hash([binding.clientId, local, current]);
    if (confirmationId === token) {
      this.review = null;
      return;
    }
    const accounts: CredentialAccountPreview[] = [];
    for (const id of changed) {
      const description = descriptions.find((d) => d.credentialId === id);
      if (description)
        accounts.push(previewRecord(await broker.getCredential(id), this.options.providers));
      else {
        const account = this.options.storage.accounts.get(id);
        accounts.push({
          id,
          provider:
            account?.provider ?? binding.accounts?.find((a) => a.id === id)?.provider ?? "unknown",
          maskedIdentifier:
            account?.maskedIdentifier ??
            binding.accounts?.find((a) => a.id === id)?.maskedIdentifier ??
            "—",
          canRefresh: false,
          revision: "0",
        });
      }
    }
    this.review = { id: token, accounts };
    throw new BrokerError("migration-review-required");
  }
  enableShared(confirmationId?: string) {
    return this.exclusive(() => this.enable(confirmationId));
  }
  private async enable(confirmationId?: string) {
    const binding = this.requireBinding();
    const selected = this.isSharedSelected();
    if (selected && this.shared) return;
    const state = this.profile.migrationState;
    requireValue(
      selected || state === "export-ready" || state === "import-ready",
      "migration-not-ready",
    );
    confirmationId ??=
      this.profile.operation?.kind === "enable-shared"
        ? this.profile.operation.confirmationId
        : undefined;
    const broker = await this.boundClient(binding);
    try {
      await this.barrier(async () => {
        if (!selected) {
          requireValue(
            !this.profile.operation || this.profile.operation.kind === "enable-shared",
            "operation-in-progress",
          );
          await this.checkReview(binding, broker, confirmationId);
          this.save({
            operation: this.profile.operation ?? {
              ...this.allocate("enable-shared", binding.vaultDirectory, binding.clientId),
              confirmationId,
            },
          });
        }
        await this.activate(binding, broker);
        if (!selected) {
          let privateSnapshot = binding.privateSnapshot;
          // The original private source can be used offline only if it matches the complete current grant.
          if (
            binding.exportOperationId &&
            binding.privateBaseline &&
            canonical(privateBaseline(this.options.storage)) === canonical(binding.privateBaseline)
          ) {
            const watermark = await snapshotWatermark(broker, binding);
            const descriptions = await broker.listCredentials();
            if (
              binding.sharedBaseline &&
              canonical(
                Object.fromEntries(descriptions.map((d) => [d.credentialId, d.revision])),
              ) === canonical(binding.sharedBaseline)
            ) {
              const records = await readCurrentRecords(broker, descriptions);
              const snapshot = await protectManifest(
                binding,
                {
                  at: binding.snapshotAt ?? new Date().toISOString(),
                  watermark,
                  records: records.map((r) => {
                    const decoded = decodeSharedCredential(r);
                    return {
                      id: r.description.credentialId,
                      digest: hash([decoded.account, decoded.credentials]),
                    };
                  }),
                },
                this.options.cipher,
              );
              const vault = new CredentialVault(this.options.storage, this.options.cipher);
              await verifyPrivateSnapshot(snapshot, this.options.storage, (id) => vault.load(id));
              if ((await snapshotWatermark(broker, binding)) === watermark)
                privateSnapshot = snapshot;
            }
          }
          await this.checkReview(binding, broker, confirmationId);
          this.save({
            selectedBackend: "shared",
            migrationState: "shared",
            operation: undefined,
            binding: { ...binding, privateSnapshot },
          });
        }
      });
    } catch (error) {
      broker.close();
      if (selected) this.selectUnavailable(binding);
      else {
        if (this.options.switcher.isShared) this.selectPrivate();
        if (this.profile.operation?.kind === "enable-shared") this.save({ operation: undefined });
      }
      throw error;
    }
  }
  returnToPrivate(acceptIndependentRefreshRisk: boolean, offlineSnapshotAt?: string) {
    return this.exclusive(async () => {
      requireValue(acceptIndependentRefreshRisk === true, "independent-refresh-risk-not-accepted");
      requireValue(this.isSharedSelected(), "shared-not-selected");
      const binding = this.requireBinding();
      const snapshot = await this.barrier(async () => {
        this.save({
          operation:
            this.profile.operation?.kind === "prepare-private"
              ? this.profile.operation
              : this.allocate("prepare-private", binding.vaultDirectory, binding.clientId),
        });
        let broker: SharedBrokerClient | undefined;
        try {
          broker = await this.boundClient(binding);
          return await preparePrivateSnapshot(
            binding,
            broker,
            this.options.storage,
            this.options.cipher,
            this.requireOperation("prepare-private").id,
          );
        } catch (error) {
          if (offline(error)) this.selectUnavailable(binding);
          if (
            !offline(error) &&
            (!(error instanceof BrokerError) || error.code !== "key-cache-unavailable")
          )
            throw error;
          const receipt = await privateSnapshotReceipt(
            binding,
            this.options.storage,
            this.options.cipher,
          );
          const snapshot =
            receipt?.clientId === binding.clientId ? receipt.snapshot : binding.privateSnapshot;
          if (!snapshot) throw error;
          if (error instanceof BrokerError && error.code === "key-cache-unavailable")
            await this.checkSnapshotWatermark(binding, snapshot);
          else if (offline(error)) await verifyManifest(binding, snapshot, this.options.cipher);
          else throw error;
          requireValue(offlineSnapshotAt === snapshot.at, "confirm-offline-snapshot");
          const vault = new CredentialVault(this.options.storage, this.options.cipher);
          await verifyPrivateSnapshot(snapshot, this.options.storage, (id) => vault.load(id));
          return snapshot;
        } finally {
          broker?.close();
        }
      });
      const managedIds = [
        ...new Set([...(binding.managedIds ?? []), ...snapshot.records.map((r) => r.id)]),
      ];
      this.save({
        operation: undefined,
        migrationState: "private-ready",
        binding: { ...binding, managedIds, privateSnapshot: snapshot },
      });
      this.contextId = randomUUID();
    });
  }
  switchToPrivate() {
    return this.exclusive(async () => {
      if (this.profile.migrationState === "private") {
        await this.cleanup();
        return;
      }
      const binding = this.requireBinding();
      const snapshot = binding.privateSnapshot;
      requireValue(
        this.profile.migrationState === "private-ready" && snapshot,
        "private-snapshot-required",
      );
      await this.barrier(async () => {
        const intent = this.profile.operation;
        this.save({
          operation:
            intent?.kind === "switch-private"
              ? intent
              : this.allocate("switch-private", binding.vaultDirectory, binding.clientId),
        });
        try {
          await this.checkSnapshotWatermark(binding, snapshot);
          this.selectPrivate();
          await verifyPrivateSnapshot(snapshot, this.options.storage, (id) =>
            this.options.switcher.load(id),
          );
          const ids = new Set(snapshot.records.map((record) => record.id));
          for (const id of binding.managedIds ?? [])
            requireValue(
              ids.has(id) || !this.options.storage.accounts.get(id),
              "private-snapshot-readback-failed",
            );
          const cleanup = [
            ...(this.profile.cleanup ?? []),
            {
              clientId: binding.clientId,
              vaultDirectory: binding.vaultDirectory,
              vaultId: binding.version.vaultId,
              keyRef: binding.keyRef,
              keyCleanupPending: true,
              sessionCleanupPending: true,
            },
          ];
          this.save({
            operation: undefined,
            migrationState: "private",
            selectedBackend: "private",
            binding: null,
            cleanup,
            previousDirectory: binding.vaultDirectory,
          });
        } catch (error) {
          if (!this.shared) {
            this.selectUnavailable(binding);
            try {
              const active = await this.boundClient(binding);
              try {
                await this.activate(binding, active);
              } catch (error) {
                active.close();
                throw error;
              }
            } catch {
              this.selectUnavailable(binding);
            }
          }
          this.save({ operation: undefined });
          throw error;
        }
      });
      await this.cleanup();
    });
  }
  private async cleanup() {
    const tasks = this.profile.cleanup;
    if (!tasks?.length) return;
    // Reload the committed receipt before deleting anything after a local switch.
    const durable = readMigrationProfile(
      this.options.cacheDirectory,
      this.options.product,
      this.options.storage,
    );
    const remaining = [];
    for (const task of tasks) {
      requireValue(
        durable.cleanup?.some(
          (row) => row.clientId === task.clientId && row.keyRef === task.keyRef,
        ) &&
          durable.binding?.keyRef !== task.keyRef &&
          durable.binding?.clientId !== task.clientId,
        "cleanup-generation-mismatch",
      );
      const next = { ...task };
      if (next.sessionCleanupPending) {
        try {
          await this.options.host.revokeGrant?.(task.vaultDirectory, task.vaultId, task.clientId);
          next.sessionCleanupPending = false;
        } catch {
          /* Offline grants are retried independently of the local key. */
        }
      }
      if (next.keyCleanupPending) {
        try {
          await this.options.host.forgetGrant?.(task.vaultId, task.clientId);
          await rm(keyFile(this.options.cacheDirectory, task.keyRef), { force: true });
          next.keyCleanupPending = false;
        } catch {
          /* Keep this generation's receipt for a later retry. */
        }
      }
      if (next.keyCleanupPending || next.sessionCleanupPending) remaining.push(next);
    }
    this.save({ cleanup: remaining.length ? remaining : undefined });
  }
  relocate(directory: string) {
    return this.exclusive(async () => {
      const binding = this.requireBinding();
      requireValue(!this.profile.operation, "operation-in-progress");
      directory = await this.directory(directory, false);
      if (samePath(directory, binding.vaultDirectory)) return;
      const next = { ...binding, vaultDirectory: directory };
      await this.verifyLocation(next);
      await this.options.host.relocateVault?.(
        binding.vaultDirectory,
        directory,
        binding.version.vaultId,
        binding.version.storageVersion,
      );
      const client = await this.boundClient(next);
      client.close();
      this.save({ binding: next });
      if (this.isSharedSelected()) {
        this.selectUnavailable(next);
        await this.enable();
      }
      this.contextId = randomUUID();
    });
  }
  selectDirectory() {
    return this.options.selectDirectory?.() ?? Promise.resolve(null);
  }
  setChangedHandler(handler: () => void) {
    this.options.changed = handler;
  }
  install() {
    return this.exclusive(() => this.options.host.install());
  }
  uninstall() {
    return this.exclusive(async () => {
      await this.options.host.uninstall();
      if (this.isSharedSelected()) this.selectUnavailable(this.requireBinding());
    });
  }
  isSharedSelected() {
    return this.profile.selectedBackend === "shared";
  }
  private get activeBackend(): "private" | "shared" | "unavailable" {
    return this.options.switcher.isShared ? (this.shared ? "shared" : "unavailable") : "private";
  }
  getBackendContext(): BackendContext {
    return {
      contextId: this.contextId,
      selected: this.profile.selectedBackend,
      active: this.activeBackend,
    };
  }
  visibleAccountIds() {
    return this.isSharedSelected() ? this.visible : null;
  }
  visibleUsageAccountIds() {
    return this.isSharedSelected() ? this.visibleUsage : null;
  }
  private operationStep(op: MigrationOperation): string {
    switch (op.kind) {
      case "export":
        return op.version
          ? "核验已发布版本与本端钥槽"
          : op.recordDigest
            ? "核对导出发布回执"
            : "准备内置凭据快照";
      case "import":
        return this.pending ? "等待确认导入" : "等待验证迁移密钥";
      case "enable-shared":
        return "正在核对迁移到共享的结果";
      case "prepare-private":
        return "核验并写入内置快照";
      case "switch-private":
        return "正在核对切换到内置的结果";
    }
  }
  async getStatus(): Promise<CredentialManagementStatus> {
    const { host } = this.options;
    const installation = await host.inspect();
    const view = this.profile;
    const { binding, operation, migrationState, selectedBackend, cleanup } = view;
    let rememberedKey = false;
    if (binding) {
      try {
        await this.readKey(binding);
        rememberedKey = true;
      } catch {
        /* Report missing protection separately from the committed state. */
      }
    } else
      rememberedKey = !!cleanup?.some(
        (task) =>
          task.keyCleanupPending && existsSync(keyFile(this.options.cacheDirectory, task.keyRef)),
      );
    const runtime =
      binding && installation.installState === "installed"
        ? await host.status?.(binding.vaultDirectory).catch(() => undefined)
        : undefined;
    const available = await this.options.cipher.isAvailable();
    if (this.profile !== view) return this.getStatus();
    const readiness = !available
      ? "系统凭据保护不可用"
      : installation.installState !== "installed"
        ? "请先安装兼容的共享组件"
        : this.operation
          ? "本端操作正在执行"
          : null;
    const capability = (
      allowed: boolean,
      reason: string | null = readiness,
    ): { state: "enabled" } | { state: "disabled"; reason: string } =>
      allowed && !reason
        ? { state: "enabled" }
        : { state: "disabled", reason: reason ?? "当前迁移状态不支持此操作" };
    const ready = migrationState === "export-ready" || migrationState === "import-ready";
    const delivery = !!binding?.exportOperationId && !binding.deliveryAcknowledged;
    return {
      ...installation,
      requiredApiLevel: BROKER_COMPATIBILITY.requiredApiLevel,
      available,
      role: "both",
      privateAvailable: available,
      localPackageDirectory: host.localPackageDirectory,
      localPackageState: (await host.inspectPackage?.()) ?? "unknown",
      downloadState: "not-configured",
      directorySelectionAvailable: !!this.options.selectDirectory,
      serviceState: runtime?.serviceState ?? "NOT_CHECKED",
      brokerOwnership: runtime?.brokerOwnership ?? "NOT_CHECKED",
      migrationState,
      selectedBackend,
      activeBackend:
        this.activeBackend === "private" && !available ? "unavailable" : this.activeBackend,
      vaultDirectory:
        binding?.vaultDirectory ??
        operation?.vaultDirectory ??
        this.profile.previousDirectory ??
        null,
      storageVersion: binding?.version.storageVersion ?? null,
      recordCount:
        migrationState === "private-ready"
          ? (binding?.privateSnapshot?.records.length ?? 0)
          : this.shared
            ? this.recordCount
            : (binding?.recordCount ?? 0),
      snapshotAt:
        binding?.privateSnapshot?.at ??
        (migrationState === "export-ready" ? binding?.snapshotAt : null) ??
        null,
      rememberedKey,
      frozen: this.options.mutations.isFrozen,
      deliveryAcknowledged: binding?.deliveryAcknowledged ?? false,
      connected: !!this.shared,
      accounts: this.shared ? this.previews : (binding?.accounts ?? []),
      lastError: this.lastError,
      keyCleanupPending: !!cleanup?.some((t) => t.keyCleanupPending),
      sessionCleanupPending: !!cleanup?.some((t) => t.sessionCleanupPending),
      operation: operation
        ? {
            id: operation.id,
            kind: operation.kind,
            vaultDirectory: operation.vaultDirectory,
            step: this.operationStep(operation),
          }
        : null,
      migrationReview: this.review,
      ...(this.pending && this.pending.expiresAt > Date.now()
        ? { importPreview: this.pending.preview }
        : {}),
      capabilities: {
        recoverDelivery: capability(delivery),
        resumeExport: capability(delivery),
        exportCredentials: capability(
          migrationState === "private" && (!operation || operation.kind === "export"),
        ),
        verifyImport: capability(
          (!binding || !rememberedKey) && (!operation || operation.kind === "import"),
        ),
        confirmImport: capability(!!this.pending),
        enableShared: capability(ready),
        returnToPrivate: capability(
          this.isSharedSelected() && (!!this.shared || !!binding?.privateSnapshot),
          available ? null : "系统凭据保护不可用",
        ),
        switchToPrivate: capability(
          migrationState === "private-ready",
          available ? null : "系统凭据保护不可用",
        ),
      },
    };
  }
  retry() {
    return this.exclusive(async () => {
      if (this.profile.cleanup?.length) await this.cleanup();
      if (this.isSharedSelected() || this.profile.operation?.kind === "enable-shared")
        await this.enable();
    });
  }
  private watch() {
    clearTimeout(this.watcher);
    if (this.stopped || !this.isSharedSelected()) return;
    this.watcher = setTimeout(() => {
      this.syncing = this.poll()
        .catch((error) => {
          this.lastError = error instanceof BrokerError ? error.code : "shared-sync-unavailable";
          this.selectUnavailable(this.requireBinding());
          this.options.changed?.();
        })
        .finally(() => {
          this.syncing = undefined;
          if (!this.operation) this.watch();
        });
    }, 3000);
    this.watcher.unref();
  }
  private async poll() {
    if (!this.shared || !this.broker) {
      await this.enable();
      this.options.changed?.();
      return;
    }
    const page = await this.broker.getEvents(this.cursor);
    if (page.items.length) {
      for (const event of page.items)
        this.shared.invalidate(
          event.credentialId,
          event.kind === "credentialDeleted" ? undefined : event.revision,
        );
      await this.synchronize(this.shared, this.broker);
      this.options.changed?.();
    }
    this.cursor = page.nextCursor;
  }
  async start() {
    this.stopped = false;
    if (!existsSync(path.join(this.options.cacheDirectory, "migration-state.json")))
      this.persist(this.profile);
    if (this.profile.cleanup?.length) await this.cleanup();
    const binding = this.profile.binding;
    const intent = this.profile.operation;
    if (binding && intent?.kind === "prepare-private") {
      try {
        const receipt = await privateSnapshotReceipt(
          binding,
          this.options.storage,
          this.options.cipher,
        );
        if (receipt && receipt.operationId === intent.id && receipt.clientId === binding.clientId) {
          const vault = new CredentialVault(this.options.storage, this.options.cipher);
          await verifyPrivateSnapshot(receipt.snapshot, this.options.storage, (id) =>
            vault.load(id),
          );
          const managedIds = [
            ...new Set([
              ...(binding.managedIds ?? []),
              ...receipt.snapshot.records.map((r) => r.id),
            ]),
          ];
          this.save({
            operation: undefined,
            migrationState: "private-ready",
            binding: { ...binding, managedIds, privateSnapshot: receipt.snapshot },
          });
        }
      } catch {
        this.lastError = "private-snapshot-readback-failed";
      }
    } else if (intent?.kind === "switch-private" && this.profile.migrationState === "private-ready")
      this.save({ operation: undefined });
    if (this.isSharedSelected() || this.profile.operation?.kind === "enable-shared") {
      try {
        await this.enableShared();
      } catch {
        /* The committed selection stays visible; reconnect on demand or polling. */
      }
    }
    this.watch();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.watcher);
    await Promise.allSettled([this.operation, this.syncing]);
    this.clearPreview();
    this.shared?.dispose();
    this.broker?.close();
    this.broker = undefined;
    this.shared = undefined;
  }
}
