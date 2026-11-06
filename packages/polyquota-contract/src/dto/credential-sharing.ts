export interface CredentialSharingStatus {
  available: boolean;
  installState: "not-installed" | "installed" | "damaged" | "incompatible" | "unknown";
  installedVersion: string | null;
  installationDirectory: string | null;
  localPackageDirectory: string;
  downloadState: "not-configured";
  localPackageState: "missing" | "ready" | "invalid" | "unknown";
  directorySelectionAvailable: boolean;
  serviceState: string;
  exportState: "none" | "preparing" | "pending" | "exported" | "cancelled";
  vaultDirectory: string | null;
  storageVersion: string | null;
  recordCount: number;
  frozen: boolean;
  deliveryAcknowledged: boolean;
  rememberedKey: boolean;
  selectedBackend: "private";
  activeBackend: "private";
  brokerOwnership: string;
  lastError: string | null;
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
}
