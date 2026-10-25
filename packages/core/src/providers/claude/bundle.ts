import type { ProviderContribution } from "../registry.js";
import { CoreServices } from "../../services/contracts.js";
import type { ServiceResolver } from "../../services/registry.js";
import { claudeDescriptor } from "./descriptor.js";
import { ClaudeAccountProvisioner, ClaudeAdapter } from "./adapter.js";
import { createClaudeAuthFlow } from "./auth-flow.js";

export function createClaudeProvider(services: ServiceResolver): ProviderContribution {
  const adapter = new ClaudeAdapter(services);
  const provisioner = new ClaudeAccountProvisioner(
    services.get(CoreServices.storage),
    services.get(CoreServices.vault),
  );
  const authFlow = createClaudeAuthFlow({
    adapter,
    provisioner,
    readFile: services.get(CoreServices.files).readText,
    environment: services.get(CoreServices.environment),
  });
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
