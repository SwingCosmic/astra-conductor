import { checkParameterValues } from "./model-parameters.js";
import { entryQuotes } from "./model-quotes.js";
import { createHash } from "node:crypto";
import { ContractValidationError } from "@astra-conductor/contract/common";
import type {
  ActionAvailability,
  ModelEntryView,
  ModelEndpointDescriptor,
  ModelFacts,
  ModelOverrides,
  ModelParameters,
  ModelSelection,
  RateCard,
  ModelPriceField,
  ModelPriceKey,
} from "@astra-conductor/contract/graph-agent";
import {
  applyPolicyChain,
  getBuiltInModelPolicy,
  isCustomProviderId,
  providerCatalog,
  resolveModelFacts,
  type ChatAvailabilityContext,
  type DiscoveredModel,
  type ModelFactLayer,
  type ProviderOfferingModelPolicy,
  type ProviderRegistry,
} from "@astra-conductor/core/internal";
import type {
  ModelState,
  ConfigRow,
  GraphModelRepository,
  RemoteCatalog,
} from "./model-repository.js";

export interface ProjectEntryPolicyContext {
  readonly policy?: ProviderOfferingModelPolicy | null;
  readonly registry?: ProviderRegistry;
  readonly templateKind?: "generic" | "new-api";
}

export function extractEntryFacts(entry: ModelEntryView): Partial<ModelFacts> {
  const facts: Partial<ModelFacts> = {};
  for (const [key, field] of Object.entries(entry.fields) as [
    keyof ModelFacts,
    ModelEntryView["fields"][keyof ModelFacts],
  ][]) {
    if (field.value !== null && field.value !== undefined) {
      Object.assign(facts, { [key]: field.value });
    }
  }
  return facts;
}

