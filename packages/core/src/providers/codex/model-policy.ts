import type { OfferingRouteConfig } from "@astra-conductor/contract/common";
import {
  DEFAULT_CODEX_CLIENT_VERSION,
  getCodexCliRsHeaders,
} from "@omniroute/src/shared/constants/codexClient.ts";
import { AppError } from "../../errors.js";
import type { ProviderOfferingModelPolicy } from "../model-policy.js";

export const codexRouteConfig: OfferingRouteConfig = {
  mode: "fixed",
  allowedProtocols: ["openai-responses"],
  defaults: [{ protocol: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" }],
};

export const openAiApiKeyRouteConfig: OfferingRouteConfig = {
  mode: "fixed",
  allowedProtocols: ["openai-chat", "openai-responses"],
  defaults: [
    { protocol: "openai-chat", baseUrl: "https://api.openai.com/v1" },
    { protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  ],
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const codexModelPolicy: ProviderOfferingModelPolicy = {
  offeringId: "codex",
  routeConfig: codexRouteConfig,
  catalogMode: "vendor",

  transformModelFacts(facts, { operation, protocol }) {
    if (operation !== "chat" || protocol !== "openai-responses" || facts.reasoningOutputMode) {
      return facts;
    }
    return { ...facts, reasoningOutputMode: "summary" };
  },

  transformCatalogQuery(query) {
    return {
      ...query,
      client_version: DEFAULT_CODEX_CLIENT_VERSION,
    };
  },

  transformCatalogPage(page, { raw }) {
    const data = record(raw);
    const items = data.models ?? data.data;
    if (!Array.isArray(items)) return { ...page, entries: null };
    const entries = items
      .filter((entry) => record(entry).visibility !== "hide")
      .map((entry) => {
        const item = record(entry);
        return {
          ...item,
          id: item.slug ?? item.id,
        };
      });
    return { ...page, entries };
  },

  transformRequestPlan(plan) {
    if (
      plan.parameters.maxOutputTokens != null ||
      plan.parameters.temperature != null ||
      plan.parameters.topP != null
    ) {
      throw new AppError("validation", "Codex 订阅接口不接受最大输出 token、温度或 top P");
    }
    const forbiddenFields = [
      ...new Set([
        ...plan.constraints.forbiddenFields,
        "max_output_tokens",
        "temperature",
        "top_p",
      ]),
    ];
    const requiredNonEmptyStrings = [
      ...new Set([...(plan.constraints.requiredNonEmptyStrings ?? []), "instructions"]),
    ];
    return {
      ...plan,
      constraints: {
        ...plan.constraints,
        requiredFields: {
          ...plan.constraints.requiredFields,
          stream: true,
          store: false,
        },
        forbiddenFields,
        requiredNonEmptyStrings,
      },
    };
  },

  transformProtocolRequest(draft) {
    if (
      ["max_output_tokens", "temperature", "top_p"].some((field) =>
        Object.hasOwn(draft.body, field),
      )
    ) {
      throw new AppError("validation", "Codex 订阅接口不接受最大输出 token、温度或 top P");
    }
    const instructions =
      typeof draft.body.instructions === "string" && draft.body.instructions.trim()
        ? draft.body.instructions
        : "Answer the user's question.";
    return {
      ...draft,
      body: {
        ...draft.body,
        stream: true,
        store: false,
        instructions,
      },
      headers: {
        ...draft.headers,
        accept: "text/event-stream",
      },
    };
  },

  transformAuthHeaders(headers, { account, envelope }) {
    const next: Record<string, string> = {
      ...headers,
      ...getCodexCliRsHeaders(),
    };
    const workspace = account.publicMetadata.workspaceId;
    if (typeof workspace === "string" && workspace) {
      next["chatgpt-account-id"] = envelope ? workspace : "<redacted>";
    }
    return next;
  },
};

export const openAiApiKeyModelPolicy: ProviderOfferingModelPolicy = {
  offeringId: "openai-api-key",
  routeConfig: openAiApiKeyRouteConfig,

  transformModelFacts(facts, { operation, protocol }) {
    if (operation !== "chat" || protocol !== "openai-responses" || facts.reasoningOutputMode) {
      return facts;
    }
    if (facts.reasoningMode === "effort" || facts.reasoningMode === "native-state") {
      return { ...facts, reasoningOutputMode: "summary" };
    }
    return facts;
  },

  transformChatAvailability(availability, ctx) {
    if (availability.state !== "enabled") return availability;
    if (ctx.exactVendorPreset && !ctx.exactVendorPreset.operations.includes("chat")) {
      return { state: "disabled", reason: "该官方型号属于其他操作" };
    }
    if (!ctx.manual && !ctx.exactVendorPreset && !ctx.remoteOperations?.includes("chat")) {
      return { state: "disabled", reason: "目录仅返回型号 ID，请在此账号和端点手工确认聊天用途" };
    }
    return availability;
  },
};
