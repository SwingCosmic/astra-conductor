import { isLocalKeyAccount } from "./catalog.js";
import type { Account } from "../models.js";
import type { ProviderRegistry } from "./registry.js";

/** Old subscription accounts need no plan lookup. Explicit account or offering exclusions win. */
export function subscriptionUsageEligibility(
  account: Account,
  providers: ProviderRegistry,
): "eligible" | "ineligible" | "unknown" {
  if (isLocalKeyAccount(account, (id) => providers.findOffering(id))) return "ineligible";
  const offering = providers.findOffering(account.offeringId);
  const eligibility = account.publicMetadata.supportsUsage;
  if (
    !offering ||
    offering.provider !== account.provider ||
    !offering.offering.authMethods.some(({ method }) => method === account.authMethod)
  )
    return "unknown";
  if (
    offering.offering.supportsSubscriptionUsage === false ||
    eligibility === false ||
    eligibility === "false"
  )
    return "ineligible";
  return providers.getUsage(account.provider) ? "eligible" : "unknown";
}

export function supportsSubscriptionUsage(account: Account, providers: ProviderRegistry): boolean {
  return subscriptionUsageEligibility(account, providers) === "eligible";
}
