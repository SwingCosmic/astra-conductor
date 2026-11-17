import {
  apiOperation,
  parseAccountId,
  parseCommandContext,
  type CommandContext,
  type EventChannel,
  type ModelFacts,
  type ModelParameters,
  type ModelType,
  type RateCard,
  type BillingEstimate,
  type BillingWorkload,
  type ModelPriceKey,
  type ModelSelection,
} from "../common/index.js";
import { exact, fail, object } from "../common/validation/request.js";
import type {
  BoundModelCommand,
  ChangeModelPackRequest,
  ModelPack,
  SaveModelDraftRequest,
  EstimateModelCostRequest,
  ModelParameterChange,
  EditManualModelRequest,
  EditModelOverrideRequest,
  GraphModelChangedEvent,
  GraphModelSnapshot,
  ModelFieldChange,
  ModelPriceChange,
  ModelRequestPreview,
  PreviewModelRequest,
  RefreshCatalogRequest,
  SaveModelSelectionRequest,
  SelectPresetRequest,
} from "./models.js";

const root = "/api/v1/graph-agent/models/";
function label(value: unknown, path: string, max = 256): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return fail(path);
  return value;
}
function count(value: unknown, path: string) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return fail(path);
  return value;
}
function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) return fail(path);
  return value as T;
}
const operations = [
  "chat",
  "embeddings",
  "rerank",
  "image-generation",
  "video-generation",
  "audio-speech",
  "audio-transcription",
  "music-generation",
  "decision",
] as const;
export function parseModelParameters(input: unknown): ModelParameters {
  const row = object(input, "parameters");
  exact(row, ["effort", "contextWindow", "maxOutputTokens", "temperature", "topP"], "parameters");
  for (const [key, max] of [
    ["temperature", 2],
    ["topP", 1],
  ] as const) {
    const value = row[key];
    if (
      value != null &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max)
    )
      fail(key);
  }
  return {
    effort: row.effort === null ? null : label(row.effort, "effort", 64),
    contextWindow: count(row.contextWindow, "contextWindow"),
    maxOutputTokens: count(row.maxOutputTokens, "maxOutputTokens"),
    ...(row.temperature != null ? { temperature: Number(row.temperature) } : {}),
    ...(row.topP != null ? { topP: Number(row.topP) } : {}),
  };
}
function selection(input: unknown): ModelSelection {
  const row = object(input, "selection");
  exact(row, ["accountId", "providerId", "protocolRouteId", "modelId"], "selection");
  return {
    accountId: parseAccountId(row.accountId),
    providerId: label(row.providerId, "providerId"),
    protocolRouteId: label(row.protocolRouteId, "protocolRouteId"),
    modelId: label(row.modelId, "modelId", 512),
  };
}
function bound(row: Record<string, unknown>): BoundModelCommand {
  return {
    ...parseCommandContext(row),
    selection: selection(row.selection),
    expectedBindingRevision: label(row.expectedBindingRevision, "expectedBindingRevision"),
  };
}
const contextKeys = ["instanceId", "contextId"];
const boundKeys = [
  ...contextKeys,
  "selection",
  "expectedBindingRevision",
  "expectedSettingsRevision",
];
function baseline(row: Record<string, unknown>) {
  return label(row.expectedSettingsRevision, "expectedSettingsRevision");
}
export function modelFactValue(
  field: keyof ModelFacts,
  value: unknown,
): ModelFacts[keyof ModelFacts] {
  switch (field) {
    case "contextWindow":
    case "maxInputTokens":
    case "maxOutputTokens":
      return count(value, field);
    case "operations":
    case "effortLevels":
    case "inputModalities":
    case "outputModalities":
    case "unsupportedParameters":
      if (value === null) return null;
      if (!Array.isArray(value) || value.length > 64) return fail(field);
      return value.map((item) =>
        field === "operations" ? enumValue(item, operations, field) : label(item, field, 64),
      );
    case "defaultEffort":
      return value === null ? null : label(value, field, 64);
    case "structuredOutput":
      return enumValue(value, ["unsupported", "json", "schema", "unknown"], field);
    case "reasoningMode":
      return enumValue(value, ["none", "effort", "native-state", "unknown"], field);
    case "vision":
    case "toolCalling":
    case "parallelToolCalling":
    case "promptCacheRead":
    case "promptCacheWrite":
      return enumValue(value, ["supported", "unsupported", "unknown"], field);
    default:
      return fail("field");
  }
}
// Field names derive from the ModelFacts contract. `satisfies` fails the build when
// the contract and this table drift apart; the switch in modelFactValue stays the
// single authority for per-field value validation.
const modelFactFields = {
  operations: 1,
  contextWindow: 1,
  maxInputTokens: 1,
  maxOutputTokens: 1,
  inputModalities: 1,
  outputModalities: 1,
  vision: 1,
  toolCalling: 1,
  parallelToolCalling: 1,
  structuredOutput: 1,
  promptCacheRead: 1,
  promptCacheWrite: 1,
  reasoningMode: 1,
  effortLevels: 1,
  defaultEffort: 1,
  unsupportedParameters: 1,
} as const satisfies Record<keyof ModelFacts, 1>;

