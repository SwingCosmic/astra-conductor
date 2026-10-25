import { readZCodeCodingPlanApiKey } from "./zcode-credentials.js";
import type { ProviderContribution } from "../registry.js";
import { CoreServices } from "../../services/contracts.js";
import type { ServiceResolver } from "../../services/registry.js";
import { glmDescriptor } from "./descriptor.js";
import { GlmAccountProvisioner, GlmAdapter } from "./adapter.js";
import { createGlmAuthFlow } from "./auth-flow.js";

/**
 * GLM 组合工厂：BigModel 与 Z.ai 共享同一实现，接入点差异（端点选择等）
 * 由 offering 声明承载并在实现内部解析。API Key 无主动刷新协议，account
 * facet 不提供无效果的 refreshCredentials。
 */
export function createGlmProvider(services: ServiceResolver): ProviderContribution {
  const adapter = new GlmAdapter(services);
  const provisioner = new GlmAccountProvisioner(
    services.get(CoreServices.storage),
    services.get(CoreServices.vault),
  );
  const files = services.get(CoreServices.files);
  const environment = services.get(CoreServices.environment);
  const authFlow = createGlmAuthFlow({
    adapter,
    provisioner,
    readZCodeCredentials: (offeringId) =>
      readZCodeCodingPlanApiKey(offeringId, {
        readText: files.readText,
        homeDirectory: environment.homeDirectory(),
        env: {
          ZCODE_DATA_BASE_DIR: environment.env("ZCODE_DATA_BASE_DIR"),
          ZCODE_CREDENTIAL_SECRET: environment.env("ZCODE_CREDENTIAL_SECRET"),
        },
      }),
  });
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
