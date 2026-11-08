import type {
  CredentialAccountPreview as AccountPreview,
  CredentialImportPreview as ImportPreview,
} from "../common/index.js";
export interface GraphStatus {
  installState: string;
  installedVersion: string | null;
  installedApiLevel?: string | null;
  requiredApiLevel: string;
  installationDirectory: string | null;
  localPackageDirectory: string;
  localPackageState: string;
  downloadState: "not-configured";
  available: boolean;
  state: "none" | "preparing" | "import-ready" | "shared";
  vaultDirectory: string | null;
  storageVersion: string | null;
  serviceState: string;
  ownership: string;
  rememberedKey: boolean;
  connected: boolean;
  accounts: AccountPreview[];
  lastError: string | null;
}
export interface GraphApi {
  status(): Promise<GraphStatus>;
  selectDirectory(): Promise<string | null>;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  verifyImport(input: { vaultDirectory: string; migrationKey: string }): Promise<ImportPreview>;
  confirmImport(previewId: string): Promise<void>;
  cancelPreview(): Promise<void>;
  retry(): Promise<void>;
  refresh(accountId: string): Promise<void>;
}
