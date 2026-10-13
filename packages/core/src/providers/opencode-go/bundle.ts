import type { ProviderContribution } from "../registry.js";
import type { ProviderPorts } from "../ports.js";
import { opencodeGoDescriptor } from "./descriptor.js";
import { OpencodeGoAccountProvisioner, OpencodeGoAdapter } from "./adapter.js";
import { createOpencodeGoAuthFlow } from "./auth-flow.js";

export function createOpencodeGoProvider(ports: ProviderPorts): ProviderContribution {
  const adapter = new OpencodeGoAdapter(ports.http.fetch, ports.clock);
  const provisioner = new OpencodeGoAccountProvisioner(ports.storage, ports.vault);
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
