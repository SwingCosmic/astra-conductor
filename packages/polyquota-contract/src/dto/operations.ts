import type { PublicError } from "./errors.js";
import type { PublicUsage, ResetCreditRedemption } from "./usage.js";
import type { PolyQuotaProxyMode } from "../vocabularies.js";

export type RefreshOutcomeDto =
  | { status: "updated"; accountId: string; snapshot: PublicUsage }
  | { status: "skipped"; accountId: string }
  | { status: "failed"; accountId: string; error: PublicError };

export interface RefreshBatchOutcomeDto {
  source: "manual" | "tray" | "automatic";
  outcomes: RefreshOutcomeDto[];
}

export type CredentialRefreshOutcomeDto =
  | { status: "updated" | "unchanged"; accountId: string; tokenExpiresAt: string | null }
  | { status: "failed"; accountId: string; error: PublicError };

export interface RedeemResetCreditRequest {
  accountId: string;
  redemption: ResetCreditRedemption;
}

export interface RedeemResetCreditOutcomeDto {
  status: "redeemed";
  accountId: string;
  refreshStatus: RefreshOutcomeDto["status"];
  remainingResetCredits: number | null;
}

export type PublicOperationKind =
  | "refresh-account"
  | "refresh-all"
  | "refresh-credentials"
  | "use-reset-credit"
  | "auth";

export interface PublicOperationState {
  id: string;
  kind: PublicOperationKind;
  status: "running" | "waiting-for-user";
  accountId: string | null;
  source: "manual" | "tray" | "automatic" | null;
  startedAt: string;
}

export interface PublicRefreshBatchSummary {
  source: "manual" | "tray" | "automatic";
  succeeded: number;
  skipped: number;
  failed: number;
  error: PublicError | null;
}

export interface PublicRefreshSchedulerState {
  status: "disabled" | "waiting" | "running" | "stopped";
  intervalMinutes: number;
  nextRunAt: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastResult: PublicRefreshBatchSummary | null;
}

export interface PublicSystemStatus {
  proxyMode: PolyQuotaProxyMode;
  proxyAddress: string | null;
}
