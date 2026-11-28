export type CredentialMigrationState =
  | "private"
  | "export-ready"
  | "import-ready"
  | "private-ready"
  | "shared";

export type CredentialWizardFlow = "export" | "import" | "return-private" | "revalidate";

export type CredentialWizardStepCode =
  | "select-directory"
  | "publish-verify"
  | "resolve-conflict"
  | "deliver-key"
  | "verify-key"
  | "preview-import"
  | "review-migrate"
  | "confirm-snapshot"
  | "prepare-snapshot"
  | "switch-private"
  | "reconcile-switch"
  | "cleanup-old-key";

export interface CredentialWizardProjection {
  /** 当前存在未完成或待确认流程时非空；正常态 A / 已确认的 C 为 null */
  flow: CredentialWizardFlow | null;
  stepCode: CredentialWizardStepCode | null;
  /** 1-based 步骤索引与总步数，用于顶部横幅与进度条 */
  stepIndex: number;
  totalSteps: number;
  /** 概览页是否应置顶展示「待续办流程横幅」 */
  resumable: boolean;
  /** 侧栏「凭据管理」是否显示提醒角标 */
  requiresAttention: boolean;
  /** 当前步骤是否允许用户执行显式取消（仅 A 中未提交操作为 true） */
  canCancelOperation: boolean;
  /** 给续办横幅与角标 Tooltip 使用的单句状态摘要 */
  summary: string | null;
}

export interface CredentialSharingStatus {
  migrationState: CredentialMigrationState | null;
  operation?: {
    id: string;
    kind: string;
    vaultDirectory?: string;
    step?: string;
    stepCode?: CredentialWizardStepCode;
    failedVaultId?: string;
  } | null;
  importPreview?: CredentialImportPreview | null;
  migrationReview?: { id: string; accounts: CredentialAccountPreview[] } | null;
  available: boolean;
  installState: "not-installed" | "installed" | "damaged" | "incompatible" | "unknown";
  installedVersion: string | null;
  installedApiLevel?: string | null;
  requiredApiLevel: string;
  installationDirectory: string | null;
  localPackageDirectory: string;
  downloadState:
    | "not-configured"
    | "available"
    | "cached"
    | "downloading"
    | "verifying"
    | "installing";
  downloadPercent?: number;
  downloadVersion?: string;
  cachedVersion?: string;
  localPackageState: "missing" | "ready" | "invalid" | "unknown";
  directorySelectionAvailable: boolean;
  serviceState: string;
  vaultDirectory: string | null;
  storageVersion: string | null;
  recordCount: number;
  frozen: boolean;
  deliveryAcknowledged: boolean;
  rememberedKey: boolean;
  selectedBackend: "private" | "shared";
  activeBackend: "private" | "shared" | "unavailable";
  snapshotAt: string | null;
  keyCleanupPending: boolean;
  sessionCleanupPending: boolean;
  brokerOwnership: string;
  lastError: string | null;
}

export interface CredentialAccountPreview {
  id: string;
  provider: string;
  maskedIdentifier: string;
  canRefresh: boolean;
  revision: string;
}

export interface CredentialImportPreview {
  previewId: string;
  storageVersion: string;
  recordCount: number;
  accounts: CredentialAccountPreview[];
  conflicts?: CredentialAccountPreview[];
}

export interface CredentialManagementStatus extends CredentialSharingStatus {
  role?: "source" | "receiver" | "both";
  privateAvailable?: boolean;
  connected?: boolean;
  accounts?: CredentialAccountPreview[];
  capabilities?: Record<string, import("../service.js").ActionAvailability>;
  wizard?: CredentialWizardProjection | null;
  instanceId?: string;
  contextId?: string;
}
/** Only the explicit delivery operation returns this user-facing migration key. */
export interface CredentialExportDelivery {
  migrationKey: string;
  storageVersion: string;
}

import type { ServiceResult } from "./errors.js";
export interface ICredentialSharingService {
  getStatus(): Promise<ServiceResult<CredentialSharingStatus>>;
  selectDirectory(): Promise<ServiceResult<string | null>>;
  install(): Promise<ServiceResult<void>>;
  uninstall(): Promise<ServiceResult<void>>;
  exportCredentials(vaultDirectory: string): Promise<ServiceResult<CredentialExportDelivery>>;
  acknowledgeDelivery(): Promise<ServiceResult<void>>;
  cancel(): Promise<ServiceResult<void>>;
  switchToPrivate(): Promise<ServiceResult<void>>;
  relocate(vaultDirectory: string): Promise<ServiceResult<void>>;
  enableShared(confirmationId?: string): Promise<ServiceResult<void>>;
  returnToPrivate(
    acceptIndependentRefreshRisk: boolean,
    offlineSnapshotAt?: string,
  ): Promise<ServiceResult<void>>;
  rejoinShared(migrationKey: string): Promise<ServiceResult<void>>;
}

export interface ICredentialManagementService extends ICredentialSharingService {
  checkRelease(): Promise<ServiceResult<void>>;
  installRelease(cachedOnly?: boolean): Promise<ServiceResult<void>>;
  getStatus(): Promise<ServiceResult<CredentialManagementStatus>>;
  subscribe(listener: (event: import("../service.js").ProviderChangedEvent) => void): () => void;
  clearExportTarget(operationId: string, vaultId: string): Promise<ServiceResult<void>>;
  cancelExport(): Promise<ServiceResult<void>>;
  resumeExport(): Promise<ServiceResult<CredentialExportDelivery | null>>;
  restartExport(vaultDirectory: string): Promise<ServiceResult<CredentialExportDelivery>>;
  verifyImport(input: {
    vaultDirectory: string;
    migrationKey: string;
  }): Promise<ServiceResult<CredentialImportPreview>>;
  confirmImport(previewId: string): Promise<ServiceResult<void>>;
  cancelPreview(): Promise<ServiceResult<void>>;
  retry(): Promise<ServiceResult<void>>;
  adoptVault(vaultDirectory: string, clientId?: string): Promise<ServiceResult<void>>;
}

export type AccountPreview = CredentialAccountPreview;
export type ImportPreview = CredentialImportPreview;
