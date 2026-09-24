export const providerIds = ["codex", "glm", "grok-build", "antigravity"] as const;
export type ProviderId = (typeof providerIds)[number];

export const authMethods = ["browser-oauth", "device-code", "cli-import", "api-key"] as const;
export type AuthMethod = (typeof authMethods)[number];

export type JsonPrimitive = string | number | boolean | null;
export type PublicMetadata = Record<string, JsonPrimitive>;

export type CredentialState = "available" | "locked" | "missing";

export interface Account {
  id: string;
  provider: ProviderId;
  authMethod: AuthMethod;
  stableIdentity: string;
  displayName: string;
  maskedIdentifier: string;
  enabled: boolean;
  credentialState: CredentialState;
  publicMetadata: PublicMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialSecrets {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  apiKey?: string;
}

export interface CredentialEnvelope {
  version: 1;
  accountId: string;
  provider: ProviderId;
  authMethod: AuthMethod;
  expiresAt: string | null;
  secrets: CredentialSecrets;
}

export interface EncryptedCredential {
  accountId: string;
  encryptionVersion: 1;
  ciphertext: Uint8Array;
  updatedAt: string;
}

export interface UsageQuota {
  key: string;
  title: string;
  used: number;
  total: number;
  remaining: number | null;
  remainingPercentage: number | null;
  resetAt: string | null;
  unlimited: boolean;
}

export interface UsageQuotaGroup {
  key: string;
  title: string | null;
  quotas: UsageQuota[];
}

export interface UsageExtra {
  key: string;
  label: string;
  value: string;
}

export interface UsageSnapshot {
  accountId: string;
  plan: string;
  groups: UsageQuotaGroup[];
  extras: UsageExtra[];
  fetchedAt: string;
}

export type NotificationLevel = "warning" | "critical";

export interface NotificationState {
  accountId: string;
  quotaKey: string;
  resetAt: string | null;
  level: NotificationLevel;
  lastNotifiedAt: string;
}

export type SettingValue = JsonPrimitive | JsonPrimitive[] | PublicMetadata;

export interface PublicAccountDto {
  id: string;
  provider: ProviderId;
  authMethod: AuthMethod;
  displayName: string;
  maskedIdentifier: string;
  enabled: boolean;
  credentialState: CredentialState;
  publicMetadata: PublicMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUsageDto extends UsageSnapshot {}

export interface NotificationCandidate {
  accountId: string;
  quotaKey: string;
  title: string;
  level: NotificationLevel;
  remainingPercentage: number;
  resetAt: string | null;
}
