import type { ProviderContribution } from "../registry.js";
import type { ProviderPorts } from "../ports.js";
import { codexDescriptor } from "./descriptor.js";
import { CodexAccountProvisioner, CodexAdapter } from "./adapter.js";
import { createCodexAuthFlow } from "./auth-flow.js";

/** Codex 组合工厂：adapter、provisioner、auth-flow 的拼装属于本供应商的知识。 */
export function createCodexProvider(ports: ProviderPorts): ProviderContribution {
  const adapter = new CodexAdapter(ports.http.fetch, ports.clock);
  const provisioner = new CodexAccountProvisioner(ports.storage, ports.vault);
  const authFlow = createCodexAuthFlow({
    adapter,
    provisioner,
    openExternal: (url) => ports.browser.openExternal(url),
    startCallbackServer: ports.callbackServer.start,
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
