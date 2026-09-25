export type ProviderId = "codex" | "glm" | "grok-build" | "antigravity";
export type GlmRegion = "china" | "international";
export type AuthMethod = "browser-oauth" | "device-code" | "cli-import" | "api-key";

export interface PublicAccount {
  id: string;
  provider: ProviderId;
  authMethod: AuthMethod;
  displayName: string;
  maskedIdentifier: string;
  enabled: boolean;
  credentialState: string;
  tokenExpiresAt: string | null;
  publicMetadata: Record<string, string | number | boolean | null>;
  createdAt: string;
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
}
export interface UsageQuotaGroup {
  key: string;
  displayName: string | null;
  quotas: UsageQuota[];
}
export interface UsageExtra {
  key: string;
  value: string;
  items?: UsageExtraItem[];
}
export interface UsageExtraItem {
  key: string;
  kind: string;
  expiresAt: string | null;
}

export interface PublicUsage {
  accountId: string;
  plan: string;
  overallRemainingPercentage: number | null;
  groups: UsageQuotaGroup[];
  extras: UsageExtra[];
  fetchedAt: string;
}

export interface PublicError {
  code: string;
  message: string;
  retryable: boolean;
}
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: PublicError };
export interface Settings {
  pollingEnabled: boolean;
  pollingIntervalMinutes: number;
}
export type AuthStartResult =
  | { status: "completed"; account: PublicAccount }
  | { status: "pending"; sessionId: string; interaction: "browser-callback" }
  | {
      status: "pending";
      sessionId: string;
      interaction: "device-code";
      userCode: string;
      verificationUri: string;
    };
