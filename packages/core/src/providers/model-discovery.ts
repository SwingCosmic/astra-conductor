import {
  modelEndpointDescriptor,
  type EndpointProtocol,
  type ModelFacts,
  type ModelPrice,
  type ModelRoute,
} from "@astra-conductor/contract/common";
import { AppError } from "../errors.js";
import type { Account, CredentialEnvelope } from "../models.js";
import type { HttpPort } from "../ports.js";
import { getBuiltInModelPolicy } from "./catalog.js";
import {
  applyAsyncPolicyChain,
  applyPolicyChain,
  type CatalogPage,
  type DiscoveredModel,
  type ProviderOfferingModelPolicy,
} from "./model-policy.js";
import { readModelJson } from "./model-response.js";
import { modelAuthorization, type ConnectionProviderSource } from "./model-routes.js";

export type { DiscoveredModel };

const maxModelPrices = 64;

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

function parseModel(value: unknown, anthropic: boolean): DiscoveredModel {
  const m = record(value);
  const modelId = label(m.id) ?? invalidCatalog();
  const facts: Partial<ModelFacts> = {};
  for (const [key, val] of [
    ["contextWindow", m.context_window ?? m.context_length],
    ["maxInputTokens", m.max_input_tokens],
    ["maxOutputTokens", m.max_output_tokens ?? (anthropic ? m.max_tokens : undefined)],
  ] as const) {
    if (typeof val === "number" && Number.isSafeInteger(val) && val > 0) facts[key] = val;
  }
  const input = labels(m.input_modalities);
  const output = labels(m.output_modalities);
  if (input) {
    facts.inputModalities = input;
    facts.vision = input.includes("image") ? "supported" : "unsupported";
  }
  if (output) facts.outputModalities = output;
  const caps = record(m.capabilities);
  const vision = record(caps.image_input).supported;
  if (typeof vision === "boolean") facts.vision = vision ? "supported" : "unsupported";
  const structured = record(caps.structured_outputs).supported;
  if (typeof structured === "boolean") {
    facts.structuredOutput = structured ? "schema" : "unsupported";
  }
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
    if (defined.length) {
      facts.effortLevels = defined
        .filter(([, value]) => record(value).supported === true)
        .map(([key]) => key);
    }
  }
  const defaultEffort = label(effort.default_level ?? m.default_reasoning_level);
  if (defaultEffort && (!facts.effortLevels || facts.effortLevels.includes(defaultEffort))) {
    facts.defaultEffort = defaultEffort;
  }
  // Only accept quotes carrying explicit billing dimensions. A bare number has no currency or unit.
  const prices: ModelPrice[] = [];
  if (Array.isArray(m.prices) && m.prices.length <= maxModelPrices) {
    for (const item of m.prices) {
      const p = record(item);
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
      ) {
        continue;
      }
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

function containsCredential(value: unknown, secrets: CredentialEnvelope["secrets"]): boolean {
  const serialized = JSON.stringify(value);
  return Object.values(secrets).some(
    (secret) =>
      typeof secret === "string" &&
      !!secret &&
      serialized.includes(JSON.stringify(secret).slice(1, -1)),
  );
}

function resolveDiscoveryPolicy(
  account: Account,
  source?: ConnectionProviderSource,
  policy?: ProviderOfferingModelPolicy,
): ProviderOfferingModelPolicy | undefined {
  if (policy) return policy;
  return (
    getBuiltInModelPolicy({
      providerId: account.provider,
      offeringId: account.offeringId,
      templateKind: source?.templateKind?.(account.provider),
    }) ?? undefined
  );
}

export function modelDirectoryUrl(
  account: Account,
  route: ModelRoute,
  policy?: ProviderOfferingModelPolicy,
  source?: ConnectionProviderSource,
): URL {
  const activePolicy = resolveDiscoveryPolicy(account, source, policy);
  const query = applyPolicyChain({ ...(route.familyPolicy?.query ?? {}) }, { account, route }, [
    activePolicy?.transformCatalogQuery,
  ]);
  const url = new URL(route.baseUrl + "/models");
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return url;
}

export function projectDiscoveredModels(
  models: DiscoveredModel[],
  protocol: EndpointProtocol,
): DiscoveredModel[] {
  const descriptor = modelEndpointDescriptor(protocol);
  if (!descriptor.canDiscover) return [];
  return models.map(({ endpointTypes: _, ...entry }) => entry);
}

/** A partial page sequence never becomes a successful catalog. */
export async function discoverRouteModels(
  http: HttpPort,
  account: Account,
  envelope: CredentialEnvelope,
  route: ModelRoute,
  signal?: AbortSignal,
  source?: ConnectionProviderSource,
  scope: "route" | "family" = "route",
  policy?: ProviderOfferingModelPolicy,
): Promise<DiscoveredModel[]> {
  const activePolicy = resolveDiscoveryPolicy(account, source, policy);
  if (route.familyCatalog === "none" || (route.protocolFamily && !route.familyBindingRevision)) {
    throw new AppError("capability-unavailable", "该协议族没有可用目录，请检查族配置或手工登记");
  }
  const canDiscover =
    modelEndpointDescriptor(route.protocol).canDiscover ||
    Boolean(activePolicy?.discoverableProtocols?.includes(route.protocol));
  if (!canDiscover) {
    throw new AppError("capability-unavailable", "该媒体端点使用手工模型登记");
  }

  const headers = modelAuthorization(
    account,
    envelope,
    route,
    undefined,
    "models",
    source,
    activePolicy,
  );
  const url = modelDirectoryUrl(account, route, activePolicy, source);
  const deadline = AbortSignal.timeout(45_000);
  const boundSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const cursors = new Set<string>();
  const models = new Map<string, DiscoveredModel>();
  const rawEntriesByModelId = new Map<string, unknown[]>();
  const siteBaseUrl = source?.newApiSite?.(account.provider, account.offeringId);

  for (let page = 0; page < 100; page++) {
    let response: Response;
    try {
      boundSignal.throwIfAborted();
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
    if (data.has_more !== undefined && typeof data.has_more !== "boolean") {
      return invalidCatalog();
    }
    const initialPage: CatalogPage = {
      entries: Array.isArray(data.data) ? data.data : null,
      hasMore: data.has_more === true,
      ...(label(data.last_id) ? { lastId: label(data.last_id) } : {}),
    };
    const parsedPage = applyPolicyChain(initialPage, { account, route, raw }, [
      activePolicy?.transformCatalogPage,
    ]);
    if (!parsedPage.entries || parsedPage.entries.length > 10000) {
      return invalidCatalog();
    }

    for (const entry of parsedPage.entries) {
      const model = parseModel(entry, route.protocol === "anthropic-messages");
      // Do not let a misbehaving upstream reflect credential material into model metadata.
      if (containsCredential(model, envelope.secrets)) return invalidCatalog();
      const existing = models.get(model.modelId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(model)) {
        return invalidCatalog();
      }
      models.set(model.modelId, model);
      const rawList = rawEntriesByModelId.get(model.modelId) ?? [];
      rawList.push(entry);
      rawEntriesByModelId.set(model.modelId, rawList);
      if (models.size > 10000) return invalidCatalog();
    }

    if (!parsedPage.hasMore) {
      const initialCandidates = [...models.values()];
      if (activePolicy?.transformCatalogCandidates) {
        return applyAsyncPolicyChain(
          initialCandidates,
          {
            http,
            account,
            route,
            scope,
            siteBaseUrl,
            signal: boundSignal,
            rawEntriesByModelId,
            containsCredential: (value) => containsCredential(value, envelope.secrets),
          },
          [activePolicy.transformCatalogCandidates],
        );
      }
      return scope === "family"
        ? initialCandidates
        : projectDiscoveredModels(initialCandidates, route.protocol);
    }

    const cursor = parsedPage.lastId;
    if (!cursor || !parsedPage.entries.length || cursors.has(cursor)) {
      return invalidCatalog();
    }
    cursors.add(cursor);
    url.searchParams.set(route.protocol === "anthropic-messages" ? "after_id" : "after", cursor);
  }
  return invalidCatalog();
}
