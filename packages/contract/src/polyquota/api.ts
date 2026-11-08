import { apiOperation, type EventChannel } from "../common/index.js";
import { POLYQUOTA_SCHEMA_VERSION } from "./vocabularies.js";
import type { PolyQuotaChangedEvent, PolyQuotaSnapshot } from "./dto/snapshot.js";
import type { Settings } from "./dto/settings.js";
import type {
  PublicSystemStatus,
  RedeemResetCreditOutcomeDto,
  RedeemResetCreditRequest,
  RefreshBatchOutcomeDto,
  RefreshOutcomeDto,
} from "./dto/operations.js";

const prefix = "/api/v1/polyquota";
export const polyQuotaOperations = {
  getSnapshot: apiOperation<void, PolyQuotaSnapshot>("GET", `${prefix}/snapshot`, {
    parseOutput(value) {
      if (
        !value ||
        typeof value !== "object" ||
        (value as { schemaVersion?: unknown }).schemaVersion !== POLYQUOTA_SCHEMA_VERSION
      )
        throw new Error("服务通信协议版本不一致");
      return value as PolyQuotaSnapshot;
    },
  }),
  refreshAccount: apiOperation<{ accountId: string }, RefreshOutcomeDto>(
    "POST",
    (input) => `${prefix}/accounts/${encodeURIComponent(input.accountId)}/refresh`,
  ),
  refreshAll: apiOperation<void, RefreshBatchOutcomeDto>("POST", `${prefix}/accounts/refresh-all`),
  redeemResetCredit: apiOperation<RedeemResetCreditRequest, RedeemResetCreditOutcomeDto>(
    "POST",
    `${prefix}/reset-credits/redeem`,
    { body: (input) => input },
  ),
  saveSettings: apiOperation<Settings, void>("POST", `${prefix}/settings/save`, {
    body: (input) => input,
    voidResult: true,
  }),
  getSystemStatus: apiOperation<void, PublicSystemStatus>("GET", `${prefix}/system-status`),
} as const;

export const polyQuotaEventChannel: EventChannel<PolyQuotaChangedEvent> = {
  type: "changed",
  accepts(value) {
    if (!value || typeof value !== "object") return false;
    const event = value as {
      scope?: unknown;
      schemaVersion?: unknown;
      stamp?: { scope?: unknown };
      stamps?: { scope?: unknown }[];
    };
    return (
      event.scope === "polyquota" ||
      event.stamp?.scope === "polyquota" ||
      !!event.stamps?.some((stamp) => stamp.scope === "polyquota") ||
      (event.schemaVersion === POLYQUOTA_SCHEMA_VERSION && !event.stamp)
    );
  },
  parse(value, resync) {
    const event = value as PolyQuotaChangedEvent & {
      stamp?: { instanceId: string; revision: number };
      stamps?: { scope: string; instanceId: string; revision: number }[];
    };
    const stamp = event.stamp ?? event.stamps?.find((item) => item.scope === "polyquota");
    return {
      schemaVersion: POLYQUOTA_SCHEMA_VERSION,
      instanceId: stamp?.instanceId ?? event.instanceId,
      revision: stamp?.revision ?? event.revision,
      reasons: event.reasons ?? [],
      occurredAt: event.occurredAt ?? new Date().toISOString(),
      ...(resync ? { resync: true } : {}),
    };
  },
};
