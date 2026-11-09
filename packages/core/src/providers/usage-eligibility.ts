import type { Account } from "../models.js";
import type { ProviderRegistry } from "./registry.js";

/** Old subscription accounts need no plan lookup. Explicit account or offering exclusions win. */
export function supportsSubscriptionUsage(account: Account, providers: ProviderRegistry): boolean {
  const offering = providers.findOffering(account.offeringId);
  const eligibility = account.publicMetadata.supportsUsage;
  return (
    !!offering &&
    offering.provider === account.provider &&
    offering.offering.supportsSubscriptionUsage !== false &&
    offering.offering.authMethods.some(({ method }) => method === account.authMethod) &&
    eligibility !== false &&
    eligibility !== "false" &&
    !!providers.getUsage(account.provider)
  );
}
