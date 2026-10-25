import type { ProviderContribution } from "../registry.js";
import { CoreServices } from "../../services/contracts.js";
import type { ServiceResolver } from "../../services/registry.js";
import { grokBuildDescriptor } from "./descriptor.js";
import { GrokBuildAccountProvisioner, GrokBuildAdapter } from "./adapter.js";
import { createGrokBuildAuthFlow } from "./auth-flow.js";

export function createGrokBuildProvider(services: ServiceResolver): ProviderContribution {
  const adapter = new GrokBuildAdapter(services);
  const provisioner = new GrokBuildAccountProvisioner(
    services.get(CoreServices.storage),
    services.get(CoreServices.vault),
  );
  const authFlow = createGrokBuildAuthFlow({
    adapter,
    provisioner,
    readFile: services.get(CoreServices.files).readText,
    environment: services.get(CoreServices.environment),
    startCallbackServer: services.get(CoreServices.callbackServer).start,
  });
  return {
    descriptor: grokBuildDescriptor,
    account: {
      providerId: "grok-build",
      supportedMethods: authFlow.supportedMethods,
      startAuth: (offeringId, method, options) => authFlow.start(offeringId, method, options),
      refreshCredentials: (account, envelope, options) =>
        adapter.refreshCredentials(account, envelope, options.force),
    },
    usage: {
      providerId: "grok-build",
      fetchUsage: (account, envelope) => adapter.fetchUsage(account, envelope),
    },
  };
}
