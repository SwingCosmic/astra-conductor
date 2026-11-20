import type { JsonValue, OfferingRouteConfig } from "@astra-conductor/contract/common";
import {
  GROK_BUILD_DEFAULT_REASONING_EFFORT,
  GROK_BUILD_PROXY_BASE_URL,
  GROK_BUILD_REASONING_INCLUDE,
  GROK_BUILD_SUPPORTED_REASONING_EFFORTS,
  getGrokBuildModelsHeaders,
  getGrokBuildSessionHeaders,
} from "@omniroute/open-sse/config/grokBuild.ts";
import { AppError } from "../../errors.js";
import type { ProviderOfferingModelPolicy } from "../model-policy.js";

export const grokBuildRouteConfig: OfferingRouteConfig = {
  mode: "fixed",
  allowedProtocols: ["openai-responses"],
  defaults: [{ protocol: "openai-responses", baseUrl: GROK_BUILD_PROXY_BASE_URL }],
};

// Upstream listing metadata does not carry these per-model facts yet, so they stay
// vendor-derived protocol knowledge here instead of in the generic chat compiler.
const effortFreeModels = new Set(["grok-composer-2.5-fast"]);
const modelsNeedingDefaultEffort = new Set(["grok-4.5", "grok-4.6"]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rejectUnsupportedGrokEffort(modelId: string, effort: string): void {
  if (effortFreeModels.has(modelId) || !GROK_BUILD_SUPPORTED_REASONING_EFFORTS.includes(effort)) {
    throw new AppError("validation", "Grok Build 模型不支持所选思考强度");
  }
}

function grokBuildFallbackEffort(modelId: string): string | null {
  return modelsNeedingDefaultEffort.has(modelId) ? GROK_BUILD_DEFAULT_REASONING_EFFORT : null;
}

export const grokBuildModelPolicy: ProviderOfferingModelPolicy = {
  offeringId: "grok-build",
  routeConfig: grokBuildRouteConfig,
  catalogMode: "vendor",

  transformCatalogPage(page, { raw }) {
    const data = record(raw);
    const items = Array.isArray(raw) ? raw : (data.models ?? data.data);
    if (!Array.isArray(items)) return { ...page, entries: null };
    const entries: Record<string, unknown>[] = [];
    for (const entry of items) {
      const item = record(entry);
      const meta = record(item._meta);
      if (
        item.hidden === true ||
        meta.hidden === true ||
        (item.apiBackend ?? item.api_backend ?? meta.apiBackend ?? meta.api_backend) !== "responses"
      ) {
        continue;
      }
      entries.push({
        ...item,
        id: item.model ?? item.modelId ?? item.id ?? meta.model ?? meta.modelId,
        context_window:
          item.contextWindow ??
          item.context_window ??
          meta.contextWindow ??
          meta.totalContextTokens,
        max_output_tokens: item.maxCompletionTokens ?? item.max_completion_tokens,
        effort: {
          supported_levels:
            item.reasoningEfforts ??
            item.reasoning_efforts ??
            meta.reasoningEfforts ??
            meta.reasoning_efforts,
        },
      });
    }
    return { ...page, entries };
  },

  transformRequestPlan(plan) {
    let nextParameters = plan.parameters;
    let effectiveEffort =
      plan.thinkingActive && !plan.consumedParameters.includes("effort")
        ? plan.parameters.effort
        : null;

    if (plan.thinkingActive && !plan.consumedParameters.includes("effort")) {
      if (effectiveEffort) {
        rejectUnsupportedGrokEffort(plan.upstreamModelId, effectiveEffort);
      } else {
        const fallback = grokBuildFallbackEffort(plan.upstreamModelId);
        if (fallback) {
          effectiveEffort = fallback;
          nextParameters = { ...plan.parameters, effort: fallback };
        }
      }
    }

    const requiredFields: Record<string, JsonValue> = {
      ...plan.constraints.requiredFields,
      stream: true,
    };
    if (plan.thinkingActive && effectiveEffort) {
      requiredFields["reasoning.effort"] = effectiveEffort;
    }

    const requiredArrayItems = plan.thinkingActive
      ? {
          ...plan.constraints.requiredArrayItems,
          include: [GROK_BUILD_REASONING_INCLUDE] as readonly JsonValue[],
        }
      : plan.constraints.requiredArrayItems;

    return {
      ...plan,
      parameters: nextParameters,
      constraints: {
        ...plan.constraints,
        requiredFields,
        ...(requiredArrayItems ? { requiredArrayItems } : {}),
      },
    };
  },

  transformProtocolRequest(draft, { plan }) {
    const existingInclude = Array.isArray(draft.body.include) ? draft.body.include : [];
    const include = plan.thinkingActive
      ? existingInclude.includes(GROK_BUILD_REASONING_INCLUDE)
        ? existingInclude
        : [...existingInclude, GROK_BUILD_REASONING_INCLUDE]
      : undefined;
    return {
      ...draft,
      body: {
        ...draft.body,
        stream: true,
        ...(include ? { include } : {}),
      },
      headers: {
        ...draft.headers,
        accept: "text/event-stream",
      },
    };
  },

  transformAuthHeaders(_headers, { account, envelope, operation, modelId, secret }) {
    const identity = (key: string) => {
      const value = account.publicMetadata[key];
      return typeof value === "string" && value ? (envelope ? value : "<redacted>") : undefined;
    };
    const rawType = account.publicMetadata.principalType;
    const options = {
      token: secret,
      userId: identity("userId"),
      email: identity("email"),
      principalType: typeof rawType === "string" ? rawType : undefined,
    };
    const grokHeaders =
      operation === "models"
        ? getGrokBuildModelsHeaders(options)
        : getGrokBuildSessionHeaders({ ...options, stream: true, model: modelId });
    if (!envelope) grokHeaders.Authorization = "<redacted>";
    return grokHeaders;
  },
};
