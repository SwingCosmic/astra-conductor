import type { ProviderContribution } from "../registry.js";
import type { ProviderPorts } from "../ports.js";
import { grokBuildDescriptor } from "./descriptor.js";
import { GrokBuildAccountProvisioner, GrokBuildAdapter } from "./adapter.js";
import { createGrokBuildAuthFlow } from "./auth-flow.js";

export function createGrokBuildProvider(ports: ProviderPorts): ProviderContribution {
  const adapter = new GrokBuildAdapter(ports.http.fetch, ports.clock);
  const provisioner = new GrokBuildAccountProvisioner(ports.storage, ports.vault);
  const authFlow = createGrokBuildAuthFlow({
    adapter,
    provisioner,
    openExternal: (url) => ports.browser.openExternal(url),
    startCallbackServer: ports.callbackServer.start,
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
