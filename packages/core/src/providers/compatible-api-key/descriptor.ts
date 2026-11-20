import { isCustomProviderId } from "../model-policy.js";
import type { ProviderDescriptor } from "../types.js";

export { isCustomProviderId };
export const compatibleKeyId = "compatible-api-key";
export const officialOpenAiOffering = "openai-api-key";
export const compatibleKeyDescriptor: ProviderDescriptor = {
  provider: compatibleKeyId,
  displayName: "兼容 API Key",
  capabilities: ["multiple-accounts", "model-catalog", "inference"],
  offerings: [
    {
      id: compatibleKeyId,
      provider: compatibleKeyId,
      displayName: "兼容 API Key",
      description: "使用自己的 OpenAI 或 Anthropic 兼容服务和 API Key。",
      iconKey: "api-key",
      supportsSubscriptionUsage: false,
      connectionKind: "editable-routes",
      authMethods: [{ method: "api-key", interaction: "secret-form" }],
      plans: [],
    },
  ],
};