function change(input: unknown): ModelFieldChange {
  const row = object(input, "changes");
  const operation = enumValue(row.operation, ["set", "clear"] as const, "operation");
  exact(
    row,
    operation === "set" ? ["operation", "field", "value"] : ["operation", "field"],
    "changes",
  );
  const field = label(row.field, "field");
  if (!(field in modelFactFields)) fail("field");
  const name = field as keyof ModelFacts;
  return operation === "clear"
    ? { field: name, operation }
    : ({ field: name, operation, value: modelFactValue(name, row.value) } as ModelFieldChange);
}
function price(input: unknown): ModelPriceChange {
  const row = object(input, "priceChanges");
  const operation = enumValue(row.operation, ["set", "clear"] as const, "operation");
  exact(
    row,
    operation === "set" ? ["operation", "key", "amount"] : ["operation", "key"],
    "priceChanges",
  );
  const item = object(row.key, "priceKey");
  exact(item, ["kind", "currency", "unit", "tier", "durationSeconds"], "priceKey");
  const key: ModelPriceKey = {
    kind: enumValue(item.kind, ["input", "output", "cache-read", "cache-write"] as const, "kind"),
    currency: label(item.currency, "currency", 16),
    unit: label(item.unit, "unit", 64),
    tier: item.tier === null ? null : label(item.tier, "tier", 64),
    durationSeconds: count(item.durationSeconds, "durationSeconds"),
  };
  if (!/^[A-Z]{3}$/.test(key.currency) && operation === "set") return fail("priceKey.currency");
  if (operation === "clear") return { operation, key };
  const amount = row.amount === null ? null : label(row.amount, "amount", 48);
  if (amount !== null && !/^\d{1,28}(?:\.\d{1,24})?$/.test(amount)) return fail("amount");
  return { operation, key, amount };
}

