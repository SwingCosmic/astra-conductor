/** Business logic runs on Node and must not import Electron. */
export const coreRuntime = "node" as const;

export { toPublicAccount, toPublicUsage } from "./public-api.js";
export { AppError, toPublicError, type AppErrorCode, type PublicErrorDto } from "./errors.js";
export type {
  AuthMethod,
  CredentialState,
  NotificationCandidate,
  ProviderId,
  PublicAccountDto,
  PublicMetadata,
  PublicUsageDto,
  ResetCreditItem,
  ResetCreditRedemption,
  ResetCredits,
  UsageExtra,
  UsageExtraItem,
  UsageQuota,
  UsageQuotaGroup,
  UsageSnapshot,
} from "./models.js";
export type {
  AuthMethodInteraction,
  ProviderAuthMethodDescriptor,
  ProviderCapability,
  ProviderDescriptor,
  ProviderOfferingDescriptor,
  ProviderPlanDescriptor,
  ProviderPlanSource,
} from "./providers/types.js";
export { providerCatalog } from "./providers/catalog.js";
