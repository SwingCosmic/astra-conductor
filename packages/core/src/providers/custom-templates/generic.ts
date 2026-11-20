import type { ProviderOfferingModelPolicy } from "../model-policy.js";

export const genericModelPolicy: ProviderOfferingModelPolicy = {
  offeringId: "generic",

  transformRequestPlan(plan, { protocol, route }) {
    if (protocol !== "openai-chat") return plan;
    return {
      ...plan,
      outputLimitField: route.chatOutputLimitField ?? "max_completion_tokens",
    };
  },
};