function optionalBindingFields(row: Record<string, unknown>) {
  return {
    ...(row.operationId !== undefined && {
      operationId: enumValue(row.operationId, operations, "operationId"),
    }),
    ...(row.profileId !== undefined && { profileId: label(row.profileId, "profileId") }),
    ...(row.modelType !== undefined && {
      modelType: label(row.modelType, "modelType", 64) as ModelType,
    }),
  };
}
function parameterChange(input: unknown): ModelParameterChange {
  const row = object(input, "parameterChanges");
  const field = enumValue(
    row.field,
    [
      "contextWindow",
      "maxOutputTokens",
      "effort",
      "temperature",
      "topP",
      "size",
      "quality",
      "count",
      "voice",
      "format",
      "durationSeconds",
      "dimensions",
      "topK",
    ] as const,
    "parameters.field",
  );
  const operation = enumValue(row.operation, ["clear", "set"] as const, "operation");
  exact(
    row,
    operation === "clear" ? ["field", "operation"] : ["field", "operation", "value"],
    "parameterChanges",
  );
  if (operation === "clear") return { field, operation };
  if (row.value === null) return { field, operation, value: null };
  if (field === "size" || field === "quality" || field === "voice" || field === "format")
    return { field, operation, value: label(row.value, field, 128) };
  if (
    field === "count" ||
    field === "dimensions" ||
    field === "topK" ||
    field === "durationSeconds"
  )
    return { field, operation, value: count(row.value, field) };
  const params = parseModelParameters({
    effort: null,
    contextWindow: null,
    maxOutputTokens: null,
    [field]: row.value,
  });
  if (params[field] == null) return fail("parameters." + field);
  return { field, operation, value: params[field] };
}
function boundedArray<T>(
  value: unknown,
  parse: (v: unknown) => T,
  identity: (v: T) => string,
  field: string,
) {
  if (!Array.isArray(value) || value.length > 128) return fail(field);
  const items = value.map(parse);
  if (new Set(items.map(identity)).size !== items.length) return fail(field);
  return items;
}
function command<I extends CommandContext, O>(
  path: string,
  keys: string[],
  parse: (row: Record<string, unknown>) => I,
) {
  return {
    ...apiOperation<I, O>("POST", root + path, { body: (input) => input }),
    routePath: root + path,
    parseInput(input: unknown) {
      const row = object(input, "modelCommand");
      exact(row, keys, "modelCommand");
      return parse(row);
    },
  };
}
const draftOperation = command<SaveModelDraftRequest, GraphModelSnapshot>(
  "draft/save",
  [
    ...boundKeys,
    "scope",
    "changes",
    "priceChanges",
    "parameterChanges",
    "operationId",
    "modelType",
    "profileId",
    "presetKey",
    "rateCard",
    "ratePlanKey",
    "expectedPackRevision",
  ],
  (row) => ({
    ...bound(row),
    expectedSettingsRevision: baseline(row),
    scope: enumValue(row.scope, ["offering", "account"] as const, "scope"),
    ...optionalBindingFields(row),
    changes: boundedArray(row.changes, change, (c) => c.field, "changes"),
    priceChanges: boundedArray(
      row.priceChanges,
      price,
      (c) => JSON.stringify(c.key),
      "priceChanges",
    ),
    parameterChanges: boundedArray(
      row.parameterChanges,
      parameterChange,
      (c) => c.field,
      "parameterChanges",
    ),
    ...(row.expectedPackRevision !== undefined && {
      expectedPackRevision: label(row.expectedPackRevision, "expectedPackRevision"),
    }),
    ...(row.presetKey !== undefined && {
      presetKey: row.presetKey === null ? null : label(row.presetKey, "presetKey"),
    }),
    ...(row.ratePlanKey !== undefined && {
      ratePlanKey: label(row.ratePlanKey, "ratePlanKey", 128),
    }),
    ...(row.rateCard !== undefined && {
      rateCard:
        row.rateCard === null ? null : (object(row.rateCard, "rateCard") as unknown as RateCard),
    }),
  }),
);
export const graphModelOperations = {
  getSnapshot: apiOperation<void, GraphModelSnapshot>("GET", root + "snapshot"),
  estimateModelCost: command<EstimateModelCostRequest, BillingEstimate>(
    "pricing/estimate",
    [...contextKeys, "rateCard", "workload"],
    (row) => ({
      ...parseCommandContext(row),
      rateCard: object(row.rateCard, "rateCard") as unknown as RateCard,
      workload: object(row.workload, "workload") as unknown as BillingWorkload,
    }),
  ),
  saveModelDraft: draftOperation,
  changeModelPack: command<ChangeModelPackRequest, GraphModelSnapshot>(
    "packs/change",
    [...contextKeys, "expectedSettingsRevision", "action", "pack"],
    (row) => {
      const action = enumValue(row.action, ["import", "update", "rollback"] as const, "action");
      if ((action === "import") !== (row.pack !== undefined)) return fail("pack");
      return {
        ...parseCommandContext(row),
        expectedSettingsRevision: baseline(row),
        action,
        ...(action === "import" && { pack: object(row.pack, "pack") as unknown as ModelPack }),
      };
    },
  ),
  refreshCatalog: command<RefreshCatalogRequest, GraphModelSnapshot>(
    "catalogs/refresh",
    [...contextKeys, "accountId", "protocolRouteId", "expectedBindingRevision"],
    (row) => ({
      ...parseCommandContext(row),
      accountId: parseAccountId(row.accountId),
      protocolRouteId: label(row.protocolRouteId, "protocolRouteId"),
      expectedBindingRevision: label(row.expectedBindingRevision, "expectedBindingRevision"),
    }),
  ),
  editManualModel: command<EditManualModelRequest, GraphModelSnapshot>(
    "entries/edit",
    [...boundKeys, "change"],
    (row) => {
      const item = object(row.change, "change");
      const operation = enumValue(item.operation, ["upsert", "remove"] as const, "operation");
      exact(
        item,
        operation === "upsert"
          ? ["displayName", "operation", "modelType", "operationId", "profileId"]
          : ["operation"],
        "change",
      );
      return {
        ...bound(row),
        expectedSettingsRevision: baseline(row),
        change:
          operation === "upsert"
            ? {
                operation,
                displayName: label(item.displayName, "displayName"),
                ...optionalBindingFields(item),
              }
            : { operation },
      };
    },
  ),
  selectPreset: command<SelectPresetRequest, GraphModelSnapshot>(
    "presets/select",
    [...boundKeys, "presetKey"],
    (row) => ({
      ...bound(row),
      expectedSettingsRevision: baseline(row),
      presetKey: row.presetKey === null ? null : label(row.presetKey, "presetKey"),
    }),
  ),
  editModelOverrides: command<EditModelOverrideRequest, GraphModelSnapshot>(
    "overrides/edit",
    [...boundKeys, "changes", "priceChanges"],
    (row) => {
      if (
        !Array.isArray(row.changes) ||
        !Array.isArray(row.priceChanges) ||
        row.changes.length + row.priceChanges.length === 0 ||
        row.changes.length + row.priceChanges.length > 128
      )
        return fail("changes");
      const changes = row.changes.map(change),
        priceChanges = row.priceChanges.map(price);
      if (
        new Set(changes.map((c) => c.field)).size !== changes.length ||
        new Set(priceChanges.map((c) => JSON.stringify(c.key))).size !== priceChanges.length
      )
        return fail("duplicate changes");
      return { ...bound(row), expectedSettingsRevision: baseline(row), changes, priceChanges };
    },
  ),
  saveModelSelection: command<SaveModelSelectionRequest, GraphModelSnapshot>(
    "selection/save",
    [...contextKeys, "expectedSettingsRevision", "choice"],
    (row) => {
      const common = { ...parseCommandContext(row), expectedSettingsRevision: baseline(row) };
      if (row.choice === null) return { ...common, choice: null };
      const item = object(row.choice, "choice");
      exact(item, ["selection", "expectedBindingRevision", "parameters"], "choice");
      return {
        ...common,
        choice: {
          selection: selection(item.selection),
          expectedBindingRevision: label(item.expectedBindingRevision, "expectedBindingRevision"),
          ...(item.parameters !== undefined && {
            parameters: parseModelParameters(item.parameters),
          }),
        },
      };
    },
  ),
  previewRequest: command<PreviewModelRequest, ModelRequestPreview>(
    "request-preview",
    [...boundKeys, "operation", "parameters", "draft"],
    (row) => ({
      ...bound(row),
      expectedSettingsRevision: baseline(row),
      operation: enumValue(row.operation, operations, "operation"),
      parameters: parseModelParameters(row.parameters),
      ...(row.draft !== undefined && { draft: draftOperation.parseInput(row.draft) }),
    }),
  ),
};
function eventStamp(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { stamp?: unknown; stamps?: unknown };
  const stamps = Array.isArray(row.stamps) ? row.stamps : [row.stamp];
  return stamps.find(
    (item): item is GraphModelChangedEvent["stamp"] =>
      !!item &&
      typeof item === "object" &&
      item.scope === "graph-agent.models" &&
      typeof item.instanceId === "string" &&
      Number.isSafeInteger(item.revision),
  );
}
export const graphModelEventChannel: EventChannel<GraphModelChangedEvent> = {
  type: "changed",
  accepts: (value) => !!eventStamp(value),
  parse(value, resync) {
    const row = value as Partial<GraphModelChangedEvent>;
    return {
      stamp: eventStamp(value)!,
      contextId: row.contextId ?? "",
      reasons: row.reasons ?? [],
      resync,
    };
  },
};
