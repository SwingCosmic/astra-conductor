type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function pickTierField(tier: unknown, field: "name" | "id"): string | null {
  const value = toRecord(tier)[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function defaultAllowedTier(subscription: JsonRecord): JsonRecord | null {
  if (!Array.isArray(subscription.allowedTiers)) return null;
  return subscription.allowedTiers.map(toRecord).find((tier) => tier.isDefault === true) ?? null;
}

export function extractCodeAssistSubscriptionTier(subscriptionInfo: unknown): string | null {
  const subscription = toRecord(subscriptionInfo);
  let tier =
    pickTierField(subscription.paidTier, "name") || pickTierField(subscription.paidTier, "id");
  const ineligible = Array.isArray(subscription.ineligibleTiers) && subscription.ineligibleTiers.length;
  if (!tier && !ineligible) {
    tier =
      pickTierField(subscription.currentTier, "name") ||
      pickTierField(subscription.currentTier, "id");
  }
  if (!tier) {
    const fallback = defaultAllowedTier(subscription);
    tier = fallback && (pickTierField(fallback, "name") || pickTierField(fallback, "id"));
    if (tier && ineligible) tier = `${tier} (Restricted)`;
  }
  return tier;
}

export function extractCodeAssistOnboardTierId(subscriptionInfo: unknown): string {
  const subscription = toRecord(subscriptionInfo);
  const ineligible = Array.isArray(subscription.ineligibleTiers) && subscription.ineligibleTiers.length;
  return (
    pickTierField(subscription.paidTier, "id") ||
    (!ineligible ? pickTierField(subscription.currentTier, "id") : null) ||
    pickTierField(defaultAllowedTier(subscription), "id") ||
    pickTierField(subscription.currentTier, "id") ||
    "legacy-tier"
  );
}
