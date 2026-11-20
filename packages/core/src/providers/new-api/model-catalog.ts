import { Decimal } from "decimal.js";
import {
  parseHttpBaseUrl,
  type EndpointProtocol,
  type ModelFacts,
  type ModelPrice,
} from "@astra-conductor/contract/common";
import { AppError } from "../../errors.js";
import type { HttpPort } from "../../ports.js";
import { readModelJson } from "../model-response.js";

export interface NewApiCatalogModel {
  modelId: string;
  displayName: string;
  endpointTypes: string[];
  facts: Partial<ModelFacts>;
  prices: ModelPrice[];
  billing: {
    kind: "token-ratio" | "per-request" | "dynamic" | "unknown";
    modelRatio: number | null;
    completionRatio: number | null;
    /** New API's base USD price per request, before group multipliers. */
    modelPrice: number | null;
  };
}

// Only map New API downstream endpoints with the same request contract. For example,
// its "openai-video" endpoint is not the Grok videos/generations protocol.
export const newApiEndpointTypes: Partial<Record<EndpointProtocol, string>> = {
  "openai-chat": "openai",
  "openai-responses": "openai-response",
  "anthropic-messages": "anthropic",
  "openai-images-generations": "image-generation",
  "openai-embeddings": "embeddings",
};
export function canDiscoverNewApiRoute(protocol: EndpointProtocol): boolean {
  return Object.hasOwn(newApiEndpointTypes, protocol);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function label(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    value.length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function labels(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length <= 64 && value.every(label)
    ? [...new Set<string>(value)]
    : undefined;
}
export function newApiModelEndpointTypes(entry: unknown): string[] | undefined {
  return labels(record(entry).supported_endpoint_types);
}
function ratio(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function invalid(): never {
  throw new AppError("upstream", "New API 站点模型目录格式无效");
}
function modelBilling(row: Record<string, unknown>): NewApiCatalogModel["billing"] {
  const kind =
    row.billing_mode ||
    row.billing_expr ||
    (Array.isArray(row.billing_plugin_variants) && row.billing_plugin_variants.length)
      ? "dynamic"
      : row.quota_type === 0
        ? "token-ratio"
        : row.quota_type === 1
          ? "per-request"
          : "unknown";
  return {
    kind,
    modelRatio: kind === "token-ratio" ? ratio(row.model_ratio) : null,
    completionRatio: kind === "token-ratio" ? ratio(row.completion_ratio) : null,
    modelPrice: kind === "per-request" ? ratio(row.model_price) : null,
  };
}
function modelFacts(row: Record<string, unknown>): Partial<ModelFacts> {
  const facts: Partial<ModelFacts> = {};
  for (const [field, value] of [
    ["contextWindow", row.context_length],
    ["maxOutputTokens", row.max_output_tokens],
  ] as const)
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) facts[field] = value;
  const inputs = labels(row.input_modalities),
    outputs = labels(row.output_modalities);
  if (inputs?.length) facts.inputModalities = inputs;
  if (outputs?.length) facts.outputModalities = outputs;
  const caps = labels(row.capabilities) ?? [];
  if (inputs?.includes("image") || caps.includes("vision")) facts.vision = "supported";
  if (caps.includes("function_calling") || caps.includes("tools")) facts.toolCalling = "supported";
  if (caps.includes("json_mode")) facts.structuredOutput = "json";
  return facts;
}
function groupPrices(
  row: Record<string, unknown>,
  billing: NewApiCatalogModel["billing"],
  groupRatios: Record<string, unknown>,
): ModelPrice[] {
  if (billing.modelRatio === null) return [];
  const enabled = labels(row.enable_groups);
  if (!enabled?.length) return [];
  const groups = enabled.includes("all") ? Object.keys(groupRatios) : enabled;
  const prices: ModelPrice[] = [];
  for (const group of groups) {
    const groupRatio = Object.hasOwn(groupRatios, group) ? ratio(groupRatios[group]) : null;
    if (groupRatio === null || !label(group)) continue;
    // Upstream web/src/features/pricing/lib/price.ts publishes base USD per million
    // tokens as 2 * model_ratio. Keep every quote scoped to its advertised group.
    const base = new Decimal(billing.modelRatio).mul(2).mul(groupRatio);
    for (const [kind, multiplier] of [
      ["input", 1],
      ["output", billing.completionRatio],
      ["cache-read", ratio(row.cache_ratio)],
      ["cache-write", ratio(row.create_cache_ratio)],
    ] as const) {
      if (multiplier === null) continue;
      const amount = base.mul(multiplier).toFixed();
      if (/^\d{1,32}(?:\.\d{1,32})?$/.test(amount))
        prices.push({
          kind,
          amount,
          currency: "USD",
          unit: "million-tokens",
          tier: group,
          durationSeconds: null,
        });
    }
  }
  return prices;
}
export function newApiSiteRoot(siteBaseUrl: string): string {
  try {
    return parseHttpBaseUrl(siteBaseUrl, "siteBaseUrl");
  } catch {
    throw new AppError("validation", "New API 站点地址无效");
  }
}

/** Public listing only. Relay API keys and management credentials are never sent. */
export async function readNewApiCatalog(
  http: HttpPort,
  siteBaseUrl: string,
  signal?: AbortSignal,
): Promise<NewApiCatalogModel[]> {
  const url = newApiSiteRoot(siteBaseUrl) + "/api/pricing";
  const deadline = AbortSignal.timeout(10_000);
  const boundSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response: Response;
  try {
    boundSignal.throwIfAborted();
    response = await http.fetch(url, {
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: boundSignal,
    });
  } catch {
    throw new AppError("network", "无法读取 New API 站点模型目录", true);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      response.status === 401 || response.status === 403
        ? "permission"
        : response.status === 429
          ? "rate-limit"
          : "upstream",
      "New API 站点模型目录请求失败（HTTP " + response.status + "）",
      response.status === 429 || response.status >= 500,
    );
  }
  const body = record(await readModelJson(response, 4 * 1024 * 1024, invalid));
  if (boundSignal.aborted) throw new AppError("network", "读取 New API 模型目录已中止", true);
  if (body.success !== true || !Array.isArray(body.data) || body.data.length > 10000)
    return invalid();
  const groups = record(body.group_ratio);
  if (Object.keys(groups).length > 256) return invalid();
  const models = new Map<string, NewApiCatalogModel>();
  let priceCount = 0;
  for (const value of body.data) {
    const row = record(value);
    if (!label(row.model_name) || models.has(row.model_name)) return invalid();
    const billing = modelBilling(row);
    const prices = groupPrices(row, billing, groups);
    priceCount += prices.length;
    if (priceCount > 100_000) return invalid();
    models.set(row.model_name, {
      modelId: row.model_name,
      displayName: label(row.display_name) ? row.display_name : row.model_name,
      endpointTypes: newApiModelEndpointTypes(row) ?? [],
      facts: modelFacts(row),
      prices,
      billing,
    });
  }
  return [...models.values()];
}
