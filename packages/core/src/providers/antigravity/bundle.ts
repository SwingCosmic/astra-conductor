import type { ProviderContribution } from "../registry.js";
import { CoreServices } from "../../services/contracts.js";
import type { ServiceResolver } from "../../services/registry.js";
import { antigravityDescriptor } from "./descriptor.js";
import { AntigravityAccountProvisioner, AntigravityAdapter } from "./adapter.js";
import { createAntigravityAuthFlow } from "./auth-flow.js";

export function createAntigravityProvider(services: ServiceResolver): ProviderContribution {
  const adapter = new AntigravityAdapter(services);
  const storage = services.get(CoreServices.storage);
  const provisioner = new AntigravityAccountProvisioner(storage, services.get(CoreServices.vault));
  const authFlow = createAntigravityAuthFlow({
    adapter,
    provisioner,
    startCallbackServer: services.get(CoreServices.callbackServer).start,
  });
  return {
    descriptor: antigravityDescriptor,
    account: {
      providerId: "antigravity",
      supportedMethods: authFlow.supportedMethods,
      startAuth: (offeringId, method, options) => authFlow.start(offeringId, method, options),
      canUseCurrentCredentials: adapter.canUseCurrentCredentials,
      refreshCredentials: (account, envelope, options) =>
        adapter.refreshCredentials(account, envelope, options.force),
    },
    usage: {
      providerId: "antigravity",
      fetchUsage: (account, envelope) =>
        adapter.fetchUsage(account, envelope, storage.snapshots.get(account.id)?.plan),
    },
  };
}
