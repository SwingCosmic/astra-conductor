import type { ProviderContribution } from "../registry.js";
import type { ProviderPorts } from "../ports.js";
import { glmDescriptor } from "./descriptor.js";
import { GlmAccountProvisioner, GlmAdapter } from "./adapter.js";
import { createGlmAuthFlow } from "./auth-flow.js";

/**
 * GLM 组合工厂：BigModel 与 Z.ai 共享同一实现，接入点差异（端点选择等）
 * 由 offering 声明承载并在实现内部解析。API Key 无主动刷新协议，account
 * facet 不提供无效果的 refreshCredentials。
 */
export function createGlmProvider(ports: ProviderPorts): ProviderContribution {
  const adapter = new GlmAdapter(ports.http.fetch, ports.clock);
  const provisioner = new GlmAccountProvisioner(ports.storage, ports.vault);
  const authFlow = createGlmAuthFlow({ adapter, provisioner });
  return {
    descriptor: glmDescriptor,
    account: {
      providerId: "glm",
      supportedMethods: authFlow.supportedMethods,
      startAuth: (offeringId, method, options) => authFlow.start(offeringId, method, options),
    },
    usage: {
      providerId: "glm",
      fetchUsage: (account, envelope) => adapter.fetchUsage(account, envelope),
      redeemResetCard: (account, envelope, request) =>
        adapter.redeemResetCard(account, envelope, request),
    },
  };
}
