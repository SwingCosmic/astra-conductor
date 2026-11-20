import type { OfferingRouteConfig } from "@astra-conductor/contract/common";
import type { ProviderOfferingModelPolicy } from "../model-policy.js";
import type { ProviderDescriptor } from "../types.js";

export const deepSeekRouteConfig: OfferingRouteConfig = {
  mode: "editable",
  groupByFamily: true,
  allowedProtocols: ["openai-chat", "openai-responses", "anthropic-messages"],
  defaults: [
    { protocol: "openai-chat", baseUrl: "https://api.deepseek.com" },
    { protocol: "openai-responses", baseUrl: "https://api.deepseek.com" },
    {
      protocol: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic/v1",
      protocolVersion: "2023-06-01",
    },
  ],
};

export const deepSeekDescriptor: ProviderDescriptor = {
  provider: "deepseek",
  displayName: "DeepSeek",
  capabilities: ["multiple-accounts", "model-catalog", "inference"],
  offerings: [
    {
      id: "deepseek-api-key",
      provider: "deepseek",
      displayName: "DeepSeek API",
      description: "使用 DeepSeek API Key，可配置协议基础地址。",
      iconKey: "api-key",
      supportsSubscriptionUsage: false,
      connectionKind: "editable-routes",
      routeConfig: deepSeekRouteConfig,
      authMethods: [{ method: "api-key", interaction: "secret-form" }],
      plans: [],
    },
  ],
};

export const deepSeekModelPolicy: ProviderOfferingModelPolicy = {
  offeringId: "deepseek-api-key",
  routeConfig: deepSeekRouteConfig,

  transformModelFacts(facts, { operation }) {
    if (operation !== "chat" || facts.reasoningOutputMode) return facts;
    return {
      ...facts,
      reasoningOutputMode: facts.reasoningMode === "none" ? "none" : "full",
    };
  },

  transformRequestPlan(plan, { protocol, facts }) {
    const supportsToggle = facts.reasoningMode !== "none";
    const warnings =
      facts.reasoningMode === "unknown"
        ? [
            ...plan.warnings,
            {
              code: "reasoning-unverified",
              message: "该型号的思考开关能力尚未从目录或预置核实。",
            },
          ]
        : plan.warnings;
    const requiredFields = { ...plan.constraints.requiredFields };
    const forbiddenFields = [...plan.constraints.forbiddenFields];

    if (protocol === "openai-chat") {
      if (!supportsToggle) {
        forbiddenFields.push("thinking", "reasoning_effort");
        return {
          ...plan,
          outputLimitField: "max_tokens",
          suppressEffortField: true,
          constraints: { ...plan.constraints, requiredFields, forbiddenFields },
          warnings,
        };
      }
      const type = plan.thinkingActive ? "enabled" : "disabled";
      requiredFields["thinking.type"] = type;
      if (!plan.thinkingActive) forbiddenFields.push("reasoning_effort");
      return {
        ...plan,
        outputLimitField: "max_tokens",
        suppressEffortField: !plan.thinkingActive,
        constraints: { ...plan.constraints, requiredFields, forbiddenFields },
        warnings,
      };
    }

    if (protocol === "openai-responses") {
      if (!supportsToggle) {
        forbiddenFields.push("reasoning");
        return {
          ...plan,
          suppressEffortField: true,
          suppressSummaryRequest: true,
          constraints: { ...plan.constraints, requiredFields, forbiddenFields },
          warnings,
        };
      }
      if (!plan.thinkingActive) requiredFields["reasoning.effort"] = "none";
      return {
        ...plan,
        suppressEffortField: !plan.thinkingActive,
        suppressSummaryRequest: true,
        constraints: { ...plan.constraints, requiredFields, forbiddenFields },
        warnings,
      };
    }

    // anthropic-messages
    if (!supportsToggle) {
      forbiddenFields.push("thinking");
      return {
        ...plan,
        suppressEffortField: true,
        suppressSummaryRequest: true,
        constraints: { ...plan.constraints, requiredFields, forbiddenFields },
        warnings,
      };
    }
    const type = plan.thinkingActive ? "enabled" : "disabled";
    requiredFields["thinking.type"] = type;
    if (!plan.thinkingActive) forbiddenFields.push("output_config.effort");
    return {
      ...plan,
      suppressEffortField: !plan.thinkingActive,
      suppressSummaryRequest: true,
      constraints: { ...plan.constraints, requiredFields, forbiddenFields },
      warnings,
    };
  },

  transformProtocolRequest(draft, { protocol, plan, facts }) {
    if (facts.reasoningMode === "none") return draft;
    if (protocol === "openai-responses") {
      if (plan.thinkingActive) return draft;
      return {
        ...draft,
        body: { ...draft.body, reasoning: { effort: "none" } },
      };
    }
    return {
      ...draft,
      body: {
        ...draft.body,
        thinking: { type: plan.thinkingActive ? "enabled" : "disabled" },
      },
    };
  },
};
