import { modelEndpointDescriptor, type EndpointProtocol } from "@astra-conductor/contract/common";
import { AppError } from "../../errors.js";
import type { DiscoveredModel, ProviderOfferingModelPolicy } from "../model-policy.js";
import {
  newApiEndpointTypes,
  newApiModelEndpointTypes,
  newApiSiteRoot,
  readNewApiCatalog,
  type NewApiCatalogModel,
} from "./model-catalog.js";

const maxModelPrices = 64;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function projectNewApiFamilyModels(
  models: DiscoveredModel[],
  protocol: EndpointProtocol,
): DiscoveredModel[] {
  const descriptor = modelEndpointDescriptor(protocol);
  const required = newApiEndpointTypes[protocol];
  return models.flatMap((model) => {
    const { endpointTypes, ...entry } = model;
    if (!endpointTypes) return descriptor.canDiscover ? [entry] : [];
    if (
      !required ||
      (endpointTypes.length ? !endpointTypes.includes(required) : !descriptor.canDiscover)
    ) {
      return [];
    }
    return [
      {
        ...entry,
        routeSupport: endpointTypes.length ? ("confirmed" as const) : ("unconfirmed" as const),
        facts: {
          ...(endpointTypes.length ? { operations: [descriptor.operation] } : {}),
          ...entry.facts,
        },
      },
    ];
  });
}

export const newApiModelPolicy: ProviderOfferingModelPolicy = {
  offeringId: "new-api",
  discoverableProtocols: Object.keys(newApiEndpointTypes) as EndpointProtocol[],

  transformCatalogPage(page, { route, raw }) {
    const data = record(raw);
    if (data.success === false || data.error != null) {
      return { ...page, entries: null };
    }
    if (!page.entries) return page;
    const kindField = route.protocol === "anthropic-messages" ? "type" : "object";
    for (const entry of page.entries) {
      const kind = record(entry)[kindField];
      if (kind !== undefined && kind !== "model") {
        return { ...page, entries: null };
      }
    }
    return page;
  },

  async transformCatalogCandidates(candidates, ctx) {
    const keyEndpoints = new Map<string, string[]>();
    for (const [modelId, rawEntries] of ctx.rawEntriesByModelId) {
      for (const rawEntry of rawEntries) {
        const endpoints = newApiModelEndpointTypes(rawEntry);
        if (!endpoints?.length) continue;
        const previous = keyEndpoints.get(modelId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(endpoints)) {
          throw new AppError("upstream", "模型列表格式无效，原目录已保留");
        }
        keyEndpoints.set(modelId, endpoints);
      }
    }

    const advertised = new Map<string, NewApiCatalogModel>();
    const modelIds = new Set(candidates.map((item) => item.modelId));
    // A different origin or tenant prefix may have different group prices and capabilities.
    // Its site catalog remains browseable independently, without enriching this relay.
    if (
      ctx.siteBaseUrl &&
      candidates.length > 0 &&
      ctx.route.baseUrl === newApiSiteRoot(ctx.siteBaseUrl) + "/v1"
    ) {
      try {
        const rows = await readNewApiCatalog(
          ctx.http,
          ctx.siteBaseUrl,
          AbortSignal.any([ctx.signal, AbortSignal.timeout(4_000)]),
        );
        for (const row of rows) {
          if (modelIds.has(row.modelId) && !ctx.containsCredential(row)) {
            advertised.set(row.modelId, row);
          }
        }
      } catch {
        // Private/disabled pricing is common. The key's successful listing is authoritative.
      }
    }

    if (ctx.signal.aborted) {
      throw new AppError("network", "读取供应商模型列表已中止", true);
    }

    const enriched: DiscoveredModel[] = candidates.map((model) => {
      const row = advertised.get(model.modelId);
      const endpoints = keyEndpoints.get(model.modelId) ?? row?.endpointTypes;
      const groupQuotes = row?.prices ?? [];
      return {
        ...model,
        endpointTypes: endpoints ?? [],
        displayName:
          model.displayName === model.modelId && row ? row.displayName : model.displayName,
        facts: {
          ...row?.facts,
          ...model.facts,
        },
        // A large public price table remains available in the site catalog. Never truncate
        // it to a misleading subset of groups or discard prices supplied by the active key.
        prices:
          groupQuotes.length + model.prices.length <= maxModelPrices
            ? [...groupQuotes, ...model.prices]
            : model.prices,
      };
    });

    return ctx.scope === "family"
      ? enriched
      : projectNewApiFamilyModels(enriched, ctx.route.protocol);
  },

  transformRequestPlan(plan, { protocol, route, catalogModels }) {
    let next =
      protocol === "openai-chat"
        ? { ...plan, outputLimitField: route.chatOutputLimitField ?? "max_completion_tokens" }
        : plan;

    if (!catalogModels?.length) return next;

    const requiredEndpoint = newApiEndpointTypes[protocol];
    const eligible = catalogModels.filter(
      (entry) =>
        !entry.endpointTypes?.length ||
        !requiredEndpoint ||
        entry.endpointTypes.includes(requiredEndpoint),
    );
    if (!eligible.length) return next;

    const exact = eligible.find((entry) => entry.modelId === next.upstreamModelId);
    if (exact) {
      const mapped = exact.upstreamModelId ?? exact.modelId;
      return mapped !== next.upstreamModelId ? { ...next, upstreamModelId: mapped } : next;
    }

    const suffix = "/" + next.upstreamModelId;
    const suffixMatches = eligible.filter((entry) => entry.modelId.endsWith(suffix));
    if (suffixMatches.length === 1) {
      const matched = suffixMatches[0]!;
      return { ...next, upstreamModelId: matched.upstreamModelId ?? matched.modelId };
    }

    return next;
  },
};
