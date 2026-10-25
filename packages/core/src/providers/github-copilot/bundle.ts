import type { ProviderContribution } from "../registry.js";
import { CoreServices } from "../../services/contracts.js";
import type { ServiceResolver } from "../../services/registry.js";
import { githubCopilotDescriptor } from "./descriptor.js";
import { CopilotAccountProvisioner, CopilotAdapter } from "./adapter.js";
import { createCopilotAuthFlow } from "./auth-flow.js";

/** GitHub Copilot 组合工厂：设备码授权、会话令牌刷新与月度用量拼装。 */
export function createGithubCopilotProvider(services: ServiceResolver): ProviderContribution {
  const adapter = new CopilotAdapter(services);
  const provisioner = new CopilotAccountProvisioner(
    services.get(CoreServices.storage),
    services.get(CoreServices.vault),
  );
  const authFlow = createCopilotAuthFlow({
    adapter,
    provisioner,
  });
  return {
    descriptor: githubCopilotDescriptor,
    account: {
      providerId: "github-copilot",
      supportedMethods: authFlow.supportedMethods,
      startAuth: (offeringId, method, options) => authFlow.start(offeringId, method, options),
      refreshCredentials: (account, envelope, options) =>
        adapter.refreshCredentials(account, envelope, options.force),
    },
    usage: {
      providerId: "github-copilot",
      fetchUsage: (account, envelope) => adapter.fetchUsage(account, envelope),
    },
  };
}
