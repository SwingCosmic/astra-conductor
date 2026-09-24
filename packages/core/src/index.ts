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
  UsageExtra,
  UsageQuota,
  UsageQuotaGroup,
  UsageSnapshot,
} from "./models.js";
