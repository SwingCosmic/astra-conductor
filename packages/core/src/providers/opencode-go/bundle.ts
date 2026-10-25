import type { ProviderContribution } from "../registry.js";
import { CoreServices } from "../../services/contracts.js";
import type { ServiceResolver } from "../../services/registry.js";
import { opencodeGoDescriptor } from "./descriptor.js";
import { OpencodeGoAccountProvisioner, OpencodeGoAdapter } from "./adapter.js";
import { createOpencodeGoAuthFlow } from "./auth-flow.js";

export function createOpencodeGoProvider(services: ServiceResolver): ProviderContribution {
  const adapter = new OpencodeGoAdapter(services);
  const provisioner = new OpencodeGoAccountProvisioner(
    services.get(CoreServices.storage),
    services.get(CoreServices.vault),
  );
  const authFlow = createOpencodeGoAuthFlow({ adapter, provisioner });
  return {
    descriptor: opencodeGoDescriptor,
    account: {
      providerId: "opencode-go",
      supportedMethods: authFlow.supportedMethods,
      startAuth: (offeringId, method, options) => authFlow.start(offeringId, method, options),
    },
    usage: {
      providerId: "opencode-go",
      fetchUsage: (account, envelope) => adapter.fetchUsage(account, envelope),
    },
  };
}
