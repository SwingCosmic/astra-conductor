export interface PublicAccount {
  id: string;
  provider: string;
  authMethod: string;
  displayName: string;
  maskedIdentifier: string;
  enabled: boolean;
  credentialState: string;
  publicMetadata: Record<string, string | number | boolean | null>;
  createdAt: string;
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

export interface PublicUsage {
  accountId: string;
  plan: string;
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
export interface DeviceAuthorization {
  sessionId: string;
  userCode: string;
  verificationUri: string;
}
