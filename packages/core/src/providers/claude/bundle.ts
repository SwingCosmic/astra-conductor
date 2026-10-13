import type { ProviderContribution } from "../registry.js";
import type { ProviderPorts } from "../ports.js";
import { claudeDescriptor } from "./descriptor.js";
import { ClaudeAccountProvisioner, ClaudeAdapter } from "./adapter.js";
import { createClaudeAuthFlow } from "./auth-flow.js";

export function createClaudeProvider(ports: ProviderPorts): ProviderContribution {
  const adapter = new ClaudeAdapter(ports.http.fetch, ports.clock);
  const provisioner = new ClaudeAccountProvisioner(ports.storage, ports.vault);
  const authFlow = createClaudeAuthFlow({ adapter, provisioner });
  return {
    descriptor: claudeDescriptor,
    account: {
      providerId: "claude",
      supportedMethods: authFlow.supportedMethods,
      startAuth: (offeringId, method, options) => authFlow.start(offeringId, method, options),
      refreshCredentials: (account, envelope, options) =>
        adapter.refreshCredentials(account, envelope, options.force),
    },
    usage: {
      providerId: "claude",
      fetchUsage: (account, envelope) => adapter.fetchUsage(account, envelope),
    },
  };
}
