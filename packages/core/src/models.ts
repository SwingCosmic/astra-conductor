/**
 * 协议 DTO 的单源是 `@astra-conductor/polyquota-contract`（renderer、preload
 * 与主进程共用的轻量契约包）；core 在此 re-export，禁止再建副本。供应商 /
 * 认证方式是随目录扩张的动态集合：类型不封闭为字面量联合，已知集合由
 * `providers/catalog.ts` 从注册 descriptors 收集导出（providerIds / authMethods）。
 * 未来 GraphAgent 契约出现时，这一组标识应上移到共享协议层。
 */
import type {
  CredentialState,
  JsonPrimitive,
  PublicAccount,
  PublicMetadata,
  PublicUsage,
  ResetCreditItem,
  ResetCreditRedemption,
  ResetCredits,
  UsageExtra,
  UsageExtraItem,
  UsageQuota,
  UsageQuotaGroup,
} from "@astra-conductor/polyquota-contract";

export type {
  CredentialState,
  JsonPrimitive,
  PublicAccount,
  PublicMetadata,
  PublicUsage,
  ResetCreditItem,
  ResetCreditRedemption,
  ResetCredits,
  UsageExtra,
  UsageExtraItem,
  UsageQuota,
  UsageQuotaGroup,
};

/** slug 格式（`^[a-z0-9][a-z0-9-]{0,63}$`）；已知集合见 catalog 导出的 providerIds。 */
export type ProviderId = string;
/** slug 格式；已知集合见 catalog 导出的 authMethods（目录声明供源）。 */
export type AuthMethod = string;

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

/**
 * 供应商内部用量快照（持久化形态）。`plan` 是上游原始标识（数据层标识符）：
 * 档位匹配与展示标签解析在主进程构造公开快照时进行（`toPublicUsage`），
 * 结果（`planId` / `planLabel`）随公开 DTO 下发，不在存储层固化。
 */
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

export interface NotificationCandidate {
  accountId: string;
  quotaKey: string;
  displayName: string | null;
  windowSeconds: number | null;
  level: NotificationLevel;
  remainingPercentage: number;
  resetAt: string | null;
}
