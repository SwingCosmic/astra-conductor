import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  CredentialVault,
  SharedCredentialService,
  type SwitchingCredentialService,
  type CredentialService,
  type CredentialCipherPort,
  type CredentialMutationGate,
  type StoragePort,
  type ProviderRegistry,
  type Account,
  type EncryptedCredential,
} from "@astra-conductor/core/internal";
import {
  BrokerError,
  BROKER_COMPATIBILITY,
  canonical,
  hash,
  id,
  object,
  parseJson,
  requireValue,
  text,
  unpackTransfer,
  SharedBrokerClient,
  type ExportVersion,
  type InitialRecord,
} from "@astra-conductor/credentials";
import type {
  CredentialSharingStatus,
  CredentialExportDelivery,
  CredentialManagementStatus,
} from "@astra-conductor/contract/polyquota";
import type { BrokerHost, BrokerConnection } from "../../platform/common/credential-broker-host.js";

export const sharingStateKey = "credentialSharing.export.v1";
export const sharingFrozenKey = "credentialSharing.frozen";
export const sharingHistoryKey = "credentialSharing.exportHistory.v1";
const sharingErrorMessages: Record<string, string> = {
  "component-incompatible": `凭据共享服务不满足要求，请安装支持 API level ${BROKER_COMPATIBILITY.requiredApiLevel} 及以上且通信协议兼容的组件`,
  "protocol-incompatible": "正在运行的凭据共享服务通信协议不兼容，请安装协议兼容的组件",
  "api-incompatible": `凭据共享服务功能不足，需要 API level ${BROKER_COMPATIBILITY.requiredApiLevel} 及以上`,
  "invalid-component-version": "组件版本信息不是有效的 SemVer，请检查组件包元数据",
  "method-not-found": "已安装的凭据共享服务缺少当前版本需要的接口，请重新安装新版本地组件后再验证",
  "directory-permissions-too-broad": "已安装的旧版组件仍限制目录权限，请重新安装新版本地组件",
  "vault-directory-not-empty": "首次导出请选择空目录，已有导出请使用原导出记录恢复",
  "invalid-vault-directory": "请选择可用的本地文件夹",
  "access-denied": "系统拒绝写入共享文件，请更新或重新安装凭据共享组件后重试原导出",
  "client-not-prepared":
    "本次导出尚未有接收方完成准备，请在接收应用核对本次导出目录，并点击“确认导入”后重试启用共享",
  "source-watermark-changed": "内置凭据已更新，无法继续使用原导出快照，请重新导出到新的空目录",
  "export-recovery-unavailable": "当前状态不支持恢复已取消的导出",
  "export-restart-unavailable": "当前状态不支持重新导出，请先取消未完成的共享切换",
  "ownership-already-transferred": "共享凭据已由服务接管，不能恢复旧导出或重新导出私有副本",
  "new-export-directory-required": "重新导出请选择新的空目录，原导出目录会保留",
  "authorization-in-progress": "请先完成或取消当前账号授权，再操作凭据导出",
};
interface ExportState {
  state: CredentialSharingStatus["exportState"];
  vaultDirectory: string;
  clientId: string;
  instanceId: string;
  operationId: string;
  sourceWatermark: string;
  requestHash: string;
  version?: ExportVersion;
  recordCount: number;
  keyRef?: string;
  deliveryAcknowledged: boolean;
  selectedBackend?: "private" | "shared";
  sharingState?: CredentialSharingStatus["sharingState"];
  handoffOperationId?: string;
  requiredClientIds?: string[];
  snapshotAt?: string;
  keyCleanupPending?: boolean;
  sessionCleanupPending?: boolean;
  sharedAccountIds?: string[];
}
export interface SharingOptions {
  storage: StoragePort;
  credentials: CredentialService;
  cipher: CredentialCipherPort;
  mutations: CredentialMutationGate;
  providers: ProviderRegistry;
  host: BrokerHost;
  cacheDirectory: string;
  privateDataDirectory?: string;
  hasActiveAuth(): boolean;
  selectDirectory?(): Promise<string | null>;
  switcher?: SwitchingCredentialService;
  changed?(): void;
}
export class CredentialSharingService {
  private backendFingerprint = "";
  private backendContextId = randomUUID();
  private busy = false;
  private lastError: string | null = null;
  private shared?: SharedCredentialService;
  private broker?: SharedBrokerClient;
  private syncTimer?: ReturnType<typeof setTimeout>;
  private syncing?: Promise<void>;
  private stopped = false;
  private syncPaused = false;
  private eventCursor = "0";
  constructor(private readonly options: SharingOptions) {}
  setChangedHandler(handler: () => void): void {
    this.options.changed = handler;
  }
  private readState(): ExportState | null {
    const value = this.options.storage.settings.get(sharingStateKey);
    if (value === null) return null;
    requireValue(typeof value === "string", "invalid-export-state");
    const state = object(parseJson(Buffer.from(value)));
    requireValue(
      ["preparing", "pending", "exported", "cancelled"].includes(text(state.state)),
      "invalid-export-state",
    );
    id(state.clientId);
    id(state.instanceId);
    id(state.operationId);
    requireValue(path.isAbsolute(text(state.vaultDirectory)), "invalid-export-state");
    return state as unknown as ExportState;
  }
  private save(state: ExportState): void {
    this.options.storage.settings.save(
      sharingStateKey,
      JSON.stringify(state),
      new Date().toISOString(),
    );
  }
  private frozen(value: boolean): void {
    this.options.storage.settings.save(sharingFrozenKey, value, new Date().toISOString());
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new AppError("conflict", "凭据共享操作正在执行");
    this.busy = true;
    this.lastError = null;
    try {
      return await operation();
    } catch (error) {
      this.lastError =
        error instanceof BrokerError
          ? error.code
          : error instanceof AppError
            ? error.code
            : "sharing-operation-failed";
      if (error instanceof AppError) throw error;
      throw new AppError(
        "service-unavailable",
        `${sharingErrorMessages[this.lastError] ?? "凭据共享操作未完成，可重新检查后重试"}（${this.lastError}）`,
        true,
      );
    } finally {
      this.busy = false;
      this.options.changed?.();
    }
  }
  private async requireCompatibleInstallation(): Promise<void> {
    const installation = await this.options.host.inspect();
    requireValue(installation.installState !== "incompatible", "component-incompatible");
    requireValue(installation.installState === "installed", "component-not-installed");
  }
  async getStatus(): Promise<CredentialManagementStatus> {
    const state = this.readState();
    const installation = await this.options.host.inspect();
    let rememberedKey = false;
    if (state?.keyRef && state.version) {
      try {
        await this.loadKey(state);
        rememberedKey = true;
      } catch {
        /* A missing cache is not a successful export prerequisite. */
      }
    }
    const runtime =
      state && installation.installState === "installed" && this.options.host.status
        ? await this.options.host.status(state.vaultDirectory)
        : { serviceState: "NOT_CHECKED", brokerOwnership: "NOT_CHECKED" };
    const available = await this.options.cipher.isAvailable();
    const privateSelected = state?.selectedBackend !== "shared";
    const cancelled = state?.state === "cancelled" && privateSelected;
    const readiness = !available
      ? "当前宿主的系统凭据保护不可用"
      : installation.installState !== "installed"
        ? "请先安装兼容的凭据共享组件"
        : this.busy
          ? "凭据共享操作正在执行"
          : this.options.hasActiveAuth()
            ? "请先完成或取消当前账号授权"
            : runtime.brokerOwnership === "broker"
              ? sharingErrorMessages["ownership-already-transferred"]
              : null;
    const resumeReason = !cancelled
      ? "当前没有已取消的导出"
      : (readiness ??
        (state.deliveryAcknowledged && !rememberedKey
          ? "原导出主密钥缓存不可用，请重新导出到新的空目录"
          : null) ??
        (state.sourceWatermark !== this.privateWatermark()
          ? sharingErrorMessages["source-watermark-changed"]
          : null));
    const restartReason = !cancelled ? "请先取消未完成的共享切换" : readiness;
    const availability = (reason: string | null) =>
      reason ? { state: "disabled" as const, reason } : { state: "enabled" as const };
    return {
      ...installation,
      requiredApiLevel: BROKER_COMPATIBILITY.requiredApiLevel,
      ...runtime,
      available,
      role: "source",
      privateAvailable: available,
      capabilities: {
        resumeExport: availability(resumeReason),
        restartExport: availability(restartReason),
      },
      localPackageDirectory: this.options.host.localPackageDirectory,
      downloadState: "not-configured",
      localPackageState: (await this.options.host.inspectPackage?.()) ?? "unknown",
      directorySelectionAvailable: !!this.options.selectDirectory,
      exportState: state?.state ?? "none",
      vaultDirectory: state?.vaultDirectory ?? null,
      storageVersion: state?.version?.storageVersion ?? null,
      recordCount: state?.recordCount ?? 0,
      frozen: this.options.storage.settings.get(sharingFrozenKey) === true,
      deliveryAcknowledged: state?.deliveryAcknowledged ?? false,
      rememberedKey,
      selectedBackend: state?.selectedBackend ?? "private",
      activeBackend:
        state?.selectedBackend === "shared" ? (this.shared ? "shared" : "unavailable") : "private",
      sharingState: state?.sharingState ?? "none",
      snapshotAt: state?.snapshotAt ?? null,
      keyCleanupPending: state?.keyCleanupPending ?? false,
      sessionCleanupPending: state?.sessionCleanupPending ?? false,
      lastError: this.lastError,
    };
  }
  install(): Promise<void> {
    return this.exclusive(async () => {
      await this.options.host.install();
    });
  }
  private async validateEmptyDirectory(directory: string): Promise<void> {
    requireValue(path.isAbsolute(directory), "invalid-vault-directory");
    try {
      const stat = await lstat(directory);
      requireValue(stat.isDirectory() && !stat.isSymbolicLink(), "invalid-vault-directory");
      requireValue((await readdir(directory)).length === 0, "vault-directory-not-empty");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  selectDirectory(): Promise<string | null> {
    return this.exclusive(async () => {
      const state = this.readState();
      requireValue(
        !state || (state.state === "cancelled" && state.selectedBackend !== "shared"),
        "export-location-fixed",
      );
      if (!this.options.selectDirectory)
        throw new AppError("desktop-unavailable", "当前宿主不提供系统目录选择器");
      const directory = await this.options.selectDirectory();
      if (directory === null) return null;
      await this.validateEmptyDirectory(directory);
      return directory;
    });
  }
  uninstall(): Promise<void> {
    return this.exclusive(async () => {
      await this.options.host.uninstall();
    });
  }
  private privateWatermark(): string {
    return hash(
      this.options.storage.accounts
        .list()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((account) => {
          const encrypted = this.options.storage.credentials.get(account.id);
          return [
            JSON.stringify(account),
            encrypted?.updatedAt ?? null,
            encrypted ? Buffer.from(encrypted.ciphertext).toString("base64url") : null,
          ];
        }),
    );
  }
  private async records(): Promise<{ records: InitialRecord[]; watermark: string }> {
    const { storage, providers } = this.options;
    // Only the source snapshot path calls this method, before ownership is handed off.
    const credentials = new CredentialVault(
      storage,
      this.options.cipher,
      undefined,
      this.options.mutations,
    );
    const accounts = storage.accounts.list().sort((a, b) => a.id.localeCompare(b.id));
    requireValue(accounts.length > 0 && accounts.length <= 1000, "invalid-export-record-count");
    const records: InitialRecord[] = [];
    const versions: unknown[] = [];
    for (const account of accounts) {
      id(account.id);
      const encrypted = storage.credentials.get(account.id);
      requireValue(encrypted, "credential-record-missing");
      const envelope = await credentials.load(account.id);
      versions.push([
        JSON.stringify(account),
        encrypted.updatedAt,
        Buffer.from(encrypted.ciphertext).toString("base64url"),
      ]);
      records.push({
        credentialId: account.id,
        contentType: "application/vnd.astraconductor.account-credential+json",
        payloadFormatVersion: 1,
        payload: Buffer.from(
          JSON.stringify({ version: 1, account, credentials: envelope }),
        ).toString("base64url"),
        metadata: {
          provider: account.provider,
          offeringId: account.offeringId,
          authMethod: account.authMethod,
          maskedIdentifier: account.maskedIdentifier,
          supportsUsage: providers.getUsage(account.provider) ? "true" : "false",
        },
      });
    }
    return { records, watermark: hash(versions) };
  }
  private async loadKey(state: ExportState): Promise<string> {
    requireValue(state.keyRef && state.version, "key-cache-missing");
    requireValue(
      path.basename(state.keyRef) === state.keyRef && /^[a-zA-Z0-9_.-]+$/.test(state.keyRef),
      "invalid-key-reference",
    );
    const decrypted = await this.options.cipher.decrypt(
      await readFile(path.join(this.options.cacheDirectory, state.keyRef)),
    );
    const value = object(parseJson(Buffer.from(decrypted.plaintext)), ["version", "masterKey"]);
    requireValue(canonical(value.version) === canonical(state.version), "key-cache-mismatch");
    const key = text(value.masterKey);
    requireValue(/^[a-zA-Z0-9_-]{43}$/.test(key), "key-cache-mismatch");
    return key;
  }
  private async rememberKey(state: ExportState, masterKey: string): Promise<void> {
    requireValue(state.version);
    const keyRef = `${state.version.vaultId}.${state.version.storageVersion}.${state.version.keyId}.key`;
    const filename = path.join(this.options.cacheDirectory, keyRef);
    await mkdir(this.options.cacheDirectory, { recursive: true });
    const encrypted = await this.options.cipher.encrypt(
      JSON.stringify({ version: state.version, masterKey }),
    );
    const staged = `${filename}.${randomUUID()}.next`;
    try {
      await writeFile(staged, encrypted, { mode: 0o600, flag: "wx" });
      await rename(staged, filename);
    } finally {
      await rm(staged, { force: true });
    }
    state.keyRef = keyRef;
    requireValue((await this.loadKey(state)) === masterKey, "key-readback-failed");
  }
  async exportCredentials(vaultDirectory: string): Promise<CredentialExportDelivery> {
    return this.exclusive(() => this.performExport(vaultDirectory));
  }
  private async performExport(vaultDirectory: string): Promise<CredentialExportDelivery> {
    const { mutations, cipher, host } = this.options;
    requireValue(path.isAbsolute(vaultDirectory), "invalid-vault-directory");
    if (this.options.privateDataDirectory) {
      const source = path.resolve(this.options.privateDataDirectory);
      const target = path.resolve(vaultDirectory);
      const contains = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return (
          relative === "" ||
          (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
        );
      };
      requireValue(
        !contains(source, target) && !contains(target, source),
        "overlapping-product-and-vault-paths",
      );
    }
    requireValue(await cipher.isAvailable(), "secure-storage-unavailable");
    await this.requireCompatibleInstallation();
    let state = this.readState();
    if (state) {
      requireValue(state.state !== "cancelled", "export-cancelled");
      requireValue(
        path.resolve(vaultDirectory).toLowerCase() ===
          path.resolve(state.vaultDirectory).toLowerCase(),
        "export-location-fixed",
      );
      requireValue(!state.deliveryAcknowledged, "migration-key-already-delivered");
    } else {
      await this.validateEmptyDirectory(vaultDirectory);
      requireValue(!this.options.hasActiveAuth(), "authorization-in-progress");
      state = {
        state: "preparing",
        vaultDirectory: path.resolve(vaultDirectory),
        clientId: `polyquota-${randomUUID()}`,
        instanceId: randomUUID(),
        operationId: randomUUID(),
        sourceWatermark: "",
        requestHash: "",
        recordCount: 0,
        deliveryAcknowledged: false,
      };
      this.options.storage.transaction(() => {
        this.save(state!);
        this.frozen(true);
      });
    }
    await mutations.freeze();
    requireValue(!this.options.hasActiveAuth(), "authorization-in-progress");
    const snapshot = await this.records();
    if (state.sourceWatermark)
      requireValue(snapshot.watermark === state.sourceWatermark, "source-watermark-changed");
    const request = {
      operationId: state.operationId,
      sourceWatermark: snapshot.watermark,
      records: snapshot.records,
    };
    if (state.requestHash)
      requireValue(hash(request) === state.requestHash, "source-snapshot-changed");
    if (state.state === "preparing") {
      state.sourceWatermark = snapshot.watermark;
      state.requestHash = hash(request);
      state.recordCount = snapshot.records.length;
      state.snapshotAt = new Date().toISOString();
      state.state = "pending";
      this.save(state);
    }
    // Check the complete frame budget before dispatch; no secret request is persisted locally.
    requireValue(
      Buffer.byteLength(
        canonical({
          protocolVersion: 1,
          id: randomUUID(),
          method: "initialize",
          params: request,
        }),
      ) <=
        2 * 1024 * 1024,
      "message-too-large",
    );
    const client = await host.connect(state.vaultDirectory, state.clientId, state.instanceId);
    let migrationKey: string;
    try {
      const service = object(await client.call("status"));
      requireValue(service.ownership !== "broker", "ownership-already-transferred");
      let result: Record<string, unknown>;
      if (service.storageVersion !== null)
        result = object(await client.call("getOperation", { operationId: state.operationId }));
      else result = object(await client.call("initialize", request));
      requireValue(result.state === "exported");
      const version: ExportVersion = {
        vaultId: id(service.vaultId),
        storageVersion: id(result.storageVersion),
        attemptId: id(result.attemptId),
        keyId: id(result.keyId),
      };
      if (state.version)
        requireValue(canonical(version) === canonical(state.version), "export-version-mismatch");
      state.version = version;
      this.save(state);
      migrationKey = result.migrationKey
        ? text(result.migrationKey)
        : text(object(await client.call("recoverDelivery")).migrationKey);
      const directory = path.join(state.vaultDirectory, "versions", version.storageVersion);
      const verified = unpackTransfer(
        await readFile(path.join(directory, "migration.json")),
        migrationKey,
        await readFile(path.join(directory, "version.json")),
        version,
      );
      requireValue(verified.records.length === snapshot.records.length, "export-readback-mismatch");
      const byId = new Map(
        verified.records.map((record) => [record.description.credentialId, record]),
      );
      requireValue(byId.size === verified.records.length, "export-readback-mismatch");
      for (const record of snapshot.records) {
        const actual = byId.get(record.credentialId);
        requireValue(
          actual &&
            actual.description.createdByClientId === state.clientId &&
            actual.description.lastUpdatedByClientId === state.clientId &&
            actual.payload === record.payload &&
            actual.description.contentType === record.contentType &&
            actual.description.payloadFormatVersion === record.payloadFormatVersion &&
            canonical(actual.description.metadata) === canonical(record.metadata),
          "export-readback-mismatch",
        );
      }
      await this.rememberKey(state, verified.masterKey);
      requireValue(
        (await this.records()).watermark === state.sourceWatermark,
        "source-watermark-changed",
      );
      await this.prepare(client, state, verified.masterKey);
      state.state = "exported";
      this.save(state);
      return { migrationKey, storageVersion: version.storageVersion };
    } finally {
      client.close();
    }
  }
  resumeExport(): Promise<CredentialExportDelivery | null> {
    return this.exclusive(async () => {
      const state = this.readState();
      requireValue(
        state?.state === "cancelled" && state.selectedBackend !== "shared",
        "export-recovery-unavailable",
      );
      requireValue(state.version, "export-recovery-unavailable");
      requireValue(await this.options.cipher.isAvailable(), "secure-storage-unavailable");
      await this.requireCompatibleInstallation();
      requireValue(!this.options.hasActiveAuth(), "authorization-in-progress");
      await this.options.mutations.freeze();
      try {
        requireValue(!this.options.hasActiveAuth(), "authorization-in-progress");
        requireValue(this.privateWatermark() === state.sourceWatermark, "source-watermark-changed");
        const client = await this.options.host.connect(
          state.vaultDirectory,
          state.clientId,
          state.instanceId,
        );
        try {
          const info = await this.sharingInfo(client, state);
          requireValue(info.ownership === "source", "ownership-already-transferred");
          let delivery: CredentialExportDelivery | null = null;
          let masterKey: string;
          if (state.deliveryAcknowledged) masterKey = await this.loadKey(state);
          else {
            const migrationKey = text(object(await client.call("recoverDelivery")).migrationKey);
            const directory = path.join(
              state.vaultDirectory,
              "versions",
              state.version!.storageVersion,
            );
            const verified = unpackTransfer(
              await readFile(path.join(directory, "migration.json")),
              migrationKey,
              await readFile(path.join(directory, "version.json")),
              state.version!,
            );
            await this.rememberKey(state, verified.masterKey);
            masterKey = verified.masterKey;
            delivery = { migrationKey, storageVersion: state.version!.storageVersion };
          }
          await this.prepare(client, state, masterKey);
          state.state = "exported";
          state.selectedBackend = "private";
          state.sharingState = "none";
          this.options.storage.transaction(() => {
            this.save(state);
            this.frozen(true);
          });
          return delivery;
        } finally {
          client.close();
        }
      } catch (error) {
        this.options.mutations.resume();
        this.frozen(false);
        throw error;
      }
    });
  }
  restartExport(vaultDirectory: string): Promise<CredentialExportDelivery> {
    return this.exclusive(async () => {
      const previous = this.readState();
      requireValue(
        previous?.state === "cancelled" && previous.selectedBackend !== "shared",
        "export-restart-unavailable",
      );
      requireValue(
        path.resolve(vaultDirectory).toLowerCase() !==
          path.resolve(previous.vaultDirectory).toLowerCase(),
        "new-export-directory-required",
      );
      requireValue(await this.options.cipher.isAvailable(), "secure-storage-unavailable");
      await this.requireCompatibleInstallation();
      await this.validateEmptyDirectory(vaultDirectory);
      requireValue(!this.options.hasActiveAuth(), "authorization-in-progress");
      await this.options.mutations.freeze();
      try {
        requireValue(!this.options.hasActiveAuth(), "authorization-in-progress");
        const client = await this.options.host.connect(
          previous.vaultDirectory,
          previous.clientId,
          previous.instanceId,
        );
        try {
          const current = object(await client.call("status"));
          requireValue(
            current.ownership === "source" || current.ownership === "uninitialized",
            "ownership-already-transferred",
          );
        } finally {
          client.close();
        }
        const historyValue = this.options.storage.settings.get(sharingHistoryKey);
        requireValue(
          historyValue === null || typeof historyValue === "string",
          "invalid-export-history",
        );
        const history: unknown = historyValue === null ? [] : JSON.parse(historyValue as string);
        requireValue(Array.isArray(history), "invalid-export-history");
        this.options.storage.transaction(() => {
          const now = new Date().toISOString();
          this.options.storage.settings.save(
            sharingHistoryKey,
            JSON.stringify([...history, { archivedAt: now, state: previous }]),
            now,
          );
          this.options.storage.settings.save(sharingStateKey, null, now);
          this.frozen(false);
        });
        return await this.performExport(vaultDirectory);
      } catch (error) {
        if (!this.readState()) this.save(previous);
        if (this.readState()?.state === "cancelled") {
          this.options.mutations.resume();
          this.frozen(false);
        }
        throw error;
      }
    });
  }
  private async prepare(
    client: BrokerConnection,
    state: ExportState,
    masterKey: string,
  ): Promise<void> {
    const { createHmac } = await import("node:crypto");
    const challenge = object(await client.call("prepareChallenge"));
    requireValue(state.version);
    const bytes = Buffer.from(masterKey, "base64url");
    try {
      const operationId = randomUUID();
      const proof = createHmac("sha256", bytes)
        .update(
          canonical([
            "astra.prepare.v1",
            state.version.vaultId,
            state.version.storageVersion,
            state.clientId,
            operationId,
            state.sourceWatermark,
            id(challenge.challengeId),
            text(challenge.nonce),
          ]),
        )
        .digest("base64url");
      await client.call("prepareClient", {
        operationId,
        sourceWatermark: state.sourceWatermark,
        challengeId: challenge.challengeId,
        proof,
      });
    } finally {
      bytes.fill(0);
    }
  }
  /** Restore selection before the scheduler starts. A failed shared connection never falls back. */
  async start(): Promise<void> {
    this.stopped = false;
    const state = this.readState();
    if (!state) return;
    if (state.selectedBackend === "private" && state.sharingState === "returning") {
      this.options.switcher?.usePrivate();
      this.frozen(false);
      this.options.mutations.resume();
      await this.cleanupPrivate(state);
    } else if (state.selectedBackend === "shared") {
      this.options.switcher?.useUnavailable();
      try {
        await this.enableShared();
      } catch {
        // Keep the durable selection and freeze. The explicit retry recovers the same handoff.
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.syncPaused = true;
    clearTimeout(this.syncTimer);
    await this.syncing;
    this.shared = undefined;
    this.broker?.close();
    this.broker = undefined;
  }
  isSharedSelected(): boolean {
    return this.readState()?.selectedBackend === "shared";
  }
  /** Opaque backend identity; UI commands cannot follow a handoff to a different vault. */
  getBackendContext(): import("@astra-conductor/contract/common").BackendContext {
    const state = this.readState();
    const selected = state?.selectedBackend === "shared" ? "shared" : "private";
    const active = selected === "private" ? "private" : this.shared ? "shared" : "unavailable";
    const fingerprint = JSON.stringify(
      selected === "shared"
        ? [selected, active, state?.version?.vaultId, state?.version?.storageVersion]
        : [selected, active],
    );
    if (fingerprint !== this.backendFingerprint) {
      this.backendFingerprint = fingerprint;
      this.backendContextId = randomUUID();
    }
    return { contextId: this.backendContextId, selected, active };
  }
  visibleAccountIds(): ReadonlySet<string> | null {
    const state = this.readState();
    return state?.selectedBackend === "shared" ? new Set(state.sharedAccountIds ?? []) : null;
  }
  private async connection(state: ExportState): Promise<BrokerConnection> {
    await this.requireCompatibleInstallation();
    await this.loadKey(state);
    return this.options.host.connect(state.vaultDirectory, state.clientId, state.instanceId);
  }
  private async sharingInfo(client: BrokerConnection, state: ExportState) {
    const info = object(await client.call("getSharingState"));
    requireValue(
      state.version && Object.entries(state.version).every(([key, value]) => info[key] === value),
      "export-version-mismatch",
    );
    requireValue(info.sourceWatermark === state.sourceWatermark, "source-watermark-changed");
    requireValue(Array.isArray(info.preparedClientIds), "invalid-sharing-state");
    return {
      ownership: text(info.ownership),
      preparedClientIds: info.preparedClientIds.map((value) => id(value)),
    };
  }
  enableShared(): Promise<void> {
    return this.exclusive(async () => {
      await this.requireCompatibleInstallation();
      const state = this.readState();
      requireValue(state?.state === "exported" && state.version, "export-not-ready");
      requireValue(
        state.sharingState !== "private" && state.sharingState !== "returning",
        "migration-key-required",
      );
      requireValue(state.deliveryAcknowledged, "migration-key-not-acknowledged");
      requireValue(this.options.switcher, "shared-backend-unavailable");
      requireValue(!this.options.hasActiveAuth(), "authorization-in-progress");
      await this.options.mutations.freeze();
      const client = await this.connection(state);
      try {
        const info = await this.sharingInfo(client, state);
        if (info.ownership !== "broker") {
          requireValue(
            (await this.records()).watermark === state.sourceWatermark,
            "source-watermark-changed",
          );
          requireValue(
            info.preparedClientIds.includes(state.clientId) && info.preparedClientIds.length >= 2,
            "client-not-prepared",
          );
          state.handoffOperationId ??= randomUUID();
          state.requiredClientIds ??= info.preparedClientIds;
          state.selectedBackend = "shared";
          state.sharingState = "handoff-pending";
          // The original private encrypted records are a usable, dated offline fallback.
          state.snapshotAt ??= this.options.storage.accounts
            .list()
            .map((account) => account.updatedAt)
            .sort()
            .at(-1);
          this.save(state);
          this.frozen(true);
          this.options.switcher.useUnavailable();
          let committed = false;
          try {
            const receipt = object(
              await client.call("getOperation", { operationId: state.handoffOperationId }),
            );
            committed =
              receipt.ownership === "broker" &&
              receipt.storageVersion === state.version.storageVersion;
          } catch (error) {
            if (!(error instanceof BrokerError) || error.code !== "operation-not-found")
              throw error;
          }
          if (!committed) {
            const result = object(
              await client.call("handoff", {
                operationId: state.handoffOperationId,
                sourceWatermark: state.sourceWatermark,
                requiredClientIds: state.requiredClientIds,
              }),
            );
            requireValue(
              result.ownership === "broker" &&
                result.storageVersion === state.version.storageVersion,
              "handoff-result-unknown",
            );
          }
        }
        state.selectedBackend = "shared";
        state.sharingState = "active";
        this.save(state);
        this.options.switcher.useUnavailable();
      } finally {
        client.close();
      }
      await this.activate(state);
    });
  }
  private async activate(state: ExportState): Promise<void> {
    requireValue(this.options.switcher, "shared-backend-unavailable");
    await this.loadKey(state);
    this.syncPaused = true;
    clearTimeout(this.syncTimer);
    await this.syncing;
    this.broker?.close();
    this.broker = undefined;
    this.shared = undefined;
    const broker = new SharedBrokerClient(() => this.connection(state));
    const shared = new SharedCredentialService(broker, {
      storage: this.options.storage,
      providers: this.options.providers,
      usageOnly: true,
    });
    let accounts;
    try {
      accounts = await shared.listAccounts();
    } catch (error) {
      broker.close();
      throw error;
    }
    this.options.storage.transaction(() => {
      for (const account of accounts)
        this.options.storage.accounts.save({
          ...account,
          enabled: this.options.storage.accounts.get(account.id)?.enabled ?? account.enabled,
        });
      state.sharedAccountIds = accounts.map((account) => account.id);
      this.save(state);
      this.frozen(false);
    });
    this.broker = broker;
    this.shared = shared;
    this.eventCursor = "0";
    this.options.switcher.useShared(shared);
    this.options.mutations.resume();
    this.options.changed?.();
    this.syncPaused = false;
    this.scheduleSync();
  }
  private scheduleSync(): void {
    if (this.stopped || this.syncPaused || !this.shared) return;
    this.syncTimer = setTimeout(() => {
      this.syncing = this.syncShared()
        .catch(() => {
          this.lastError = "shared-sync-unavailable";
        })
        .finally(() => {
          this.syncing = undefined;
          this.scheduleSync();
        });
    }, 3_000);
    this.syncTimer.unref?.();
  }
  private async syncShared(): Promise<void> {
    const state = this.readState();
    if (!state || state.selectedBackend !== "shared" || !this.shared || !this.broker) return;
    const page = await this.broker.getEvents(this.eventCursor);
    const next = page.nextCursor;
    // Always refetch current records: duplicate or stale events never restore old payloads.
    if (page.items.length || next !== this.eventCursor) {
      const accounts = await this.shared.listAccounts();
      this.options.storage.transaction(() => {
        for (const account of accounts)
          this.options.storage.accounts.save({
            ...account,
            enabled: this.options.storage.accounts.get(account.id)?.enabled ?? account.enabled,
          });
        state.sharedAccountIds = accounts.map((account) => account.id);
        this.save(state);
      });
      this.options.changed?.();
    }
    this.eventCursor = next;
    this.lastError = null;
  }
  returnToPrivate(acceptIndependentRefreshRisk: boolean): Promise<void> {
    return this.exclusive(async () => {
      requireValue(acceptIndependentRefreshRisk === true, "independent-refresh-risk-not-accepted");
      const state = this.readState();
      requireValue(state && this.options.switcher, "shared-backend-unavailable");
      if (state.selectedBackend === "private" && state.sharingState === "returning") {
        await this.cleanupPrivate(state);
        return;
      }
      requireValue(state.selectedBackend === "shared", "shared-not-selected");
      await this.options.mutations.freeze();
      this.syncPaused = true;
      clearTimeout(this.syncTimer);
      await this.syncing;
      const privateVault = new CredentialVault(this.options.storage, this.options.cipher);
      let snapshotBroker: SharedBrokerClient | undefined;
      try {
        const shared =
          this.shared ??
          new SharedCredentialService(
            (snapshotBroker = new SharedBrokerClient(() => this.connection(state))),
            { providers: this.options.providers, usageOnly: true },
          );
        const accounts = await shared.listAccounts();
        const snapshots: { account: Account; encrypted: EncryptedCredential }[] = [];
        for (const account of accounts) {
          const current = await shared.readAccount(account.id);
          const encrypted = await privateVault.seal(current.account, current.credentials);
          const readback = await this.options.cipher.decrypt(encrypted.ciphertext);
          requireValue(
            canonical(parseJson(Buffer.from(readback.plaintext))) ===
              canonical(current.credentials),
            "private-snapshot-readback-failed",
          );
          snapshots.push({ account: current.account, encrypted });
        }
        this.options.storage.transaction(() => {
          for (const snapshot of snapshots) {
            this.options.storage.accounts.save(snapshot.account);
            this.options.storage.credentials.save(snapshot.encrypted);
            const stored = this.options.storage.credentials.get(snapshot.account.id);
            requireValue(
              stored &&
                Buffer.from(stored.ciphertext).equals(Buffer.from(snapshot.encrypted.ciphertext)),
              "private-snapshot-readback-failed",
            );
          }
        });
        state.snapshotAt = new Date().toISOString();
        this.save(state);
      } catch (error) {
        // Offline switching uses only independently decryptable private copies, with their date.
        if (!state.snapshotAt) {
          this.options.mutations.resume();
          this.syncPaused = false;
          this.scheduleSync();
          throw error;
        }
        let available = 0;
        for (const account of this.options.storage.accounts.list()) {
          try {
            await privateVault.load(account.id);
            available += 1;
          } catch {
            this.options.storage.accounts.setCredentialState(
              account.id,
              "locked",
              new Date().toISOString(),
            );
          }
        }
        if (!available) {
          this.options.mutations.resume();
          this.syncPaused = false;
          this.scheduleSync();
          throw error;
        }
        this.lastError = "using-previous-private-snapshot";
      } finally {
        snapshotBroker?.close();
      }
      state.selectedBackend = "private";
      state.sharingState = "returning";
      state.sessionCleanupPending = true;
      state.keyCleanupPending = true;
      this.options.storage.transaction(() => {
        this.save(state);
        this.frozen(false);
      });
      this.options.switcher.usePrivate();
      this.shared = undefined;
      this.broker?.close();
      this.broker = undefined;
      this.options.mutations.resume();
      this.options.changed?.();
      await this.cleanupPrivate(state);
    });
  }
  private async cleanupPrivate(state: ExportState): Promise<void> {
    if (state.sessionCleanupPending) {
      try {
        const client = await this.options.host.connect(
          state.vaultDirectory,
          state.clientId,
          state.instanceId,
        );
        try {
          await client.call("disconnect");
        } finally {
          client.close();
        }
        state.sessionCleanupPending = false;
      } catch {
        // Only this client's session is affected; the broker expires it after its original TTL.
      }
      this.save(state);
    }
    if (state.keyCleanupPending) {
      try {
        if (state.keyRef) {
          requireValue(path.basename(state.keyRef) === state.keyRef, "invalid-key-reference");
          await rm(path.join(this.options.cacheDirectory, state.keyRef), { force: true });
        }
        delete state.keyRef;
        state.keyCleanupPending = false;
      } catch {
        // Preserve a durable cleanup marker; startup retries without restoring the shared backend.
      }
      this.save(state);
    }
    if (!state.keyCleanupPending && !state.sessionCleanupPending) state.sharingState = "private";
    this.save(state);
  }
  rejoinShared(migrationKey: string): Promise<void> {
    return this.exclusive(async () => {
      await this.requireCompatibleInstallation();
      const state = this.readState();
      requireValue(
        state?.version && ["private", "returning"].includes(state.sharingState ?? ""),
        "shared-reentry-unavailable",
      );
      requireValue(!this.options.hasActiveAuth(), "authorization-in-progress");
      // Validate the original encrypted transfer locally before reconnecting or remembering anything.
      const directory = path.join(state.vaultDirectory, "versions", state.version.storageVersion);
      const verified = unpackTransfer(
        await readFile(path.join(directory, "migration.json")),
        migrationKey,
        await readFile(path.join(directory, "version.json")),
        state.version,
      );
      await this.options.mutations.freeze();
      try {
        const client = await this.options.host.connect(
          state.vaultDirectory,
          state.clientId,
          state.instanceId,
        );
        try {
          requireValue(
            (await this.sharingInfo(client, state)).ownership === "broker",
            "ownership-not-transferred",
          );
          await this.rememberKey(state, verified.masterKey);
          await this.prepare(client, state, verified.masterKey);
          state.selectedBackend = "shared";
          state.sharingState = "active";
          state.keyCleanupPending = false;
          state.sessionCleanupPending = false;
          this.save(state);
          this.frozen(true);
          this.options.switcher?.useUnavailable();
        } finally {
          client.close();
        }
        await this.activate(state);
      } catch (error) {
        if (state.selectedBackend !== "shared") {
          state.keyCleanupPending = true;
          await this.cleanupPrivate(state);
          this.options.mutations.resume();
        }
        throw error;
      }
    });
  }
  acknowledgeDelivery(): Promise<void> {
    return this.exclusive(async () => {
      await this.requireCompatibleInstallation();
      const state = this.readState();
      requireValue(state?.state === "exported", "export-not-ready");
      await this.loadKey(state);
      const client = await this.options.host.connect(
        state.vaultDirectory,
        state.clientId,
        state.instanceId,
      );
      try {
        await client.call("acknowledgeDelivery");
        state.deliveryAcknowledged = true;
        this.save(state);
      } finally {
        client.close();
      }
    });
  }
  cancel(): Promise<void> {
    return this.exclusive(async () => {
      const state = this.readState();
      requireValue(state && state.state !== "cancelled", "export-not-pending");
      // A purely local candidate has never contacted a service and can be cancelled offline.
      if (state.state !== "preparing") {
        const client = await this.options.host.connect(
          state.vaultDirectory,
          state.clientId,
          state.instanceId,
        );
        try {
          const status = object(await client.call("status"));
          requireValue(
            status.ownership === "source" || status.ownership === "uninitialized",
            "ownership-already-transferred",
          );
          if (status.storageVersion !== null) {
            const result = object(
              await client.call("getOperation", { operationId: state.operationId }),
            );
            requireValue(result.state === "exported", "export-result-unknown");
            state.version = {
              vaultId: id(status.vaultId),
              storageVersion: id(result.storageVersion),
              attemptId: id(result.attemptId),
              keyId: id(result.keyId),
            };
          }
        } finally {
          client.close();
        }
      }
      this.options.storage.transaction(() => {
        if (state.version) {
          state.state = "cancelled";
          this.save(state);
        } else this.options.storage.settings.save(sharingStateKey, null, new Date().toISOString());
        this.frozen(false);
      });
      this.options.mutations.resume();
    });
  }
}
