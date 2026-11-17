import type { ModelRoute, ModelFacts, ModelPrice } from "@astra-conductor/contract/common";
import { DEFAULT_CODEX_CLIENT_VERSION } from "@omniroute/src/shared/constants/codexClient.ts";
import type { Account, CredentialEnvelope } from "../models.js";
import type { HttpPort } from "../ports.js";
import { readModelJson } from "./model-response.js";
import { AppError } from "../errors.js";
import { modelEndpointDescriptor } from "@astra-conductor/contract/common";
import { modelAuthorization, type ConnectionProviderSource } from "./model-routes.js";

export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  facts: Partial<ModelFacts>;
  prices: ModelPrice[];
}

function invalidCatalog(): never {
  throw new AppError("upstream", "模型列表格式无效，原目录已保留");
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function label(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.trim() &&
    value.length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : undefined;
}
function labels(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length <= 64 && value.every((v) => label(v) !== undefined)
    ? (value as string[])
    : undefined;
}
function parseModel(value: unknown, codex: boolean, anthropic: boolean): DiscoveredModel {
  const m = record(value);
  const modelId = label(codex ? (m.slug ?? m.id) : m.id) ?? invalidCatalog();
  const facts: Partial<ModelFacts> = {};
  for (const [key, val] of [
    ["contextWindow", m.context_window ?? m.context_length],
    ["maxInputTokens", m.max_input_tokens],
    ["maxOutputTokens", m.max_output_tokens ?? (anthropic ? m.max_tokens : undefined)],
  ] as const)
    if (typeof val === "number" && Number.isSafeInteger(val) && val > 0) facts[key] = val;
  const input = labels(m.input_modalities),
    output = labels(m.output_modalities);
  if (input) {
    facts.inputModalities = input;
    facts.vision = input.includes("image") ? "supported" : "unsupported";
  }
  if (output) facts.outputModalities = output;
  const caps = record(m.capabilities);
  const vision = record(caps.image_input).supported;
  if (typeof vision === "boolean") facts.vision = vision ? "supported" : "unsupported";
  const structured = record(caps.structured_outputs).supported;
  if (typeof structured === "boolean")
    facts.structuredOutput = structured ? "schema" : "unsupported";
  const effort = record(m.effort);
  const levels =
    labels(effort.supported_levels) ??
    labels(
      Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((v) => (typeof v === "string" ? v : record(v).effort))
        : undefined,
    );
  if (levels) {
    facts.effortLevels = levels;
    facts.reasoningMode = levels.length ? "effort" : "none";
  }
  const anthropicEffort = record(caps.effort);
  if (typeof anthropicEffort.supported === "boolean") {
    facts.reasoningMode = anthropicEffort.supported
      ? "effort"
      : record(caps.thinking).supported === true
        ? "native-state"
        : "none";
    const defined = Object.entries(anthropicEffort).filter(
      ([key, value]) => key !== "supported" && typeof record(value).supported === "boolean",
    );
    if (defined.length)
      facts.effortLevels = defined
        .filter(([, value]) => record(value).supported === true)
        .map(([key]) => key);
  }
  const defaultEffort = label(effort.default_level ?? m.default_reasoning_level);
  if (defaultEffort && (!facts.effortLevels || facts.effortLevels.includes(defaultEffort)))
    facts.defaultEffort = defaultEffort;
  // Only accept quotes carrying explicit billing dimensions. A bare number has no currency or unit.
  const prices: ModelPrice[] = [];
  if (Array.isArray(m.prices) && m.prices.length <= 64) {
    for (const value of m.prices) {
      const p = record(value);
      if (
        !["input", "output", "cache-read", "cache-write"].includes(String(p.kind)) ||
        typeof p.amount !== "string" ||
        !/^\d{1,32}(?:\.\d{1,32})?$/.test(p.amount) ||
        typeof p.currency !== "string" ||
        !/^[A-Z]{3}$/.test(p.currency) ||
        typeof p.unit !== "string" ||
        !/^[a-zA-Z0-9/_-]{1,64}$/.test(p.unit) ||
        (p.tier != null && !label(p.tier)) ||
        (p.durationSeconds != null &&
          (typeof p.durationSeconds !== "number" ||
            !Number.isSafeInteger(p.durationSeconds) ||
            p.durationSeconds <= 0))
      )
        continue;
      prices.push({
        kind: p.kind as ModelPrice["kind"],
        amount: p.amount,
        currency: p.currency,
        unit: p.unit,
        tier: label(p.tier) ?? null,
        durationSeconds: typeof p.durationSeconds === "number" ? p.durationSeconds : null,
      });
    }
  }
  return { modelId, displayName: label(m.display_name ?? m.name) ?? modelId, facts, prices };
}

/** A partial page sequence never becomes a successful catalog. */
export async function discoverRouteModels(
  http: HttpPort,
  account: Account,
  envelope: CredentialEnvelope,
  route: ModelRoute,
  signal?: AbortSignal,
  source?: ConnectionProviderSource,
): Promise<DiscoveredModel[]> {
  if (!modelEndpointDescriptor(route.protocolRouteId).canDiscover)
    throw new AppError("capability-unavailable", "该媒体端点使用手工模型登记");
  const headers = modelAuthorization(account, envelope, route, undefined, "models", source);
  const url = new URL(route.baseUrl + "/models");
  const codex = account.provider === "codex" && account.offeringId === "codex";
  if (codex) url.searchParams.set("client_version", DEFAULT_CODEX_CLIENT_VERSION);
  const deadline = AbortSignal.timeout(45_000);
  const boundSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const cursors = new Set<string>();
  const models = new Map<string, DiscoveredModel>();
  for (let page = 0; page < 100; page++) {
    let response: Response;
    try {
      response = await http.fetch(url, {
        headers,
        credentials: "omit",
        redirect: "error",
        signal: boundSignal,
      });
    } catch {
      throw new AppError("network", "无法读取供应商模型列表", true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      throw new AppError(
        status === 401 || status === 403
          ? "authentication"
          : status === 429
            ? "rate-limit"
            : "upstream",
        `供应商模型列表请求失败（HTTP ${status}）`,
        status === 429 || status >= 500,
      );
    }
    const raw = await readModelJson(response, 4 * 1024 * 1024, invalidCatalog);
    const data = record(raw);
    const grok = account.provider === "grok-build";
    const entries =
      grok && Array.isArray(raw) ? raw : codex || grok ? (data.models ?? data.data) : data.data;
    if (!Array.isArray(entries) || entries.length > 10000) return invalidCatalog();
    for (const entry of entries) {
      if (codex && record(entry).visibility === "hide") continue;
      let value = entry;
      if (grok) {
        const item = record(entry),
          meta = record(item._meta);
        if (
          item.hidden === true ||
          meta.hidden === true ||
          (item.apiBackend ?? item.api_backend ?? meta.apiBackend ?? meta.api_backend) !==
            "responses"
        )
          continue;
        value = {
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
        };
      }
      const model = parseModel(value, codex, route.protocolRouteId === "anthropic-messages");
      // Do not let a misbehaving upstream reflect credential material into model metadata.
      const publicModel = JSON.stringify(model);
      if (
        Object.values(envelope.secrets).some(
          (secret) =>
            typeof secret === "string" &&
            secret &&
            publicModel.includes(JSON.stringify(secret).slice(1, -1)),
        )
      )
        return invalidCatalog();
      const existing = models.get(model.modelId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(model)) return invalidCatalog();
      models.set(model.modelId, model);
      if (models.size > 10000) return invalidCatalog();
    }
    if (data.has_more === undefined || data.has_more === false) return [...models.values()];
    const cursor = label(data.last_id);
    if (data.has_more !== true || !cursor || !entries.length || cursors.has(cursor))
      return invalidCatalog();
    cursors.add(cursor);
    url.searchParams.set(
      route.protocolRouteId === "anthropic-messages" ? "after_id" : "after",
      cursor,
    );
  }
  return invalidCatalog();
}
