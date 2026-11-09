import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  id,
  object,
  parseJson,
  requireValue,
  text,
  type ExportVersion,
} from "@astra-conductor/credentials";
import type {
  CredentialAccountPreview,
  CredentialMigrationState,
} from "@astra-conductor/contract/common";
import type { StoragePort } from "./ports.js";
import { AppError } from "./errors.js";

export type Product = "polyquota" | "graph-agent";
export interface PrivateSnapshot {
  at: string;
  watermark: string;
  records: { id: string; digest: string }[];
  protectedManifest: string;
}
export interface MigrationBinding {
  vaultDirectory: string;
  clientId: string;
  version: ExportVersion;
  sourceWatermark: string;
  keyRef: string;
  recordCount: number;
  accounts?: CredentialAccountPreview[];
  exportOperationId?: string;
  deliveryAcknowledged?: boolean;
  deliveryAckPending?: boolean;
  snapshotAt?: string;
  /** Private copies within this binding's scope, including ones later revoked/deleted. */
  managedIds?: string[];
  privateSnapshot?: PrivateSnapshot;
  /** Snapshot digests permit per-account divergence checks without retaining secrets. */
  privateBaseline?: Record<string, string>;
  sharedBaseline?: Record<string, string>;
}
export interface MigrationOperation {
  id: string;
  kind: "export" | "import" | "enable-shared" | "prepare-private" | "switch-private";
  vaultDirectory: string;
  clientId: string;
  sourceWatermark?: string;
  recordDigest?: string;
  privateBaseline?: Record<string, string>;
  snapshotAt?: string;
  keyRef?: string;
  grantVaultId?: string;
  confirmationId?: string;
  version?: ExportVersion;
}
export interface RetiredBinding {
  vaultId: string;
  clientId: string;
  vaultDirectory: string;
  keyRef: string;
  keyCleanupPending: boolean;
  sessionCleanupPending: boolean;
}
export interface MigrationProfile {
  formatVersion: 1;
  product: Product;
  migrationState: CredentialMigrationState;
  selectedBackend: "private" | "shared";
  binding: MigrationBinding | null;
  operation?: MigrationOperation;
  cleanup?: RetiredBinding[];
  previousDirectory?: string;
  lastImportId?: string;
}

export function keyFile(directory: string, keyRef: string): string {
  requireValue(/^[A-Za-z0-9][A-Za-z0-9_.-]*\.key$/.test(keyRef), "invalid-key-reference");
  return path.join(directory, keyRef);
}
export function versionFrom(value: Record<string, unknown>): ExportVersion {
  return {
    vaultId: id(value.vaultId),
    storageVersion: id(value.storageVersion),
    attemptId: id(value.attemptId),
    keyId: id(value.keyId),
  };
}
function absolute(value: unknown): string {
  requireValue(path.isAbsolute(text(value)), "invalid-vault-directory");
  return value as string;
}
export class MigrationProfileUpgradeRequired extends AppError {
  constructor() {
    super(
      "conflict",
      "检测到已有凭据共享记录，但缺少 migration-state.json。请核对当前产品的数据目录，或从该产品的备份恢复凭据共享状态后重新启动。",
    );
  }
}
export function readMigrationProfile(
  directory: string,
  product: Product,
  storage: StoragePort,
): MigrationProfile {
  const file = path.join(directory, "migration-state.json");
  if (!existsSync(file)) {
    if (
      existsSync(path.join(directory, "binding.json")) ||
      (existsSync(directory) && readdirSync(directory).some((name) => name.endsWith(".key"))) ||
      storage.settings.get("credentialSharing.export.v1") !== null ||
      storage.settings.get("credentialSharing.frozen") === true
    ) {
      throw new MigrationProfileUpgradeRequired();
    }
    return {
      formatVersion: 1,
      product,
      migrationState: "private",
      selectedBackend: "private",
      binding: null,
    };
  }
  const record = object(parseJson(readFileSync(file)));
  requireValue(
    record.product === product && record.formatVersion === 1,
    "invalid-migration-profile",
  );
  const state = text(record.migrationState);
  requireValue(
    ["private", "shared", "export-ready", "import-ready", "private-ready"].includes(state),
  );
  requireValue(
    record.selectedBackend === (["shared", "private-ready"].includes(state) ? "shared" : "private"),
  );
  if (state === "private") requireValue(record.binding === null);
  else {
    const binding = object(record.binding);
    absolute(binding.vaultDirectory);
    versionFrom(object(binding.version));
    id(binding.clientId);
    keyFile(directory, text(binding.keyRef));
    text(binding.sourceWatermark);
    requireValue(Number.isSafeInteger(binding.recordCount) && Number(binding.recordCount) >= 0);
    if (binding.accounts !== undefined) {
      requireValue(Array.isArray(binding.accounts));
      for (const item of binding.accounts) {
        const account = object(item, [
          "id",
          "provider",
          "maskedIdentifier",
          "revision",
          "canRefresh",
        ]);
        id(account.id);
        text(account.provider);
        text(account.maskedIdentifier);
        text(account.revision);
        requireValue(typeof account.canRefresh === "boolean");
      }
    }
    if (binding.privateSnapshot) {
      const snapshot = object(binding.privateSnapshot, [
        "at",
        "watermark",
        "records",
        "protectedManifest",
      ]);
      requireValue(
        Number.isFinite(Date.parse(text(snapshot.at))) &&
          !!text(snapshot.watermark) &&
          !!text(snapshot.protectedManifest),
      );
      requireValue(Array.isArray(snapshot.records));
      for (const item of snapshot.records) {
        const record = object(item, ["id", "digest"]);
        id(record.id);
        requireValue(/^[\w-]{43}$/.test(text(record.digest)));
      }
    }
    if (state === "private-ready") requireValue(binding.privateSnapshot);
  }
  if (record.operation) {
    const op = object(record.operation);
    id(op.id);
    id(op.clientId);
    absolute(op.vaultDirectory);
    requireValue(
      ["export", "import", "enable-shared", "prepare-private", "switch-private"].includes(
        text(op.kind),
      ),
    );
    if (op.keyRef) keyFile(directory, text(op.keyRef));
  }
  if (record.cleanup) {
    requireValue(Array.isArray(record.cleanup));
    for (const raw of record.cleanup) {
      const task = object(raw);
      id(task.clientId);
      absolute(task.vaultDirectory);
      keyFile(directory, text(task.keyRef));
      requireValue(
        typeof task.sessionCleanupPending === "boolean" &&
          typeof task.keyCleanupPending === "boolean",
      );
      id(task.vaultId);
      const current = record.binding ? object(record.binding) : null;
      requireValue(
        !current || (current.keyRef !== task.keyRef && current.clientId !== task.clientId),
      );
    }
  }
  return record as unknown as MigrationProfile;
}

/** Both Electron hosts hold an exclusive profile lock for the entire service lifetime. */
export function writeProfileFile(file: string, data: Uint8Array | string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".next";
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
