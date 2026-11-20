import type { OfferingRouteConfig } from "@astra-conductor/contract/common";
import type { ProviderOfferingModelPolicy } from "../model-policy.js";

export const openCodeGoRouteConfig: OfferingRouteConfig = {
  mode: "fixed",
  allowedProtocols: ["openai-chat"],
  defaults: [{ protocol: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1" }],
};

export const openCodeGoModelPolicy: ProviderOfferingModelPolicy = {
  offeringId: "opencode-go",
  routeConfig: openCodeGoRouteConfig,
  credentialSecretKey: "apiKey",
  transformRequestPlan(plan, { protocol }) {
    if (protocol !== "openai-chat") return plan;
    return { ...plan, outputLimitField: "max_tokens" };
  },
};
