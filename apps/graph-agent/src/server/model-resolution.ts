import { checkParameterValues } from "./model-parameters.js";
import { entryQuotes } from "./model-quotes.js";
import { createHash } from "node:crypto";
import { ContractValidationError } from "@astra-conductor/contract/common";
import type {
  ActionAvailability,
  ModelEntryView,
  ModelEndpointDescriptor,
  ModelOverrides,
  ModelParameters,
  ModelSelection,
  RateCard,
  ModelPriceField,
  ModelPriceKey,
} from "@astra-conductor/contract/graph-agent";
import {
  resolveModelFacts,
  type DiscoveredModel,
  type ModelFactLayer,
} from "@astra-conductor/core/internal";
import type {
  ModelState,
  ConfigRow,
  GraphModelRepository,
  RemoteCatalog,
} from "./model-repository.js";
const none: ModelParameters = { maxOutputTokens: null, contextWindow: null, effort: null };
export const enabled = { state: "enabled" } as const;
export const disabled = (reason: string) => ({ state: "disabled", reason }) as const;
export const scopeKey = (op: string, profile: string) => JSON.stringify([op, profile]);
export function isPublicOffering(provider: string) {
  return !provider.startsWith("custom-") && provider !== "compatible-api-key";
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
): ModelEntryView {
  const opKey = scopeKey(ep.operationId, ep.profileId),
    pack = repo.activePack(state.active);
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
  const cap = preset?.capabilities.find((c) => c.operationId === ep.operationId);
  const layers: ModelFactLayer[] = [];
  if (preset?.inherit && cap) {
    const parent = pack.byKey.get(preset.inherit.presetKey);
    const inherited = parent?.capabilities.find((c) => c.operationId === ep.operationId);
    if (parent && inherited)
      layers.push({
        facts: Object.fromEntries(
          preset.inherit.fields
            .filter((k) => Object.hasOwn(inherited.facts, k))
            .map((k) => [k, inherited.facts[k]]),
        ),
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
  if (preset && cap)
    layers.push({
      facts: cap.facts,
      prices:
        selection.providerId === "codex" &&
        offeringId === "openai-api-key" &&
        preset.vendorId === "openai"
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
  const sources: ModelEntryView["parameterSources"] = {};
  for (const [items, scope] of [
    [cap?.parameters ?? {}, "preset"],
    [o.parameters, "offering"],
    [a.parameters, "account"],
  ] as const)
    for (const field of Object.keys(items) as (keyof ModelParameters)[]) sources[field] = scope;
  const knownOperations = effective.fields.operations.value;
  const official = selection.providerId === "codex" && offeringId === "openai-api-key";
  const exactOfficial = matches.find((p) => p.vendorId === "openai");
  function chatAction(): ActionAvailability {
    if (presence === "missing") return disabled("此型号尚未在当前账号的绑定上发现或登记");
    if (!ep.chatExecutable) return disabled("媒体端点仅支持配置与校验");
    if (
      (knownOperations && !knownOperations.includes("chat")) ||
      (remote?.facts.operations && !remote.facts.operations.includes("chat"))
    )
      return disabled("此模型不支持聊天");
    if (official) {
      if (exactOfficial && !exactOfficial.capabilities.some((c) => c.operationId === "chat"))
        return disabled("该官方型号属于其他操作");
      if (!manual && !exactOfficial && !remote?.facts.operations?.includes("chat"))
        return disabled("目录仅返回型号 ID，请在此账号和端点手工确认聊天用途");
    } else if (
      preset &&
      !cap &&
      !remote?.facts.operations?.includes("chat") &&
      !a.facts.operations?.includes("chat") &&
      !o.facts.operations?.includes("chat")
    )
      return disabled("该型号的预置未声明聊天能力");
    return access;
  }
  const use = chatAction();
  const presetProfile = cap?.ioProfiles.find((p) => p.id === ep.profileId);
  const ioProfiles = [
    {
      id: ep.profileId,
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
  const parameterTemplate = pack.templates.get(cap?.parameterTemplateRef ?? ep.operationId)!;
  const presetCards: Record<string, RateCard> = {};
  for (const ref of cap?.rateCardRefs ?? []) {
    const card = pack.rates.get(JSON.stringify([ref.rateCardId, ref.revision]));
    const scope = card?.scope;
    if (
      !card ||
      !scope ||
      scope.providerId !== selection.providerId ||
      scope.offeringId !== offeringId ||
      scope.operationId !== ep.operationId ||
      (scope.protocolRouteId && scope.protocolRouteId !== ep.id) ||
      (scope.upstreamModelId && scope.upstreamModelId !== selection.modelId) ||
      (scope.planId && scope.planId !== ref.planKey)
    )
      continue;
    presetCards[ref.planKey] = card;
  }
  const rateCards = { ...presetCards, ...o.rateCards, ...a.rateCards };
  if (Object.hasOwn(rateCards, ratePlanKey)) {
    rateCards[ratePlanKey] = applyBasicPrices(rateCards[ratePlanKey], effective.prices);
  }
  const rateCard = Object.hasOwn(rateCards, ratePlanKey) ? rateCards[ratePlanKey] : null;
  const cardId =
    "base-" +
    createHash("sha256")
      .update(
        JSON.stringify([
          selection.providerId,
          offeringId,
          selection.protocolRouteId,
          selection.modelId,
        ]),
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
  return {
    selection,
    displayName: local?.document.displayName ?? remote?.displayName ?? selection.modelId,
    presence,
    presetKey: preset?.key ?? null,
    ...effective,
    modelType: ep.modelType,
    operationId: ep.operationId,
    profileId: ep.profileId,
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
