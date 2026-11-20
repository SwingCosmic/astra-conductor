import type { OfferingRouteConfig } from "@astra-conductor/contract/common";
import type { ProviderOfferingModelPolicy } from "../model-policy.js";

export const bigmodelCodingPlanRouteConfig: OfferingRouteConfig = {
  mode: "fixed",
  allowedProtocols: ["openai-chat", "anthropic-messages"],
  defaults: [
    { protocol: "openai-chat", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
    {
      protocol: "anthropic-messages",
      baseUrl: "https://open.bigmodel.cn/api/anthropic/v1",
      protocolVersion: "2023-06-01",
    },
  ],
};

export const zaiCodingPlanRouteConfig: OfferingRouteConfig = {
  mode: "fixed",
  allowedProtocols: ["openai-chat", "anthropic-messages"],
  defaults: [
    { protocol: "openai-chat", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
    {
      protocol: "anthropic-messages",
      baseUrl: "https://api.z.ai/api/anthropic/v1",
      protocolVersion: "2023-06-01",
    },
  ],
};

function createGlmPolicy(
  offeringId: string,
  routeConfig: OfferingRouteConfig,
): ProviderOfferingModelPolicy {
  return {
    offeringId,
    routeConfig,
    credentialSecretKey: "apiKey",
    transformRequestPlan(plan, { protocol }) {
      if (protocol !== "openai-chat") return plan;
      return { ...plan, outputLimitField: "max_tokens" };
    },
  };
}

export const bigmodelCodingPlanModelPolicy: ProviderOfferingModelPolicy = createGlmPolicy(
  "bigmodel-coding-plan",
  bigmodelCodingPlanRouteConfig,
);

export const zaiCodingPlanModelPolicy: ProviderOfferingModelPolicy = createGlmPolicy(
  "zai-coding-plan",
  zaiCodingPlanRouteConfig,
);