const none: ModelParameters = { maxOutputTokens: null, contextWindow: null, effort: null };
export const enabled = { state: "enabled" } as const;
export const disabled = (reason: string) => ({ state: "disabled", reason }) as const;
export const scopeKey = (op: string, profile: string) => JSON.stringify([op, profile]);
export function isPublicOffering(provider: string) {
  return !isCustomProviderId(provider) && provider !== "compatible-api-key";
}
export function priceUnit(unit: string) {
  return /^(million[- ]tokens|1m\s*tokens|1,?000,?000\s*tokens)$/i.test(unit.trim())
    ? "1M tokens"
    : unit;
}
export function priceKey(key: ModelPriceKey) {
  return JSON.stringify([
    key.kind,
    key.currency,
    priceUnit(key.unit),
    key.tier,
    key.durationSeconds,
  ]);
}
function quoteDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Pick the unique base line for each token meter. Additional lines and conditional rules retain their own prices. */
export function basicCardRows(card: RateCard) {
  const meters: Record<string, ModelPriceKey["kind"]> = {
    uncachedInputTokens: "input",
    outputTokens: "output",
    cachedInputTokens: "cache-read",
    cacheWriteTokens: "cache-write",
  };
  const eligible = card.chargeLines.flatMap((line, index) => {
    const kind = Object.hasOwn(meters, line.meter) ? meters[line.meter] : undefined;
    if (!kind || line.per.quantity !== 1_000_000 || line.per.unit !== "tokens") return [];
    return [
      {
        index,
        line,
        key: {
          kind,
          currency: card.currency,
          unit: "1M tokens",
          tier: null,
          durationSeconds: null,
        } satisfies ModelPriceKey,
      },
    ];
  });
  return eligible.filter((row) => {
    const same = eligible.filter((other) => other.key.kind === row.key.kind);
    return same.length === 1 || row.line.lineId === row.key.kind;
  });
}
function applyBasicPrices(card: RateCard, prices: ModelPriceField[]): RateCard {
  const chargeLines = card.chargeLines.slice();
  for (const { index, key, line } of basicCardRows(card)) {
    const price = prices.find((p) => priceKey(p.key) === priceKey(key));
    if (price && line.amount !== price.amount.value)
      chargeLines[index] = { ...line, amount: price.amount.value };
  }
  if (chargeLines.every((l, i) => l === card.chargeLines[i])) return card;
  return { ...card, chargeLines, revision: quoteDigest([card.revision, chargeLines]) };
}
function baseCard(prices: ModelPriceField[], id: string): RateCard | null {
  const lines = prices.filter(
    (p) =>
      priceUnit(p.key.unit) === "1M tokens" &&
      p.key.tier === null &&
      (p.key.durationSeconds === null ||
        p.key.kind === "cache-read" ||
        p.key.kind === "cache-write"),
  );
  if (
    !lines.length ||
    !/^[A-Z]{3}$/.test(lines[0].key.currency) ||
    new Set(lines.map((l) => l.key.currency)).size !== 1
  )
    return null;
  for (const kind of ["input", "output"] as const) {
    if (!lines.some((p) => p.key.kind === kind))
      lines.push({
        key: {
          kind,
          currency: lines[0].key.currency,
          unit: "1M tokens",
          tier: null,
          durationSeconds: null,
        },
        amount: { value: null, source: null },
      });
  }
  const meters = {
    input: "uncachedInputTokens",
    output: "outputTokens",
    "cache-read": "cachedInputTokens",
    "cache-write": "cacheWriteTokens",
  };
  return {
    rateCardId: id,
    revision: quoteDigest(lines),
    currency: lines[0].key.currency,
    chargeLines: lines.map((p) => ({
      lineId:
        p.key.durationSeconds === null
          ? p.key.kind
          : p.key.kind + "-" + p.key.durationSeconds + "s",
      meter:
        p.key.durationSeconds === null
          ? meters[p.key.kind]
          : meters[p.key.kind] + "." + p.key.durationSeconds + "s",
      amount: p.amount.value,
      per: { quantity: 1_000_000, unit: "tokens" },
    })),
    entitlements: [],
    overrides: [],
  };
}
export function projectEntry(
  repo: GraphModelRepository,
  selection: ModelSelection,
  offeringId: string,
  ep: ModelEndpointDescriptor,
  visibilityRef: string,
  binding: string,
  access: ActionAvailability,
  local?: ConfigRow,
  common?: ConfigRow,
  remote?: DiscoveredModel,
  catalog?: RemoteCatalog,
  state: ModelState = repo.state(),
  policyContext?: ProjectEntryPolicyContext,
): ModelEntryView {
  const opKey = scopeKey(ep.operation, ep.ioProfile),
    pack = repo.activePack(state.active);
  const policy =
    policyContext?.policy !== undefined
      ? policyContext.policy
      : policyContext?.registry
        ? policyContext.registry.getModelPolicy({
            providerId: selection.providerId,
            offeringId,
            templateKind: policyContext.templateKind,
          })
        : getBuiltInModelPolicy({
            providerId: selection.providerId,
            offeringId,
            templateKind: policyContext?.templateKind,
          });
  const providerDescriptor =
    policyContext?.registry?.getDescriptor(selection.providerId) ??
    providerCatalog.find((item) => item.provider === selection.providerId);
  const offeringDescriptor = providerDescriptor?.offerings.find((item) => item.id === offeringId);
  const matchesVendor = (vendor: string) => {
    const normalized = vendor.toLowerCase();
    if (normalized === selection.providerId.toLowerCase()) return true;
    const displayName = providerDescriptor?.displayName.toLowerCase();
    return Boolean(
      displayName && (normalized === displayName || displayName.split(/\s+/).includes(normalized)),
    );
  };
  const ratePlanKey =
    local?.document.operations[opKey]?.ratePlanKey ??
    common?.document.operations[opKey]?.ratePlanKey ??
    "default";
  const data = (row?: ConfigRow): ModelOverrides => {
    const v = row?.document.operations[opKey];
    const rateCards = Object.fromEntries(
      Object.entries(v?.cardRefs ?? {}).map(([k, ref]) => [k, repo.card(ref)!]),
    );
    return {
      facts: v?.facts ?? {},
      prices: ratePlanKey === "default" ? (v?.prices ?? []) : (v?.planPrices?.[ratePlanKey] ?? []),
      parameters: v?.parameters ?? {},
      presetKey: v?.presetKey,
      ratePlanKey: v?.ratePlanKey,
      rateCards,
      rateCard: Object.hasOwn(rateCards, v?.ratePlanKey ?? "default")
        ? rateCards[v?.ratePlanKey ?? "default"]
        : undefined,
    };
  };
  const a = data(local),
    o = data(common);
  const manual =
    !!local?.document.displayName &&
    local.document.manualBinding?.visibilityRef === visibilityRef &&
    local.document.manualBinding?.revision === binding;
  const presence = remote
    ? manual
      ? "remote-and-manual"
      : "remote"
    : manual
      ? "manual"
      : "missing";
  const chosen = a.presetKey ?? o.presetKey;
  const matches = pack.byExactId.get(selection.modelId) ?? [];
  const preset = chosen ? pack.byKey.get(chosen) : matches.length === 1 ? matches[0] : undefined;
  const cap = preset?.capabilities.find((c) => c.operation === ep.operation);
  const layers: ModelFactLayer[] = [];
  const textLlmDefaults: Partial<ModelFacts> | undefined =
    ep.modelType === "text-llm"
      ? {
          inputModalities: ["text"],
          outputModalities: ["text"],
          toolCalling: "supported",
        }
      : undefined;
  if (textLlmDefaults) {
    layers.push({
      facts: textLlmDefaults,
      prices: [],
      source: {
        kind: "preset",
        revision: "text-llm-default",
        checkedAt: null,
        referenceUrl: null,
      },
    });
  }
  let inheritedFacts: Partial<ModelFacts> | undefined;
  if (preset?.inherit && cap) {
    const parent = pack.byKey.get(preset.inherit.presetKey);
    const inherited = parent?.capabilities.find((c) => c.operation === ep.operation);
    if (parent && inherited) {
      inheritedFacts = Object.fromEntries(
        preset.inherit.fields
          .filter((k) => Object.hasOwn(inherited.facts, k))
          .map((k) => [k, inherited.facts[k]]),
      ) as Partial<ModelFacts>;
      layers.push({
        facts: inheritedFacts,
        prices: [],
        source: {
          kind: "preset",
          scope: "series",
          revision: parent.revision,
          checkedAt: parent.checkedAt,
          referenceUrl: preset.inherit.referenceUrl,
        },
      });
    }
  }
  if (policy?.transformModelFacts) {
    const baselineFacts: Partial<ModelFacts> = {
      ...(textLlmDefaults ?? {}),
      ...(inheritedFacts ?? {}),
      ...(cap?.facts ?? {}),
      ...(remote?.facts ?? {}),
      ...(o.facts ?? {}),
      ...(a.facts ?? {}),
    };
    const transformed = applyPolicyChain(
      baselineFacts,
      {
        providerId: selection.providerId,
        offeringId,
        protocol: ep.protocol,
        operation: ep.operation,
        modelId: selection.modelId,
      },
      [policy.transformModelFacts],
    );
    const policyFacts: Partial<ModelFacts> = {};
    for (const [k, v] of Object.entries(transformed) as [
      keyof ModelFacts,
      ModelFacts[keyof ModelFacts],
    ][]) {
      if (v !== undefined && baselineFacts[k] !== v) {
        Object.assign(policyFacts, { [k]: v });
      }
    }
    if (Object.keys(policyFacts).length) {
      layers.push({
        facts: policyFacts,
        prices: [],
        source: {
          kind: "preset",
          revision: "provider-profile-v1",
          referenceUrl: null,
          checkedAt: null,
        },
      });
    }
  }
  if (preset && cap)
    layers.push({
      facts: cap.facts,
      prices:
        isPublicOffering(selection.providerId) &&
        offeringDescriptor?.supportsSubscriptionUsage === false &&
        matchesVendor(preset.vendor)
          ? preset.prices
          : [],
      source: {
        kind: "preset",
        revision: preset.revision,
        checkedAt: preset.checkedAt,
        referenceUrl: preset.referenceUrl,
      },
    });
  if (remote && catalog)
    layers.push({
      facts: remote.facts,
      prices: remote.prices ?? [],
      source: {
        kind: "remote",
        revision: catalog.revision,
        checkedAt: catalog.fetchedAt,
        referenceUrl: null,
      },
    });
  for (const [row, scope] of [
    [common, "offering"],
    [local, "account"],
  ] as const) {
    const v = row?.document.operations[opKey];
    if (v) {
      const source = (key: string) => {
        const stamp = v.stamps?.[key] ?? v;
        return {
          kind: "user" as const,
          scope,
          revision: stamp.revision,
          checkedAt: stamp.updatedAt,
          referenceUrl: null,
        };
      };
      for (const [field, value] of Object.entries(v.facts))
        layers.push({ facts: { [field]: value }, prices: [], source: source("fact:" + field) });
      const projection = scope === "account" ? a : o;
      const cards = projection.rateCards ?? {};
      if (Object.hasOwn(cards, ratePlanKey)) {
        const prices = basicCardRows(cards[ratePlanKey]).map(({ key, line }) => ({
          ...key,
          amount: line.amount,
        }));
        layers.push({ facts: {}, prices, source: source("card:" + ratePlanKey) });
      }
      for (const price of projection.prices)
        layers.push({
          facts: {},
          prices: [price],
          source: source("price:" + ratePlanKey + ":" + priceKey(price)),
        });
    }
  }
  const effective = resolveModelFacts(
    layers.map((layer) => ({
      ...layer,
      prices: layer.prices.map((p) => ({ ...p, unit: priceUnit(p.unit) })),
    })),
  );
  const params = { ...none, ...cap?.parameters, ...o.parameters, ...a.parameters };
  if (ep.operation === "chat") {
    params.thinkingEnabled =
      params.thinkingEnabled !== false && effective.fields.reasoningMode.value !== "none";
    params.returnFullReasoning = params.thinkingEnabled && params.returnFullReasoning === true;
    if (!params.thinkingEnabled) params.effort = null;
  }
  const sources: ModelEntryView["parameterSources"] = {};
  for (const [items, scope] of [
    [cap?.parameters ?? {}, "preset"],
    [o.parameters, "offering"],
    [a.parameters, "account"],
  ] as const)
    for (const field of Object.keys(items) as (keyof ModelParameters)[]) sources[field] = scope;
  const knownOperations = effective.fields.operations.value;
  const exactVendorMatch = matches.find((p) => matchesVendor(p.vendor));
  const exactVendorPreset = exactVendorMatch
    ? { operations: exactVendorMatch.capabilities.map((c) => c.operation) }
    : null;
  function chatAction(): ActionAvailability {
    if (presence === "missing") return disabled("此型号尚未在当前账号的绑定上发现或登记");
    if (!ep.chatExecutable) return disabled("媒体端点仅支持配置与校验");
    if (remote?.routeSupport === "unconfirmed" && !manual)
      return disabled(
        "当前 Key 可见此型号，站点尚未声明此聊天端点。可在该账号和端点手工登记确认。",
      );
    if (
      (knownOperations && !knownOperations.includes("chat")) ||
      (remote?.facts.operations && !remote.facts.operations.includes("chat"))
    )
      return disabled("此模型不支持聊天");
    const availability = applyPolicyChain<ActionAvailability, ChatAvailabilityContext>(
      access,
      {
        providerId: selection.providerId,
        offeringId,
        protocol: ep.protocol,
        modelId: selection.modelId,
        manual,
        remoteOperations: remote?.facts.operations ?? null,
        exactVendorPreset,
      },
      [policy?.transformChatAvailability],
    );
    if (availability.state !== "enabled") return availability;
    if (
      preset &&
      !cap &&
      !remote?.facts.operations?.includes("chat") &&
      !a.facts.operations?.includes("chat") &&
      !o.facts.operations?.includes("chat")
    )
      return disabled("该型号的预置未声明聊天能力");
    return availability;
  }
  const use = chatAction();
  const presetProfile = cap?.ioProfiles.find((p) => p.kind === ep.ioProfile);
  const ioProfiles = [
    {
      kind: ep.ioProfile,
      requiredInputs: [...ep.requiredInputs],
      optionalInputs: [...ep.optionalInputs].filter(
        (v) =>
          presetProfile?.optionalInputs.includes(v) ||
          effective.fields.inputModalities.value?.includes(v) ||
          (v === "image" && effective.fields.vision.value === "supported") ||
          !ep.chatExecutable,
      ),
      outputs: [...ep.outputs],
    },
  ];
  const revision = state.revision;
  const baseTemplate = pack.templates.get(cap?.parameterTemplateRef ?? ep.operation)!;
  const defaultEffortChoices = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const effortChoices =
    effective.fields.effortLevels.value && effective.fields.effortLevels.value.length > 0
      ? [...effective.fields.effortLevels.value]
      : defaultEffortChoices;
  const parameterTemplate = baseTemplate.fields.effort
    ? {
        ...baseTemplate,
        fields: {
          ...baseTemplate.fields,
          effort: {
            ...baseTemplate.fields.effort,
            choices: baseTemplate.fields.effort.choices ?? effortChoices,
          },
        },
      }
    : baseTemplate;
  const presetCards: Record<string, RateCard> = {};
  for (const ref of cap?.rateCardRefs ?? []) {
    const card = pack.rates.get(JSON.stringify([ref.rateCardId, ref.revision]));
    const scope = card?.scope;
    if (
      !card ||
      !scope ||
      scope.providerId !== selection.providerId ||
      scope.offeringId !== offeringId ||
      scope.operation !== ep.operation ||
      (scope.protocol && scope.protocol !== ep.protocol) ||
      (scope.upstreamModelId && scope.upstreamModelId !== selection.modelId) ||
      (scope.planKey && scope.planKey !== ref.planKey)
    )
      continue;
    presetCards[ref.planKey] = card;
  }
  const rateCards = { ...presetCards, ...o.rateCards, ...a.rateCards };
  if (Object.hasOwn(rateCards, ratePlanKey)) {
    rateCards[ratePlanKey] = applyBasicPrices(rateCards[ratePlanKey], effective.prices);
  }
  const cardId =
    "base-" +
    createHash("sha256")
      .update(
        JSON.stringify([selection.providerId, offeringId, selection.protocol, selection.modelId]),
      )
      .digest("hex");
  const currencies = new Set(effective.prices.map((p) => p.key.currency));
  for (const currency of currencies) {
    const basic = baseCard(
      effective.prices.filter((p) => p.key.currency === currency),
      cardId + "-" + currency,
    );
    const key = currencies.size === 1 ? "default" : currency;
    if (basic && !Object.hasOwn(rateCards, key)) rateCards[key] = basic;
  }
  const rateCard = Object.hasOwn(rateCards, ratePlanKey) ? rateCards[ratePlanKey] : null;
  return {
    selection,
    displayName: local?.document.displayName ?? remote?.displayName ?? selection.modelId,
    presence,
    presetKey: preset?.key ?? null,
    ...effective,
    modelType: ep.modelType,
    operation: ep.operation,
    ioProfile: ep.ioProfile,
    ioProfiles,
    parameters: params,
    accountOverrides: a,
    offeringOverrides: o,
    parameterSources: sources,
    parameterTemplate,
    referencePrices: cap ? (preset?.prices ?? []) : [],
    ratePlanKey,
    rateCards,
    quotes: entryQuotes({ prices: effective.prices, rateCard, rateCards }),
    routeFacts: remote?.facts ?? {},
    rateCard,
    settingsRevision: revision,
    actions: { select: use, edit: access, preview: use },
  };
}
export function validateParameters(entry: ModelEntryView, params: ModelParameters) {
  const f = entry.fields;
  const route = entry.routeFacts;
  if (
    (params.contextWindow && route.contextWindow && params.contextWindow > route.contextWindow) ||
    (params.maxOutputTokens &&
      route.maxOutputTokens &&
      params.maxOutputTokens > route.maxOutputTokens)
  )
    throw new ContractValidationError(
      "参数超过上游路由声明的限制",
      params.contextWindow && route.contextWindow && params.contextWindow > route.contextWindow
        ? "contextWindow"
        : "maxOutputTokens",
    );
  if (
    (params.contextWindow &&
      f.contextWindow.value &&
      params.contextWindow > f.contextWindow.value) ||
    (params.maxOutputTokens &&
      f.maxOutputTokens.value &&
      params.maxOutputTokens > f.maxOutputTokens.value) ||
    (params.maxOutputTokens &&
      params.contextWindow &&
      params.maxOutputTokens > params.contextWindow)
  )
    throw new ContractValidationError(
      "参数超出此模型的上下文或最大输出上限",
      params.contextWindow && f.contextWindow.value && params.contextWindow > f.contextWindow.value
        ? "contextWindow"
        : "maxOutputTokens",
    );
  if (
    params.effort &&
    (f.reasoningMode.value === "none" ||
      (f.effortLevels.value && !f.effortLevels.value.includes(params.effort)))
  )
    throw new ContractValidationError("模型不支持所选思考强度", "effort");
  if (
    f.defaultEffort.value &&
    (f.reasoningMode.value === "none" ||
      (f.effortLevels.value && !f.effortLevels.value.includes(f.defaultEffort.value)))
  )
    throw new ContractValidationError(
      "默认思考强度与当前推理模式或强度列表不匹配",
      "defaultEffort",
    );
  if (
    params.returnFullReasoning &&
    (params.thinkingEnabled === false || f.reasoningOutputMode.value !== "full")
  )
    throw new ContractValidationError("当前绑定尚未声明可返回完整思考内容", "returnFullReasoning");
  checkParameterValues(entry.parameterTemplate, params);
  for (const [field, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      (f.unsupportedParameters.value?.includes(field) ||
        route.unsupportedParameters?.includes(field))
    )
      throw new ContractValidationError("此操作不支持参数 " + field, field);
  }
}
