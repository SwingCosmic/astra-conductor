/**
 * `@astra-conductor/polyquota-contract`：PolyQuota 的 IPC 契约（DTO、服务接口、
 * 通道与请求侧运行期校验），供 renderer / preload / main 三方共享。
 */
export {
  POLYQUOTA_SCHEMA_VERSION,
  remainingStatuses,
  remainingBands,
  polyQuotaChangeReasons,
  polyQuotaProxyModes,
} from "./vocabularies.js";
export type {
  PublicAuthInteraction,
  RemainingStatus,
  RemainingBand,
  PolyQuotaChangeReason,
  PolyQuotaProxyMode,
} from "./vocabularies.js";

export type {
  JsonPrimitive,
  PublicMetadata,
  CredentialState,
  PublicAccount,
} from "./dto/account.js";
export type { PublicError, ServiceResult, IpcResult } from "./dto/errors.js";
export type {
  UsageQuota,
  UsageQuotaGroup,
  UsageExtraItem,
  UsageExtra,
  ResetCreditItem,
  ResetCredits,
  ResetCreditRedemption,
  PublicUsage,
} from "./dto/usage.js";
export type {
  PublicAuthMethodDescriptor,
  PublicPlanDescriptor,
  PublicOfferingDescriptor,
  PublicProviderDescriptor,
  StartAuthRequest,
  AuthStartResult,
  PublicAuthSession,
} from "./dto/auth.js";
export type { Settings } from "./dto/settings.js";
export type {
  RefreshOutcomeDto,
  RefreshBatchOutcomeDto,
  CredentialRefreshOutcomeDto,
  RedeemResetCreditRequest,
  RedeemResetCreditOutcomeDto,
  PublicOperationKind,
  PublicOperationState,
  PublicRefreshBatchSummary,
  PublicRefreshSchedulerState,
  PublicSystemStatus,
} from "./dto/operations.js";
export {
  emptyCompositeRemaining,
  type PublicCompositeRemaining,
  type PolyQuotaSnapshot,
  type PolyQuotaChangedEvent,
} from "./dto/snapshot.js";

export type { IPolyQuotaService } from "./channels.js";
export { polyQuotaIpcChannels, polyQuotaIpcEvents } from "./channels.js";

export {
  ContractValidationError,
  parseAccountId,
  parseSessionId,
  parseSettings,
  parseStartAuthRequest,
  parseSetAccountEnabledRequest,
  parseResetCreditRedemption,
  parseRedeemResetCreditRequest,
} from "./validation/request.js";
export * from "./dto/host.js";
