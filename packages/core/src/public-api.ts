import type { Account, PublicAccountDto, PublicUsageDto, UsageSnapshot } from "./models.js";

export function toPublicAccount(
  account: Account,
  tokenExpiresAt: string | null = null,
): PublicAccountDto {
  return {
    id: account.id,
    provider: account.provider,
    authMethod: account.authMethod,
    displayName: account.displayName,
    maskedIdentifier: account.maskedIdentifier,
    enabled: account.enabled,
    credentialState: account.credentialState,
    tokenExpiresAt,
    publicMetadata: { ...account.publicMetadata },
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export function toPublicUsage(snapshot: UsageSnapshot): PublicUsageDto {
  const value = structuredClone(snapshot) as UsageSnapshot & {
    quotas?: UsageSnapshot["groups"][number]["quotas"];
    resetCredits?: number;
    overallRemainingPercentage?: number | null;
  };
  if (!Array.isArray(value.groups)) {
    value.groups = [{ key: "default", displayName: null, quotas: value.quotas ?? [] }];
  }
  value.groups = value.groups.map((group) => {
    const legacyGroup = group as typeof group & { title?: string | null };
    return {
      key: group.key,
      displayName: group.displayName ?? legacyGroup.title ?? null,
      quotas: group.quotas.map((quota) => {
        const legacyQuota = quota as typeof quota & { title?: string };
        return {
          ...quota,
          displayName: quota.displayName ?? legacyQuota.title ?? null,
          windowSeconds: quota.windowSeconds ?? null,
        };
      }),
    };
  });
  if (!Array.isArray(value.extras)) {
    value.extras =
      typeof value.resetCredits === "number"
        ? [{ key: "reset-credits", value: String(value.resetCredits) }]
        : [];
  }
  value.extras = value.extras.map(({ key, value: extraValue, items }) => ({
    key,
    value: extraValue,
    ...(Array.isArray(items)
      ? {
          items: items.map((item) => ({
            key: item.key,
            kind: item.kind,
            expiresAt: item.expiresAt ?? null,
            ...(item.actionToken ? { actionToken: item.actionToken } : {}),
          })),
        }
      : {}),
  }));
  if (value.overallRemainingPercentage === undefined) {
    value.overallRemainingPercentage = value.groups[0]?.quotas[0]?.remainingPercentage ?? null;
  }
  delete value.quotas;
  delete value.resetCredits;
  return value;
}
