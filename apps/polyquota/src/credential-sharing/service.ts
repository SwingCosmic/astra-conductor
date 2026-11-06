import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  type CredentialService,
  type CredentialCipherPort,
  type CredentialMutationGate,
  type StoragePort,
  type ProviderRegistry,
} from "@astra-conductor/core/internal";
import {
  BrokerError,
  canonical,
  hash,
  id,
  object,
  parseJson,
  requireValue,
  text,
  unpackTransfer,
  type ExportVersion,
  type InitialRecord,
} from "@astra-conductor/credentials";
import type {
  CredentialSharingStatus,
  CredentialExportDelivery,
} from "@astra-conductor/polyquota-contract";
import type { BrokerHost, BrokerConnection } from "./broker-host.js";

export const sharingStateKey = "credentialSharing.export.v1";
export const sharingFrozenKey = "credentialSharing.frozen";
const sharingErrorMessages: Record<string, string> = {
  "directory-permissions-too-broad": "已安装的旧版组件仍限制目录权限，请重新安装新版本地组件",
  "vault-directory-not-empty": "首次导出请选择空目录，已有导出请使用原导出记录恢复",
  "invalid-vault-directory": "请选择可用的本地文件夹",
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
}
export class CredentialSharingService {
  private busy = false;
  private lastError: string | null = null;
  constructor(private readonly options: SharingOptions) {}
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
    }
  }
  async getStatus(): Promise<CredentialSharingStatus> {
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
    return {
      ...installation,
      ...runtime,
      available: await this.options.cipher.isAvailable(),
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
      selectedBackend: "private",
      activeBackend: "private",
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
      requireValue(!this.readState(), "export-location-fixed");
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
  private async records(): Promise<{ records: InitialRecord[]; watermark: string }> {
    const { storage, credentials, providers } = this.options;
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
    return this.exclusive(async () => {
      const { mutations, cipher, host } = this.options;
      requireValue(path.isAbsolute(vaultDirectory), "invalid-vault-directory");
      if (this.options.privateDataDirectory) {
        const source = path.resolve(this.options.privateDataDirectory);
        const target = path.resolve(vaultDirectory);
        const contains = (parent: string, child: string) => {
          const relative = path.relative(parent, child);
          return (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
              relative !== ".." &&
              !path.isAbsolute(relative))
          );
        };
        requireValue(
          !contains(source, target) && !contains(target, source),
          "overlapping-product-and-vault-paths",
        );
      }
      requireValue(await cipher.isAvailable(), "secure-storage-unavailable");
      requireValue((await host.inspect()).installState === "installed", "component-not-installed");
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
        requireValue(
          verified.records.length === snapshot.records.length,
          "export-readback-mismatch",
        );
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
  acknowledgeDelivery(): Promise<void> {
    return this.exclusive(async () => {
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
