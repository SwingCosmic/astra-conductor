import type { OfferingRouteConfig } from "@astra-conductor/contract/common";
import type { ProviderOfferingModelPolicy } from "../model-policy.js";
import type { ProviderDescriptor } from "../types.js";

export const geminiRouteConfig: OfferingRouteConfig = {
  mode: "editable",
  groupByFamily: true,
  allowedProtocols: ["gemini-generate-content", "gemini-tts", "gemini-interactions-tts"],
  defaults: [
    {
      protocol: "gemini-generate-content",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      protocolVersion: "v1beta",
    },
    {
      protocol: "gemini-tts",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      protocolVersion: "v1beta",
    },
  ],
};

export const geminiDescriptor: ProviderDescriptor = {
  provider: "gemini",
  displayName: "Google Gemini",
  capabilities: ["multiple-accounts", "model-catalog", "inference"],
  offerings: [
    {
      id: "gemini-api-key",
      provider: "gemini",
      displayName: "Gemini API",
      description:
        "使用 Google Gemini API Key，支持原生 GenerateContent / TTS 与模型目录发现，可自定义协议基础地址。",
      websiteUrl: "https://ai.google.dev/",
      iconKey: "api-key",
      supportsSubscriptionUsage: false,
      connectionKind: "editable-routes",
      routeConfig: geminiRouteConfig,
      authMethods: [{ method: "api-key", interaction: "secret-form", sourceLabel: "API Key" }],
      plans: [],
    },
  ],
};

export const geminiModelPolicy: ProviderOfferingModelPolicy = {
  offeringId: "gemini-api-key",
  routeConfig: geminiRouteConfig,

  transformModelFacts(facts, { operation }) {
    if (operation !== "chat" || facts.reasoningOutputMode) return facts;
    return {
      ...facts,
      reasoningOutputMode: facts.reasoningMode === "none" ? "none" : "summary",
    };
  },
};
