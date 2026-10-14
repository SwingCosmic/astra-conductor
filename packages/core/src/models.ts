/**
 * 封闭协议标识的唯一来源是 `@astra-conductor/polyquota-contract`（renderer、
 * preload 与主进程共用的轻量契约包）；core 在此 re-export，禁止再建副本。
 * 未来 GraphAgent 契约出现时，这一组标识应上移到共享协议层。
 */
import {
  authMethods,
  providerIds,
  type AuthMethod,
  type CredentialState,
  type JsonPrimitive,
  type ProviderId,
  type PublicMetadata,
  type ResetCreditItem,
  type ResetCreditRedemption,
  type ResetCredits,
} from "@astra-conductor/polyquota-contract";

export { authMethods, providerIds };
export type {
  AuthMethod,
  CredentialState,
  JsonPrimitive,
  ProviderId,
  PublicMetadata,
  ResetCreditItem,
  ResetCreditRedemption,
  ResetCredits,
};

export interface Account {
  id: string;
  provider: ProviderId;
  /** 接入点：账号的展示事实、计费目录查表键与 GLM 端点选择都由它决定。 */
  offeringId: string;
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

/**
 * 凭据密钥的封闭词表——类型与运行时校验共用的唯一来源。新增密钥形态
 * （如 copilotToken：GitHub OAuth 令牌之外短期会过期的 Copilot 会话令牌）
 * 只改这一处；CredentialSecrets 与 credential-vault 的校验集都由它派生。
 */
export const credentialSecretKeys = [
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "copilotToken",
] as const;

export type CredentialSecretKey = (typeof credentialSecretKeys)[number];

export interface CredentialSecrets extends Partial<Record<CredentialSecretKey, string>> {}

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
  displayName: string | null;
  windowSeconds: number | null;
  used: number;
  total: number;
  remaining: number | null;
  remainingPercentage: number | null;
  resetAt: string | null;
  unlimited: boolean;
  /**
   * 上游真实上报了 used/total 原始量（credit/token/请求数等）时为 true；
   * 由百分比合成的刻度（total=100/1000）不算。缺省视为 false，旧快照因此不展示原始量。
   */
  rawAmounts?: boolean;
}

export interface UsageQuotaGroup {
  key: string;
  displayName: string | null;
  quotas: UsageQuota[];
}

export interface UsageExtraItem {
  key: string;
  kind: string;
  expiresAt: string | null;
}

export interface UsageExtra {
  key: string;
  value: string;
  items?: UsageExtraItem[];
}

export interface UsageSnapshot {
  accountId: string;
  plan: string;
  overallRemainingPercentage: number | null;
  groups: UsageQuotaGroup[];
  extras: UsageExtra[];
  /** 重置额度一等结构（§9.3）：聚合按类型分桶，分体逐项含 id / 类型 / 过期时间。 */
  resetCredits: ResetCredits | null;
  fetchedAt: string;
}

export type NotificationLevel = "warning" | "critical";

export interface NotificationState {
  accountId: string;
  quotaKey: string;
  resetAt: string | null;
  level: NotificationLevel;
  lastNotifiedAt: string;
  deliveryConfirmed: boolean;
}

export type SettingValue = JsonPrimitive | JsonPrimitive[] | PublicMetadata;

export interface PublicAccountDto {
  id: string;
  provider: ProviderId;
  offeringId: string;
  authMethod: AuthMethod;
  displayName: string;
  maskedIdentifier: string;
  enabled: boolean;
  credentialState: CredentialState;
  tokenExpiresAt: string | null;
  publicMetadata: PublicMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUsageDto extends UsageSnapshot {}

export interface NotificationCandidate {
  accountId: string;
  quotaKey: string;
  displayName: string | null;
  windowSeconds: number | null;
  level: NotificationLevel;
  remainingPercentage: number;
  resetAt: string | null;
}
