import type { Account, PublicAccountDto, PublicUsageDto, UsageSnapshot } from "./models.js";

export function toPublicAccount(account: Account): PublicAccountDto {
  return {
    id: account.id,
    provider: account.provider,
    authMethod: account.authMethod,
    displayName: account.displayName,
    maskedIdentifier: account.maskedIdentifier,
    enabled: account.enabled,
    credentialState: account.credentialState,
    publicMetadata: { ...account.publicMetadata },
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export function toPublicUsage(snapshot: UsageSnapshot): PublicUsageDto {
  return structuredClone(snapshot);
}
