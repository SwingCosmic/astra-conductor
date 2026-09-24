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
  const value = structuredClone(snapshot) as UsageSnapshot & {
    quotas?: UsageSnapshot["groups"][number]["quotas"];
    resetCredits?: number;
  };
  if (!Array.isArray(value.groups)) {
    value.groups = [{ key: "default", title: null, quotas: value.quotas ?? [] }];
  }
  if (!Array.isArray(value.extras)) {
    value.extras =
      typeof value.resetCredits === "number"
        ? [{ key: "reset-credits", label: "Reset credits", value: String(value.resetCredits) }]
        : [];
  }
  delete value.quotas;
  delete value.resetCredits;
  return value;
}
