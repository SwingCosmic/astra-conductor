import type { ProviderOfferingModelPolicy } from "../model-policy.js";

export const claudeModelPolicy: ProviderOfferingModelPolicy = {
  offeringId: "claude",

  transformModelFacts(facts, { operation, protocol }) {
    if (operation !== "chat" || protocol !== "anthropic-messages" || facts.reasoningOutputMode) {
      return facts;
    }
    if (facts.reasoningMode === "effort" || facts.reasoningMode === "native-state") {
      return { ...facts, reasoningOutputMode: "summary" };
    }
    return facts;
  },
};
