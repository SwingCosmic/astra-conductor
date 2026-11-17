import type {
  FieldSource,
  ModelFacts,
  ModelFieldValues,
  ModelPriceField,
  ModelPriceKey,
} from "@astra-conductor/contract/common";

export const unknownModelFacts: ModelFacts = {
  operations: null,
  contextWindow: null,
  maxInputTokens: null,
  maxOutputTokens: null,
  inputModalities: null,
  outputModalities: null,
  vision: "unknown",
  toolCalling: "unknown",
  parallelToolCalling: "unknown",
  structuredOutput: "unknown",
  promptCacheRead: "unknown",
  promptCacheWrite: "unknown",
  reasoningMode: "unknown",
  effortLevels: null,
  defaultEffort: null,
  unsupportedParameters: null,
};
export function priceIdentity(key: ModelPriceKey): string {
  return JSON.stringify([key.kind, key.currency, key.unit, key.tier, key.durationSeconds]);
}
export interface ModelFactLayer {
  facts: Partial<ModelFacts>;
  prices: Array<ModelPriceKey & { amount: string | null }>;
  source: FieldSource;
}
/** Later layers override only the supplied keys, including explicit unknown values and zero prices. */
export function resolveModelFacts(layers: ModelFactLayer[]): {
  fields: ModelFieldValues;
  prices: ModelPriceField[];
} {
  const fields = Object.fromEntries(
    Object.entries(unknownModelFacts).map(([k, value]) => [k, { value, source: null }]),
  ) as ModelFieldValues;
  const prices = new Map<string, ModelPriceField>();
  for (const layer of layers) {
    for (const field of Object.keys(unknownModelFacts) as (keyof ModelFacts)[]) {
      if (Object.hasOwn(layer.facts, field))
        Object.assign(fields[field], { value: layer.facts[field], source: layer.source });
    }
    for (const { amount, ...key } of layer.prices)
      prices.set(priceIdentity(key), { key, amount: { value: amount, source: layer.source } });
  }
  return { fields, prices: [...prices.values()] };
}
