import type { ProviderContribution } from "../registry.js";
import { CoreServices } from "../../services/contracts.js";
import type { ServiceResolver } from "../../services/registry.js";
import { codexDescriptor } from "./descriptor.js";
import { CodexAccountProvisioner, CodexAdapter } from "./adapter.js";
import { createCodexAuthFlow } from "./auth-flow.js";

/** Codex 组合工厂：adapter、provisioner、auth-flow 的拼装属于本供应商的知识。 */
export function createCodexProvider(services: ServiceResolver): ProviderContribution {
  const adapter = new CodexAdapter(services);
  const provisioner = new CodexAccountProvisioner(
    services.get(CoreServices.storage),
    services.get(CoreServices.vault),
  );
  const authFlow = createCodexAuthFlow({
    adapter,
    provisioner,
    readFile: services.get(CoreServices.files).readText,
    environment: services.get(CoreServices.environment),
    startCallbackServer: services.get(CoreServices.callbackServer).start,
  });
  return {
    descriptor: codexDescriptor,
    account: {
      providerId: "codex",
      supportedMethods: authFlow.supportedMethods,
      startAuth: (offeringId, method, options) => authFlow.start(offeringId, method, options),
      refreshCredentials: (account, envelope, options) =>
        adapter.refreshCredentials(account, envelope, options.force),
    },
    usage: {
      providerId: "codex",
      fetchUsage: (account, envelope) => adapter.fetchUsage(account, envelope),
      redeemResetCard: (account, envelope, request) =>
        adapter.redeemResetCard(account, envelope, request),
    },
  };
}
