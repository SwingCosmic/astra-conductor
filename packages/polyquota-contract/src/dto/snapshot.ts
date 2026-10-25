import type { PublicAccount } from "./account.js";
import type { PublicProviderDescriptor } from "./auth.js";
import type { PublicUsage } from "./usage.js";
import type { Settings } from "./settings.js";
import type { PublicOperationState, PublicRefreshSchedulerState } from "./operations.js";
import type {
  PolyQuotaChangeReason,
  POLYQUOTA_SCHEMA_VERSION,
  RemainingBand,
  RemainingStatus,
} from "../vocabularies.js";

export interface PublicCompositeRemaining {
  status: RemainingStatus;
  sessionScore: number | null;
  weeklyScore: number | null;
  remaining: number | null;
  band: RemainingBand;
  sessionBand: RemainingBand;
  weeklyBand: RemainingBand;
  enabledAccountCount: number;
  scoredAccountCount: number;
}

export function emptyCompositeRemaining(): PublicCompositeRemaining {
  return {
    status: "empty",
    sessionScore: null,
    weeklyScore: null,
    remaining: null,
    band: "unknown",
    sessionBand: "unknown",
    weeklyBand: "unknown",
    enabledAccountCount: 0,
    scoredAccountCount: 0,
  };
}

export interface PolyQuotaSnapshot {
  schemaVersion: typeof POLYQUOTA_SCHEMA_VERSION;
  instanceId: string;
  revision: number;
  generatedAt: string;
  providers: PublicProviderDescriptor[];
  accounts: PublicAccount[];
  usageByAccountId: Record<string, PublicUsage | null>;
  compositeRemaining: PublicCompositeRemaining;
  operations: PublicOperationState[];
  settings: Settings;
  scheduler: PublicRefreshSchedulerState;
}

export interface PolyQuotaChangedEvent {
  /** Client connection ready/reconnected: read a fresh snapshot even at the same revision. */
  resync?: boolean;
  schemaVersion: typeof POLYQUOTA_SCHEMA_VERSION;
  instanceId: string;
  revision: number;
  reasons: PolyQuotaChangeReason[];
  occurredAt: string;
}
