import type { ProviderContribution } from "../registry.js";
import type { ProviderPorts } from "../ports.js";
import { antigravityDescriptor } from "./descriptor.js";
import { AntigravityAccountProvisioner, AntigravityAdapter } from "./adapter.js";
import { createAntigravityAuthFlow } from "./auth-flow.js";

export function createAntigravityProvider(ports: ProviderPorts): ProviderContribution {
  const adapter = new AntigravityAdapter(ports.http.fetch, ports.clock);
  const provisioner = new AntigravityAccountProvisioner(ports.storage, ports.vault);
  const authFlow = createAntigravityAuthFlow({
    adapter,
    provisioner,
    openExternal: (url) => ports.browser.openExternal(url),
    startCallbackServer: ports.callbackServer.start,
  });
  return {
    descriptor: antigravityDescriptor,
    account: {
      providerId: "antigravity",
      supportedMethods: authFlow.supportedMethods,
      startAuth: (offeringId, method, options) => authFlow.start(offeringId, method, options),
      refreshCredentials: (account, envelope, options) =>
        adapter.refreshCredentials(account, envelope, options.force),
    },
    usage: {
      providerId: "antigravity",
      fetchUsage: (account, envelope) => adapter.fetchUsage(account, envelope),
    },
  };
}
