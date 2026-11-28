<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  AppIcon,
  CollapsiblePanel,
  ConfigField,
  FormDialog,
  RichSelect,
  SegmentedControl,
  TagToggleGroup,
  type RichSelectOption,
} from "@astra-conductor/shared-ui";
import type {
  GraphModelSnapshot,
  ModelCatalogView,
  ModelEntryView,
  ModelFacts,
  ModelParameters,
  ModelFieldChange,
  ModelParameterChange,
  ModelPriceChange,
  ModelPriceKey,
  ModelRequestPreview,
  RateCard,
  SaveModelDraftRequest,
  PublicError,
} from "@astra-conductor/contract/graph-agent";
import { graphServiceKey } from "../services/graph-agent-service";
import {
  factLabels,
  factSourceLabels,
  formatEffortLabel,
  parameterLabels,
  parameterSourceLabels,
  paramKeys,
  priceKindLabels,
  priceSourceLabels,
  valueLabels,
  modalityLabels,
  operationLabels,
  typeLabels,
} from "./catalog-labels";
import RateCardEditor from "./RateCardEditor.vue";

const props = defineProps<{
  snapshot: GraphModelSnapshot;
  entry: ModelEntryView;
  catalog: ModelCatalogView;
  scope: "account" | "offering";
  breadcrumb?: string;
  readonly: boolean;
  removable?: boolean;
  removeBusy?: boolean;
}>();
const emit = defineEmits<{ reload: []; chat: []; pickAccount: []; removeManual: [] }>();
const service = inject(graphServiceKey)!;

const tab = ref<"facts" | "parameters" | "prices">("facts");
const tabs = [
  { id: "facts", label: "能力与限制" },
  { id: "parameters", label: "调用参数" },
  { id: "prices", label: "价格" },
] as const;

const edits = ref<Partial<Record<keyof ModelFacts, ModelFieldChange>>>({}),
  params = ref<Partial<Record<keyof ModelParameters, ModelParameterChange>>>({}),
  prices = ref<Record<string, ModelPriceChange>>({});
const card = ref<RateCard | null | undefined>(),
  preset = ref<string | null | undefined>();
const planKey = ref<string>();
const baseline = ref(props.snapshot.settingsRevision),
  packRevision = ref(props.snapshot.pack.active);
const currency = ref("USD"),
  busy = ref(false),
  message = ref(""),
  error = ref<PublicError | null>(null),
  preview = ref<ModelRequestPreview | null>(null);
const form = ref<HTMLElement>(),
  leaveOpen = ref(false),
  publicTest = ref(false);
let decide: ((ok: boolean) => void) | undefined;
let alive = true;

const factsDirtyCount = computed(
  () => Object.keys(edits.value).length + (preset.value !== undefined ? 1 : 0),
);
const paramsDirtyCount = computed(() => Object.keys(params.value).length);
const pricesDirtyCount = computed(
  () =>
    Object.keys(prices.value).length +
    (card.value !== undefined ? 1 : 0) +
    (planKey.value !== undefined ? 1 : 0),
);
const dirtyCount = computed(
  () => factsDirtyCount.value + paramsDirtyCount.value + pricesDirtyCount.value,
);
const dirty = computed(() => dirtyCount.value > 0);

function tabDirtyCount(id: "facts" | "parameters" | "prices") {
  if (id === "facts") return factsDirtyCount.value;
  if (id === "parameters") return paramsDirtyCount.value;
  return pricesDirtyCount.value;
}

const presetOptions = computed<RichSelectOption[]>(() => [
  { value: "", label: "自动匹配" },
  ...props.snapshot.presets
    .filter((p) => p.operations.includes(props.entry.operation))
    .map((item) => ({
      value: item.key,
      label: item.displayName,
      subtitle: `${item.family} / ${item.series}`,
    })),
]);

function factChoiceOptions(
  field: "structuredOutput" | "reasoningMode" | "reasoningOutputMode",
): RichSelectOption[] {
  return choices(field).map((v) => ({ value: v, label: valueLabels[v] ?? v }));
}

const defaultEffortOptions = computed<RichSelectOption[]>(() => [
  { value: "", label: "未知" },
  ...choices("defaultEffort").map((v) => ({ value: v, label: formatEffortLabel(v) })),
]);

const effortChoiceOptions = computed<RichSelectOption[]>(() => [
  { value: "", label: "协议默认" },
  ...effortChoices.value.map((choice) => ({ value: choice, label: formatEffortLabel(choice) })),
]);

function paramChoiceOptions(k: keyof ModelParameters): RichSelectOption[] {
  return [
    { value: "", label: "协议默认" },
    ...paramChoices(k).map((choice) => ({ value: choice, label: valueLabels[choice] ?? choice })),
  ];
}

const stale = computed(
  () =>
    baseline.value !== props.snapshot.settingsRevision ||
    packRevision.value !== props.snapshot.pack.active,
);
const own = computed(() =>
  props.scope === "account" ? props.entry.accountOverrides : props.entry.offeringOverrides,
);
const locked = computed(() => props.readonly || props.entry.actions.edit.state !== "enabled");
const context = computed(() => ({
  instanceId: props.snapshot.stamp.instanceId,
  contextId: props.snapshot.backend.contextId,
}));
const command = () => ({
  ...context.value,
  expectedBindingRevision: props.catalog.bindingRevision,
  expectedSettingsRevision: baseline.value,
  selection: props.entry.selection,
});
const currentCard = computed(() =>
  card.value !== undefined
    ? card.value
    : planKey.value !== undefined
      ? (props.entry.rateCards[planKey.value] ?? null)
      : props.entry.rateCard,
);

async function switchPlan(event: Event) {
  const el = event.target as HTMLInputElement;
  const value = el.value.trim();
  el.value = planKey.value ?? props.entry.ratePlanKey;
  if (card.value !== undefined && !(await mayLeave())) return;
  planKey.value = value;
  card.value = undefined;
}

function parameterSource(k: keyof ModelParameters) {
  const source = props.entry.parameterSources[k];
  return source ? (parameterSourceLabels[source] ?? source) : parameterSourceLabels.default;
}

const triStateOptions = [
  { value: "supported", label: "支持" },
  { value: "unsupported", label: "不支持" },
  { value: "unknown", label: "未知" },
] as const;

const defaultEffortFallback = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function choices(k: keyof ModelFacts): string[] {
  switch (k) {
    case "inputModalities":
    case "outputModalities":
      return Object.keys(modalityLabels);
    case "operations":
      return Object.keys(operationLabels);
    case "effortLevels": {
      const fromTemplate = parameterSpec("effort")?.choices?.map(String) ?? [];
      return [...new Set([...(fromTemplate.length ? fromTemplate : defaultEffortFallback)])];
    }
    case "unsupportedParameters":
      return [...Object.keys(parameterLabels), "stream", "stream_options"];
    case "structuredOutput":
      return ["unknown", "unsupported", "json", "schema"];
    case "reasoningOutputMode":
      return ["full", "summary", "activity-only", "none", "unknown"];
    case "reasoningMode":
      return ["unknown", "none", "effort", "native-state"];
    case "defaultEffort":
      return [
        ...new Set(
          [
            ...(Array.isArray(fact("effortLevels")) ? (fact("effortLevels") as string[]) : []),
            String(fact(k) ?? ""),
          ].filter(Boolean),
        ),
      ];
    default:
      return ["unknown", "supported", "unsupported"];
  }
}

function fact(k: keyof ModelFacts) {
  const v = edits.value[k];
  return v ? (v.operation === "set" ? v.value : null) : props.entry.fields[k].value;
}

function fieldSource(k: keyof ModelFacts) {
  const src = props.entry.fields[k].source;
  if (src?.scope === "series" && !Object.hasOwn(own.value.facts, k) && !edits.value[k])
    return factSourceLabels.series;
  if (edits.value[k]?.operation === "clear") return factSourceLabels.clear;
  if (Object.hasOwn(own.value.facts, k))
    return props.scope === "account" ? factSourceLabels.account : factSourceLabels.offering;
  if (Object.hasOwn(props.entry.offeringOverrides.facts, k)) return factSourceLabels.offering;
  if (src?.revision === "text-llm-default") return factSourceLabels.default;
  return src ? (factSourceLabels[src.kind] ?? src.kind) : factSourceLabels.unknown;
}

function sourceBadgeClass(label: string, isDirty = false) {
  if (isDirty) return "is-dirty";
  if (label.includes("覆盖")) return "is-override";
  if (label.includes("供应商默认")) return "is-offering";
  return "is-neutral";
}

function factDetails(k: keyof ModelFacts) {
  const s = props.entry.fields[k].source;
  return s ? [s.revision, s.checkedAt, s.referenceUrl].filter(Boolean).join(" · ") : undefined;
}

function setFact(k: keyof ModelFacts, value: ModelFacts[keyof ModelFacts]) {
  edits.value[k] = { field: k, operation: "set", value } as ModelFieldChange;
}

function pickList(k: keyof ModelFacts, v: string) {
  const a = fact(k);
  const xs = Array.isArray(a) ? (a as string[]) : [];
  setFact(k, xs.includes(v) ? xs.filter((i) => i !== v) : [...xs, v]);
}

function listOptions(k: keyof ModelFacts) {
  const a = fact(k);
  const all = [...new Set([...choices(k), ...(Array.isArray(a) ? (a as string[]) : [])])];
  return all.map((v) => ({
    value: v,
    label:
      k === "effortLevels"
        ? formatEffortLabel(v)
        : (valueLabels[v] ?? parameterLabels[v as keyof ModelParameters] ?? v),
  }));
}

function listValue(k: keyof ModelFacts): string[] | null {
  const v = fact(k);
  return Array.isArray(v) ? (v as string[]) : null;
}

const reasoningSummary = computed(() => {
  const mode = String(fact("reasoningMode") ?? "unknown");
  const out = String(fact("reasoningOutputMode") ?? "unknown");
  return `${valueLabels[mode] ?? mode} · 思考输出：${valueLabels[out] ?? out}`;
});

const advancedFactsSummary = computed(() => {
  const parallel = String(fact("parallelToolCalling") ?? "unknown");
  const unsupported = listValue("unsupportedParameters")?.length ?? 0;
  return `并行工具：${valueLabels[parallel] ?? parallel}${unsupported ? ` · ${unsupported} 项受限参数` : ""}`;
});

function parameter(k: keyof ModelParameters): ModelParameters[keyof ModelParameters] {
  if ((k === "effort" || k === "returnFullReasoning") && parameter("thinkingEnabled") === false)
    return k === "effort" ? null : false;
  const v = params.value[k];
  return v ? (v.operation === "set" ? v.value : null) : props.entry.parameters[k];
}

const numericParams = [
  "maxOutputTokens",
  "contextWindow",
  "topP",
  "temperature",
  "count",
  "durationSeconds",
  "dimensions",
  "topK",
];

const parameterKeys = computed(() => {
  const keys = props.entry.parameterTemplate
    ? (Object.keys(props.entry.parameterTemplate.fields) as (keyof ModelParameters)[])
    : (paramKeys[props.entry.operation] ?? []);
  return keys;
});

const parameterSpec = (k: keyof ModelParameters) => props.entry.parameterTemplate?.fields[k];

function numeric(k: keyof ModelParameters) {
  const spec = parameterSpec(k);
  return spec ? spec.type !== "string" : numericParams.includes(k);
}

const effortChoices = computed<string[]>(() => {
  const fromFact = fact("effortLevels");
  if (Array.isArray(fromFact) && fromFact.length) return fromFact.map(String);
  const fromSpec = parameterSpec("effort")?.choices;
  if (fromSpec?.length) return fromSpec.map(String);
  return [];
});

function paramChoices(k: keyof ModelParameters): string[] {
  if (k === "effort") return effortChoices.value;
  return (parameterSpec(k)?.choices ?? []).map(String);
}

const chatReasoningKeys = computed(() =>
  (["thinkingEnabled", "effort", "returnFullReasoning"] as const).filter((k) =>
    parameterKeys.value.includes(k),
  ),
);

const chatPrimaryKeys = computed(() =>
  (["maxOutputTokens", "temperature"] as const).filter((k) => parameterKeys.value.includes(k)),
);

const chatAdvancedKeys = computed(() => {
  const core = new Set<string>([...chatReasoningKeys.value, ...chatPrimaryKeys.value]);
  return parameterKeys.value.filter((k) => !core.has(k));
});

const hasAdvancedParamOverrides = computed(() =>
  chatAdvancedKeys.value.some((k) => parameter(k) != null || !!params.value[k]),
);

const thinkingChecked = computed(() => {
  const v = parameter("thinkingEnabled");
  return v === true || v == null;
});

const fullReasoningDisabledReason = computed(() => {
  if (fact("reasoningMode") === "none") return "当前模型不支持思考推理";
  if (!thinkingChecked.value) return "请先开启「支持思考」";
  const mode = fact("reasoningOutputMode");
  if (mode === "summary") return "当前绑定仅公开思考摘要，无法请求完整思考内容";
  if (mode === "activity-only") return "当前绑定仅报告思考阶段";
  if (mode === "none") return "当前绑定不公开思考内容";
  if (mode !== "full") return "公开思考能力尚待核实，暂不可开启全文";
  return "";
});

function setParam(k: keyof ModelParameters, s: string) {
  params.value[k] = {
    field: k,
    operation: "set",
    value: s === "" ? null : numeric(k) ? Number(s) : s,
  };
}

function paramPlaceholder(k: keyof ModelParameters) {
  if (k === "maxOutputTokens") {
    const cap = fact("maxOutputTokens");
    return cap ? `协议默认（模型上限 ${Number(cap).toLocaleString()}）` : "协议默认";
  }
  if (k === "contextWindow") {
    const cap = fact("contextWindow");
    return cap ? `协议默认（窗口 ${Number(cap).toLocaleString()}）` : "协议默认";
  }
  if (k === "temperature") return "协议默认（通常 1.0）";
  if (k === "topP") return "协议默认（通常 1.0）";
  return "协议默认";
}

function paramHint(k: keyof ModelParameters) {
  if (entryUnsupported(k)) return "当前模型或协议标记不支持此参数";
  if (k === "contextWindow") return "仅作为本地上下文预算约束，不会向接口虚构出站字段";
  return undefined;
}

function entryUnsupported(k: keyof ModelParameters) {
  return !!props.entry.fields.unsupportedParameters.value?.includes(k);
}

const priceKinds = ["input", "output", "cache-read", "cache-write"] as const;
type BasicPriceKind = (typeof priceKinds)[number];
const priceFieldLabels: Record<BasicPriceKind, string> = {
  input: "输入单价 / 每 1,000,000 tokens",
  output: "输出单价 / 每 1,000,000 tokens",
  "cache-read": "缓存读取单价 / 每 1,000,000 tokens",
  "cache-write": "缓存写入单价 / 每 1,000,000 tokens",
};
function priceKey(kind: BasicPriceKind): ModelPriceKey {
  return (
    props.entry.prices.find(
      (x) =>
        x.key.kind === kind &&
        x.key.currency === currency.value &&
        x.key.tier === null &&
        x.key.durationSeconds === null &&
        ["million-tokens", "1M tokens"].includes(x.key.unit),
    )?.key ?? {
      kind,
      currency: currency.value,
      unit: "million-tokens",
      tier: null,
      durationSeconds: null,
    }
  );
}
function priceId(key: ModelPriceKey) {
  return JSON.stringify([key.kind, key.currency, key.unit, key.tier, key.durationSeconds]);
}
function priceRow(kind: BasicPriceKind) {
  const key = priceKey(kind),
    id = priceId(key),
    change = prices.value[id],
    row = props.entry.prices.find((x) => priceId(x.key) === id);
  const resettable = own.value.prices.some((p) => priceId(p) === id);
  return {
    key,
    id,
    change,
    value: change ? (change.operation === "set" ? change.amount : null) : row?.amount.value,
    source: resettable
      ? props.scope === "account"
        ? priceSourceLabels.account
        : priceSourceLabels.offering
      : props.entry.offeringOverrides.prices.some((p) => priceId(p) === id)
        ? priceSourceLabels.offering
        : row?.amount.source?.kind === "preset"
          ? priceSourceLabels.preset
          : row?.amount.source?.kind === "remote"
            ? priceSourceLabels.remote
            : priceSourceLabels.unknown,
    resettable,
  };
}
function setPrice(kind: BasicPriceKind, s: string) {
  const r = priceRow(kind);
  prices.value[r.id] = { operation: "set", key: r.key, amount: s.trim() || null };
}
function resetPrice(kind: BasicPriceKind) {
  const r = priceRow(kind);
  prices.value[r.id] = { operation: "clear", key: r.key };
}
const remainingPrices = computed(() =>
  props.entry.prices.filter(
    (p) => !priceKinds.some((k) => priceId(priceKey(k)) === priceId(p.key)),
  ),
);

const val = (e: Event) => (e.target as HTMLInputElement).value;
function discard() {
  edits.value = {};
  params.value = {};
  prices.value = {};
  card.value = undefined;
  planKey.value = undefined;
  preset.value = undefined;
  baseline.value = props.snapshot.settingsRevision;
  packRevision.value = props.snapshot.pack.active;
  preview.value = null;
  error.value = null;
}
watch(
  () => [props.snapshot.settingsRevision, props.snapshot.pack.active],
  () => {
    if (!dirty.value) discard();
  },
);
watch(locked, (v) => {
  if (v) discard();
});
watch(
  [edits, params, prices, card, preset, planKey],
  () => {
    preview.value = null;
    message.value = "";
  },
  { deep: true },
);

function boundRateCard() {
  const edited = card.value;
  if (!edited) return edited;
  return {
    ...edited,
    scope: {
      ...edited.scope,
      providerId: props.catalog.providerId,
      offeringId: props.catalog.offeringId,
      operation: props.entry.operation,
      protocol: props.catalog.protocol,
      upstreamModelId: props.entry.selection.modelId,
      planKey: planKey.value ?? props.entry.ratePlanKey,
    },
  };
}

function draft(): SaveModelDraftRequest {
  return {
    ...command(),
    scope: props.scope,
    operation: props.entry.operation,
    ioProfile: props.entry.ioProfile,
    expectedPackRevision: packRevision.value,
    changes: Object.values(edits.value),
    parameterChanges: Object.values(params.value),
    priceChanges: Object.values(prices.value),
    ...(planKey.value !== undefined ? { ratePlanKey: planKey.value } : {}),
    ...(card.value !== undefined ? { rateCard: boundRateCard() } : {}),
    ...(preset.value !== undefined ? { presetKey: preset.value } : {}),
  };
}

function report(e: PublicError) {
  error.value = e;
  const path = e.fields?.[0]?.path ?? "";
  if (path.includes("price") || path.includes("rateCard")) tab.value = "prices";
  else if (path.includes("parameter")) tab.value = "parameters";
  else if (path.includes("changes") || path.includes("preset")) tab.value = "facts";
  void nextTick(() => {
    const index = Number(path.match(/(?:changes|Changes)\[?\.?([0-9]+)/)?.[1]);
    const key = path.includes("parameter")
      ? (Object.values(params.value)[index]?.field ?? path.split(".").at(-1))
      : path.includes("price")
        ? Object.values(prices.value)[index]?.key.kind
        : (Object.values(edits.value)[index]?.field ?? path.split(".").at(-1));
    const target = key
      ? Array.from(form.value?.querySelectorAll<HTMLElement>("[data-field]") ?? []).find(
          (el) => el.dataset.field === key,
        )
      : undefined;
    if (target) {
      let ancestor = target.parentElement?.closest<HTMLElement>("[data-collapsible]");
      while (ancestor) {
        if (ancestor.dataset.open === "false") {
          ancestor
            .querySelector<HTMLButtonElement>(
              ":scope > .collapsible-header-row > .collapsible-trigger",
            )
            ?.click();
        }
        ancestor = ancestor.parentElement?.closest<HTMLElement>("[data-collapsible]");
      }
      target.querySelector<HTMLElement>("input,select,button")?.focus();
    } else form.value?.querySelector<HTMLElement>("[role=alert]")?.focus();
  });
}

async function save() {
  if (busy.value || stale.value || locked.value) return false;
  busy.value = true;
  error.value = null;
  try {
    const r = await service.saveModelDraft(draft());
    if (!alive) return false;
    if (!r.ok) {
      report(r.error);
      emit("reload");
      return false;
    }
    discard();
    baseline.value = r.value.settingsRevision;
    message.value = "配置已保存";
    emit("reload");
    return true;
  } catch (e) {
    if (alive)
      report({
        message: e instanceof Error ? e.message : "保存失败",
        code: "error",
        retryable: true,
      });
    return false;
  } finally {
    busy.value = false;
  }
}

function closeDecision(ok: boolean) {
  leaveOpen.value = false;
  decide?.(ok);
  decide = undefined;
}
function mayLeave(): Promise<boolean> {
  if (!dirty.value) return Promise.resolve(true);
  if (leaveOpen.value || busy.value) return Promise.resolve(false);
  leaveOpen.value = true;
  return new Promise((resolve) => (decide = resolve));
}
defineExpose({ mayLeave });
onBeforeUnmount(() => {
  alive = false;
  closeDecision(false);
});

async function chooseTest() {
  if (props.scope === "offering") {
    publicTest.value = true;
    return;
  }
  if (busy.value || dirty.value || stale.value) return;
  busy.value = true;
  try {
    const r = await service.saveModelSelection({
      ...context.value,
      expectedSettingsRevision: baseline.value,
      choice: {
        selection: props.entry.selection,
        expectedBindingRevision: props.catalog.bindingRevision,
      },
    });
    if (!alive) return;
    if (!r.ok) report(r.error);
    else {
      message.value = "已设为测试模型";
      emit("reload");
    }
  } finally {
    busy.value = false;
  }
}

async function previewDraft() {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  const p = { ...props.entry.parameters };
  for (const v of Object.values(params.value))
    Object.assign(p, { [v.field]: v.operation === "set" ? v.value : null });
  try {
    const r = await service.previewRequest({
      ...command(),
      operation: props.entry.operation,
      parameters: p,
      draft: draft(),
    });
    if (!alive) return;
    if (!r.ok) report(r.error);
    else preview.value = r.value;
  } finally {
    busy.value = false;
  }
}

const isSelected = computed(() => {
  const v = props.snapshot.savedSelection?.selection;
  return (
    v?.accountId === props.catalog.accountId &&
    v.protocol === props.catalog.protocol &&
    v.modelId === props.entry.selection.modelId
  );
});
</script>

<template>
  <section ref="form" class="graph-card graph-editor">
    <header class="editor-header">
      <div class="editor-header-copy">
        <p v-if="breadcrumb" class="editor-breadcrumb">{{ breadcrumb }}</p>
        <div class="editor-title-row">
          <h2>{{ entry.displayName }}</h2>
          <span v-if="isSelected" class="status-pill is-brand">当前测试模型</span>
        </div>
        <div class="editor-subtitle-row">
          <code v-if="entry.displayName !== entry.selection.modelId" class="model-id-code">{{
            entry.selection.modelId
          }}</code>
          <span class="subtle-tag">{{ typeLabels[entry.modelType] ?? entry.modelType }}</span>
          <span v-for="p in entry.ioProfiles" :key="p.kind" class="subtle-tag">
            {{
              [
                ...p.requiredInputs.map((v) => modalityLabels[v] ?? v),
                ...p.optionalInputs.map((v) => (modalityLabels[v] ?? v) + "（可选）"),
              ].join(" + ")
            }}
            → {{ p.outputs.map((v) => modalityLabels[v] ?? v).join(" + ") }}
          </span>
        </div>
      </div>
      <div v-if="removable" class="editor-header-actions">
        <button
          type="button"
          class="outline-action danger-text compact-btn"
          :disabled="removeBusy || busy"
          @click="emit('removeManual')"
        >
          <AppIcon name="trash" :size="14" /> 移除当前手工登记
        </button>
      </div>
    </header>

    <nav class="editor-tabs" aria-label="模型配置页签">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        :aria-pressed="tab === t.id"
        @click="tab = t.id"
      >
        <span>{{ t.label }}</span>
        <span
          v-if="tabDirtyCount(t.id)"
          class="tab-dirty-dot"
          :title="`已改 ${tabDirtyCount(t.id)} 项`"
        />
      </button>
    </nav>

    <fieldset class="plain-fields editor-body" :disabled="locked || busy">
      <!-- ── 页签 1：能力与限制 ──────────────────────────────────────────── -->
      <template v-if="tab === 'facts'">
        <section class="editor-section preset-bar">
          <ConfigField
            label="参考型号"
            :dirty="preset !== undefined"
            hint="未手工覆盖的字段将继承所选参考型号的预置能力。"
          >
            <RichSelect
              :model-value="preset === undefined ? (entry.presetKey ?? '') : (preset ?? '')"
              :options="presetOptions"
              placeholder="自动匹配"
              search-placeholder="搜索参考型号"
              searchable
              :disabled="locked || busy"
              @select="preset = $event || null"
            />
          </ConfigField>
        </section>

        <section v-if="entry.operation === 'chat'" class="editor-section">
          <h3>容量限制</h3>
          <div class="editor-two-col">
            <div data-field="contextWindow">
              <ConfigField
                :label="factLabels.contextWindow"
                unit="tokens"
                :dirty="!!edits.contextWindow"
                :source="fieldSource('contextWindow')"
                :details="factDetails('contextWindow')"
                :resettable="Object.hasOwn(own.facts, 'contextWindow') || !!edits.contextWindow"
                @reset="edits.contextWindow = { field: 'contextWindow', operation: 'clear' }"
              >
                <input
                  type="number"
                  min="1"
                  step="1"
                  :value="fact('contextWindow') ?? ''"
                  placeholder="未知"
                  @input="setFact('contextWindow', val($event) === '' ? null : Number(val($event)))"
                />
              </ConfigField>
            </div>
            <div data-field="maxOutputTokens">
              <ConfigField
                :label="factLabels.maxOutputTokens"
                unit="tokens"
                :dirty="!!edits.maxOutputTokens"
                :source="fieldSource('maxOutputTokens')"
                :details="factDetails('maxOutputTokens')"
                :resettable="Object.hasOwn(own.facts, 'maxOutputTokens') || !!edits.maxOutputTokens"
                @reset="edits.maxOutputTokens = { field: 'maxOutputTokens', operation: 'clear' }"
              >
                <input
                  type="number"
                  min="1"
                  step="1"
                  :value="fact('maxOutputTokens') ?? ''"
                  placeholder="未知"
                  @input="
                    setFact('maxOutputTokens', val($event) === '' ? null : Number(val($event)))
                  "
                />
              </ConfigField>
            </div>
          </div>
        </section>

        <section class="editor-section">
          <h3>模态与核心能力</h3>
          <div class="editor-stack">
            <div
              v-for="k in ['inputModalities', 'outputModalities'] as const"
              :key="k"
              :data-field="k"
              class="tag-editor-row"
            >
              <div class="tag-editor-head">
                <span class="field-heading">{{ factLabels[k] }}</span>
                <span
                  class="source-pill"
                  :class="sourceBadgeClass(fieldSource(k), !!edits[k])"
                  :title="factDetails(k)"
                >
                  {{ edits[k] ? "未保存" : fieldSource(k) }}
                </span>
                <div class="tag-editor-actions">
                  <button
                    v-if="fact(k) !== null"
                    type="button"
                    class="link-action"
                    @click="setFact(k, null)"
                  >
                    设为未知
                  </button>
                  <button
                    v-if="Object.hasOwn(own.facts, k) || edits[k]"
                    type="button"
                    class="link-action"
                    @click="edits[k] = { field: k, operation: 'clear' }"
                  >
                    恢复继承
                  </button>
                </div>
              </div>
              <TagToggleGroup
                :values="listValue(k)"
                :options="listOptions(k)"
                :disabled="locked || busy"
                @toggle="pickList(k, $event)"
              />
            </div>

            <div v-if="entry.operation === 'chat'" class="editor-two-col">
              <div data-field="toolCalling" class="segmented-field">
                <div class="tag-editor-head">
                  <span class="field-heading">{{ factLabels.toolCalling }}</span>
                  <span
                    class="source-pill"
                    :class="sourceBadgeClass(fieldSource('toolCalling'), !!edits.toolCalling)"
                    :title="factDetails('toolCalling')"
                  >
                    {{ edits.toolCalling ? "未保存" : fieldSource("toolCalling") }}
                  </span>
                  <button
                    v-if="Object.hasOwn(own.facts, 'toolCalling') || edits.toolCalling"
                    type="button"
                    class="link-action tag-editor-actions"
                    @click="edits.toolCalling = { field: 'toolCalling', operation: 'clear' }"
                  >
                    恢复继承
                  </button>
                </div>
                <SegmentedControl
                  :model-value="String(fact('toolCalling') ?? 'unknown')"
                  :options="triStateOptions"
                  :aria-label="factLabels.toolCalling"
                  :disabled="locked || busy"
                  @update:model-value="setFact('toolCalling', $event as ModelFacts['toolCalling'])"
                />
              </div>

              <div data-field="structuredOutput">
                <ConfigField
                  :label="factLabels.structuredOutput"
                  :dirty="!!edits.structuredOutput"
                  :source="fieldSource('structuredOutput')"
                  :details="factDetails('structuredOutput')"
                  :resettable="
                    Object.hasOwn(own.facts, 'structuredOutput') || !!edits.structuredOutput
                  "
                  @reset="
                    edits.structuredOutput = { field: 'structuredOutput', operation: 'clear' }
                  "
                >
                  <RichSelect
                    :model-value="String(fact('structuredOutput') ?? 'unknown')"
                    :options="factChoiceOptions('structuredOutput')"
                    :disabled="locked || busy"
                    @select="
                      setFact(
                        'structuredOutput',
                        ($event || 'unknown') as ModelFacts['structuredOutput'],
                      )
                    "
                  />
                </ConfigField>
              </div>

              <div
                v-for="k in ['vision', 'promptCacheRead', 'promptCacheWrite'] as const"
                :key="k"
                :data-field="k"
                class="segmented-field"
              >
                <div class="tag-editor-head">
                  <span class="field-heading">{{ factLabels[k] }}</span>
                  <span
                    class="source-pill"
                    :class="sourceBadgeClass(fieldSource(k), !!edits[k])"
                    :title="factDetails(k)"
                  >
                    {{ edits[k] ? "未保存" : fieldSource(k) }}
                  </span>
                  <button
                    v-if="Object.hasOwn(own.facts, k) || edits[k]"
                    type="button"
                    class="link-action tag-editor-actions"
                    @click="edits[k] = { field: k, operation: 'clear' }"
                  >
                    恢复继承
                  </button>
                </div>
                <SegmentedControl
                  :model-value="String(fact(k) ?? 'unknown')"
                  :options="triStateOptions"
                  :aria-label="factLabels[k]"
                  :disabled="locked || busy"
                  @update:model-value="setFact(k, $event as ModelFacts[typeof k])"
                />
              </div>
            </div>
          </div>
        </section>

        <CollapsiblePanel
          v-if="entry.operation === 'chat'"
          variant="card"
          title="推理能力配置"
          :summary="reasoningSummary"
        >
          <div class="editor-collapsible-body">
            <div class="editor-two-col">
              <div data-field="reasoningMode">
                <ConfigField
                  :label="factLabels.reasoningMode"
                  :dirty="!!edits.reasoningMode"
                  :source="fieldSource('reasoningMode')"
                  :details="factDetails('reasoningMode')"
                  :resettable="Object.hasOwn(own.facts, 'reasoningMode') || !!edits.reasoningMode"
                  @reset="edits.reasoningMode = { field: 'reasoningMode', operation: 'clear' }"
                >
                  <RichSelect
                    :model-value="String(fact('reasoningMode') ?? 'unknown')"
                    :options="factChoiceOptions('reasoningMode')"
                    :disabled="locked || busy"
                    @select="setFact('reasoningMode', $event as ModelFacts['reasoningMode'])"
                  />
                </ConfigField>
              </div>
              <div data-field="reasoningOutputMode">
                <ConfigField
                  :label="factLabels.reasoningOutputMode"
                  :dirty="!!edits.reasoningOutputMode"
                  :source="fieldSource('reasoningOutputMode')"
                  :details="factDetails('reasoningOutputMode')"
                  :resettable="
                    Object.hasOwn(own.facts, 'reasoningOutputMode') || !!edits.reasoningOutputMode
                  "
                  @reset="
                    edits.reasoningOutputMode = {
                      field: 'reasoningOutputMode',
                      operation: 'clear',
                    }
                  "
                >
                  <RichSelect
                    :model-value="String(fact('reasoningOutputMode') ?? 'unknown')"
                    :options="factChoiceOptions('reasoningOutputMode')"
                    :disabled="locked || busy"
                    @select="
                      setFact('reasoningOutputMode', $event as ModelFacts['reasoningOutputMode'])
                    "
                  />
                </ConfigField>
              </div>
            </div>

            <div data-field="effortLevels" class="tag-editor-row">
              <div class="tag-editor-head">
                <span class="field-heading">{{ factLabels.effortLevels }}</span>
                <span
                  class="source-pill"
                  :class="sourceBadgeClass(fieldSource('effortLevels'), !!edits.effortLevels)"
                  :title="factDetails('effortLevels')"
                >
                  {{ edits.effortLevels ? "未保存" : fieldSource("effortLevels") }}
                </span>
                <div class="tag-editor-actions">
                  <button
                    v-if="fact('effortLevels') !== null"
                    type="button"
                    class="link-action"
                    @click="setFact('effortLevels', null)"
                  >
                    设为未知
                  </button>
                  <button
                    v-if="Object.hasOwn(own.facts, 'effortLevels') || edits.effortLevels"
                    type="button"
                    class="link-action"
                    @click="edits.effortLevels = { field: 'effortLevels', operation: 'clear' }"
                  >
                    恢复继承
                  </button>
                </div>
              </div>
              <TagToggleGroup
                :values="listValue('effortLevels')"
                :options="listOptions('effortLevels')"
                :disabled="locked || busy"
                @toggle="pickList('effortLevels', $event)"
              />
            </div>

            <div data-field="defaultEffort">
              <ConfigField
                :label="factLabels.defaultEffort"
                :dirty="!!edits.defaultEffort"
                :source="fieldSource('defaultEffort')"
                :details="factDetails('defaultEffort')"
                :resettable="Object.hasOwn(own.facts, 'defaultEffort') || !!edits.defaultEffort"
                @reset="edits.defaultEffort = { field: 'defaultEffort', operation: 'clear' }"
              >
                <RichSelect
                  :model-value="String(fact('defaultEffort') ?? '')"
                  :options="defaultEffortOptions"
                  :disabled="locked || busy"
                  @select="setFact('defaultEffort', $event || null)"
                />
              </ConfigField>
            </div>
          </div>
        </CollapsiblePanel>

        <CollapsiblePanel
          variant="card"
          title="高级限制与参数约束"
          :summary="entry.operation === 'chat' ? advancedFactsSummary : undefined"
        >
          <div class="editor-collapsible-body">
            <div v-if="entry.operation === 'chat'" class="editor-two-col">
              <div data-field="maxInputTokens">
                <ConfigField
                  :label="factLabels.maxInputTokens"
                  unit="tokens"
                  :dirty="!!edits.maxInputTokens"
                  :source="fieldSource('maxInputTokens')"
                  :details="factDetails('maxInputTokens')"
                  :resettable="Object.hasOwn(own.facts, 'maxInputTokens') || !!edits.maxInputTokens"
                  @reset="edits.maxInputTokens = { field: 'maxInputTokens', operation: 'clear' }"
                >
                  <input
                    type="number"
                    min="1"
                    step="1"
                    :value="fact('maxInputTokens') ?? ''"
                    placeholder="未知"
                    @input="
                      setFact('maxInputTokens', val($event) === '' ? null : Number(val($event)))
                    "
                  />
                </ConfigField>
              </div>

              <div data-field="parallelToolCalling" class="segmented-field">
                <div class="tag-editor-head">
                  <span class="field-heading">{{ factLabels.parallelToolCalling }}</span>
                  <span
                    class="source-pill"
                    :class="
                      sourceBadgeClass(
                        fieldSource('parallelToolCalling'),
                        !!edits.parallelToolCalling,
                      )
                    "
                    :title="factDetails('parallelToolCalling')"
                  >
                    {{ edits.parallelToolCalling ? "未保存" : fieldSource("parallelToolCalling") }}
                  </span>
                  <button
                    v-if="
                      Object.hasOwn(own.facts, 'parallelToolCalling') || edits.parallelToolCalling
                    "
                    type="button"
                    class="link-action tag-editor-actions"
                    @click="
                      edits.parallelToolCalling = {
                        field: 'parallelToolCalling',
                        operation: 'clear',
                      }
                    "
                  >
                    恢复继承
                  </button>
                </div>
                <SegmentedControl
                  :model-value="String(fact('parallelToolCalling') ?? 'unknown')"
                  :options="triStateOptions"
                  :aria-label="factLabels.parallelToolCalling"
                  :disabled="locked || busy"
                  @update:model-value="
                    setFact('parallelToolCalling', $event as ModelFacts['parallelToolCalling'])
                  "
                />
              </div>
            </div>

            <div data-field="operations" class="tag-editor-row">
              <div class="tag-editor-head">
                <span class="field-heading">{{ factLabels.operations }}</span>
                <span
                  class="source-pill"
                  :class="sourceBadgeClass(fieldSource('operations'), !!edits.operations)"
                  :title="factDetails('operations')"
                >
                  {{ edits.operations ? "未保存" : fieldSource("operations") }}
                </span>
                <div class="tag-editor-actions">
                  <button
                    v-if="fact('operations') !== null"
                    type="button"
                    class="link-action"
                    @click="setFact('operations', null)"
                  >
                    设为未知
                  </button>
                  <button
                    v-if="Object.hasOwn(own.facts, 'operations') || edits.operations"
                    type="button"
                    class="link-action"
                    @click="edits.operations = { field: 'operations', operation: 'clear' }"
                  >
                    恢复继承
                  </button>
                </div>
              </div>
              <TagToggleGroup
                :values="listValue('operations')"
                :options="listOptions('operations')"
                :disabled="locked || busy"
                @toggle="pickList('operations', $event)"
              />
            </div>

            <div
              v-if="entry.operation === 'chat'"
              data-field="unsupportedParameters"
              class="tag-editor-row"
            >
              <div class="tag-editor-head">
                <span class="field-heading">{{ factLabels.unsupportedParameters }}</span>
                <span
                  class="source-pill"
                  :class="
                    sourceBadgeClass(
                      fieldSource('unsupportedParameters'),
                      !!edits.unsupportedParameters,
                    )
                  "
                  :title="factDetails('unsupportedParameters')"
                >
                  {{
                    edits.unsupportedParameters ? "未保存" : fieldSource("unsupportedParameters")
                  }}
                </span>
                <div class="tag-editor-actions">
                  <button
                    v-if="fact('unsupportedParameters') !== null"
                    type="button"
                    class="link-action"
                    @click="setFact('unsupportedParameters', null)"
                  >
                    设为未知
                  </button>
                  <button
                    v-if="
                      Object.hasOwn(own.facts, 'unsupportedParameters') ||
                      edits.unsupportedParameters
                    "
                    type="button"
                    class="link-action"
                    @click="
                      edits.unsupportedParameters = {
                        field: 'unsupportedParameters',
                        operation: 'clear',
                      }
                    "
                  >
                    恢复继承
                  </button>
                </div>
              </div>
              <TagToggleGroup
                :values="listValue('unsupportedParameters')"
                :options="listOptions('unsupportedParameters')"
                :disabled="locked || busy"
                @toggle="pickList('unsupportedParameters', $event)"
              />
            </div>
          </div>
        </CollapsiblePanel>
      </template>

      <!-- ── 页签 2：调用参数 ────────────────────────────────────────────── -->
      <template v-if="tab === 'parameters'">
        <template v-if="entry.operation === 'chat'">
          <section v-if="chatReasoningKeys.length" class="editor-section">
            <h3>思考与推理</h3>
            <div class="editor-stack">
              <div
                v-if="chatReasoningKeys.includes('thinkingEnabled')"
                data-field="thinkingEnabled"
                class="toggle-row"
              >
                <label class="toggle-control">
                  <input
                    type="checkbox"
                    :checked="thinkingChecked"
                    :disabled="fact('reasoningMode') === 'none'"
                    @change="
                      params.thinkingEnabled = {
                        field: 'thinkingEnabled',
                        operation: 'set',
                        value: ($event.target as HTMLInputElement).checked,
                      }
                    "
                  />
                  <span class="toggle-track" aria-hidden="true" />
                  <span class="toggle-copy">
                    <span class="toggle-title">
                      {{ parameterLabels.thinkingEnabled }}
                      <span
                        class="source-pill"
                        :class="
                          sourceBadgeClass(
                            parameterSource('thinkingEnabled'),
                            !!params.thinkingEnabled,
                          )
                        "
                      >
                        {{ params.thinkingEnabled ? "未保存" : parameterSource("thinkingEnabled") }}
                      </span>
                    </span>
                    <small>
                      {{
                        fact("reasoningMode") === "none"
                          ? "该模型声明不支持推理思考"
                          : "默认开启；关闭后将不再发送推理强度，也不请求思考展示"
                      }}
                    </small>
                  </span>
                </label>
                <button
                  v-if="
                    Object.hasOwn(own.parameters, 'thinkingEnabled') || !!params.thinkingEnabled
                  "
                  type="button"
                  class="link-action"
                  @click="params.thinkingEnabled = { field: 'thinkingEnabled', operation: 'clear' }"
                >
                  恢复继承
                </button>
              </div>

              <div v-if="chatReasoningKeys.includes('effort')" data-field="effort">
                <ConfigField
                  :label="parameterLabels.effort ?? '推理强度'"
                  :dirty="!!params.effort"
                  :source="parameterSource('effort')"
                  :hint="
                    !thinkingChecked
                      ? '开启「支持思考」后可调整推理强度'
                      : entryUnsupported('effort')
                        ? '当前绑定不支持该参数'
                        : undefined
                  "
                  :resettable="Object.hasOwn(own.parameters, 'effort') || !!params.effort"
                  @reset="params.effort = { field: 'effort', operation: 'clear' }"
                >
                  <RichSelect
                    v-if="effortChoices.length"
                    :model-value="String(parameter('effort') ?? '')"
                    :options="effortChoiceOptions"
                    :disabled="locked || busy || entryUnsupported('effort') || !thinkingChecked"
                    @select="setParam('effort', $event)"
                  />
                  <input
                    v-else
                    type="text"
                    :value="parameter('effort') ?? ''"
                    :disabled="entryUnsupported('effort') || !thinkingChecked"
                    placeholder="协议默认"
                    @input="setParam('effort', val($event))"
                  />
                </ConfigField>
              </div>

              <div
                v-if="chatReasoningKeys.includes('returnFullReasoning')"
                data-field="returnFullReasoning"
                class="toggle-row"
              >
                <label class="toggle-control">
                  <input
                    type="checkbox"
                    :checked="parameter('returnFullReasoning') === true"
                    :disabled="!!fullReasoningDisabledReason"
                    @change="
                      params.returnFullReasoning = {
                        field: 'returnFullReasoning',
                        operation: 'set',
                        value: ($event.target as HTMLInputElement).checked,
                      }
                    "
                  />
                  <span class="toggle-track" aria-hidden="true" />
                  <span class="toggle-copy">
                    <span class="toggle-title">
                      {{ parameterLabels.returnFullReasoning }}
                      <span
                        class="source-pill"
                        :class="
                          sourceBadgeClass(
                            parameterSource('returnFullReasoning'),
                            !!params.returnFullReasoning,
                          )
                        "
                      >
                        {{
                          params.returnFullReasoning
                            ? "未保存"
                            : parameterSource("returnFullReasoning")
                        }}
                      </span>
                    </span>
                    <small>
                      {{
                        fullReasoningDisabledReason ||
                        "默认关闭；开启后在测试对话中展示上游返回的完整公开思考文本"
                      }}
                    </small>
                  </span>
                </label>
                <button
                  v-if="
                    Object.hasOwn(own.parameters, 'returnFullReasoning') ||
                    !!params.returnFullReasoning
                  "
                  type="button"
                  class="link-action"
                  @click="
                    params.returnFullReasoning = {
                      field: 'returnFullReasoning',
                      operation: 'clear',
                    }
                  "
                >
                  恢复继承
                </button>
              </div>
            </div>
          </section>

          <section v-if="chatPrimaryKeys.length" class="editor-section">
            <h3>常用生成参数</h3>
            <div class="editor-two-col">
              <div v-for="k in chatPrimaryKeys" :key="k" :data-field="k">
                <ConfigField
                  :label="parameterLabels[k] ?? k"
                  :unit="k === 'maxOutputTokens' ? 'tokens' : undefined"
                  :dirty="!!params[k]"
                  :source="parameterSource(k)"
                  :hint="paramHint(k)"
                  :resettable="Object.hasOwn(own.parameters, k) || !!params[k]"
                  @reset="params[k] = { field: k, operation: 'clear' }"
                >
                  <input
                    :type="numeric(k) ? 'number' : 'text'"
                    :step="parameterSpec(k)?.type === 'integer' ? 1 : 'any'"
                    :min="parameterSpec(k)?.minimum"
                    :max="parameterSpec(k)?.maximum"
                    :value="parameter(k) ?? ''"
                    :disabled="entryUnsupported(k)"
                    :placeholder="paramPlaceholder(k)"
                    @input="setParam(k, val($event))"
                  />
                </ConfigField>
              </div>
            </div>
          </section>

          <CollapsiblePanel
            v-if="chatAdvancedKeys.length"
            variant="card"
            title="高级调用参数"
            :default-open="hasAdvancedParamOverrides"
            :summary="hasAdvancedParamOverrides ? '已设置自定义值' : '全部使用协议默认'"
          >
            <div class="editor-collapsible-body">
              <div class="editor-two-col">
                <div v-for="k in chatAdvancedKeys" :key="k" :data-field="k">
                  <ConfigField
                    :label="parameterLabels[k] ?? k"
                    :unit="k === 'contextWindow' ? 'tokens' : undefined"
                    :dirty="!!params[k]"
                    :source="parameterSource(k)"
                    :hint="paramHint(k)"
                    :resettable="Object.hasOwn(own.parameters, k) || !!params[k]"
                    @reset="params[k] = { field: k, operation: 'clear' }"
                  >
                    <RichSelect
                      v-if="paramChoices(k).length"
                      :model-value="String(parameter(k) ?? '')"
                      :options="paramChoiceOptions(k)"
                      :disabled="locked || busy || entryUnsupported(k)"
                      @select="setParam(k, $event)"
                    />
                    <input
                      v-else
                      :type="numeric(k) ? 'number' : 'text'"
                      :step="parameterSpec(k)?.type === 'integer' ? 1 : 'any'"
                      :min="parameterSpec(k)?.minimum"
                      :max="parameterSpec(k)?.maximum"
                      :value="parameter(k) ?? ''"
                      :disabled="entryUnsupported(k)"
                      :placeholder="paramPlaceholder(k)"
                      @input="setParam(k, val($event))"
                    />
                  </ConfigField>
                </div>
              </div>
            </div>
          </CollapsiblePanel>
        </template>

        <section v-else class="editor-section">
          <h3>调用参数</h3>
          <div v-if="parameterKeys.length" class="editor-two-col">
            <div v-for="k in parameterKeys" :key="k" :data-field="k">
              <ConfigField
                :label="parameterLabels[k] ?? k"
                :unit="parameterSpec(k)?.unit"
                :dirty="!!params[k]"
                :source="parameterSource(k)"
                :hint="paramHint(k)"
                :resettable="Object.hasOwn(own.parameters, k) || !!params[k]"
                @reset="params[k] = { field: k, operation: 'clear' }"
              >
                <RichSelect
                  v-if="paramChoices(k).length"
                  :model-value="String(parameter(k) ?? '')"
                  :options="paramChoiceOptions(k)"
                  :disabled="locked || busy || entryUnsupported(k)"
                  @select="setParam(k, $event)"
                />
                <input
                  v-else
                  :type="numeric(k) ? 'number' : 'text'"
                  :step="parameterSpec(k)?.type === 'integer' ? 1 : 'any'"
                  :min="parameterSpec(k)?.minimum"
                  :max="parameterSpec(k)?.maximum"
                  :value="parameter(k) ?? ''"
                  :disabled="entryUnsupported(k)"
                  :placeholder="paramPlaceholder(k)"
                  @input="setParam(k, val($event))"
                />
              </ConfigField>
            </div>
          </div>
          <p v-else class="setting-hint">此操作暂无可编辑的默认调用参数。</p>
        </section>
      </template>

      <!-- ── 页签 3：价格 ────────────────────────────────────────────────── -->
      <template v-if="tab === 'prices'">
        <section class="editor-section">
          <div class="section-head-row">
            <h3>基础单价</h3>
            <span class="setting-hint">留空表示未知，允许填写 0 表示免费</span>
          </div>
          <div class="editor-two-col price-meta-grid">
            <ConfigField label="接入方案 / 套餐">
              <input
                list="model-rate-plans"
                :value="planKey ?? entry.ratePlanKey ?? 'default'"
                placeholder="default"
                @change="switchPlan($event)"
              />
            </ConfigField>
            <ConfigField label="基础报价币种">
              <input
                v-model.trim="currency"
                maxlength="3"
                list="price-currencies"
                placeholder="USD"
              />
            </ConfigField>
          </div>
          <datalist id="model-rate-plans">
            <option value="default" />
            <option v-for="id in Object.keys(entry.rateCards ?? {})" :key="id" :value="id" />
          </datalist>
          <datalist id="price-currencies">
            <option>USD</option>
            <option>CNY</option>
            <option>EUR</option>
          </datalist>

          <div class="editor-two-col">
            <div v-for="k in priceKinds" :key="k" :data-field="k">
              <ConfigField
                :label="priceFieldLabels[k]"
                :unit="currency || 'USD'"
                :source="priceRow(k).source"
                :dirty="!!priceRow(k).change"
                :resettable="priceRow(k).resettable || !!priceRow(k).change"
                @reset="resetPrice(k)"
              >
                <input
                  inputmode="decimal"
                  :value="priceRow(k).value ?? ''"
                  placeholder="未知"
                  @input="setPrice(k, val($event))"
                />
              </ConfigField>
            </div>
          </div>

          <CollapsiblePanel
            v-if="entry.referencePrices.length"
            variant="subtle"
            title="型号原厂参考价"
            :summary="entry.referencePrices.length + ' 项'"
          >
            <table class="mini-price-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>金额</th>
                  <th>单位</th>
                  <th>档位</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in entry.referencePrices" :key="priceId(p)">
                  <td>{{ priceKindLabels[p.kind] ?? p.kind }}</td>
                  <td>{{ p.amount }} {{ p.currency }}</td>
                  <td>{{ p.unit }}</td>
                  <td>{{ p.tier ?? "默认" }}</td>
                </tr>
              </tbody>
            </table>
          </CollapsiblePanel>

          <CollapsiblePanel
            v-if="remainingPrices.length"
            variant="subtle"
            title="其他已保存报价"
            :summary="remainingPrices.length + ' 项（带时长缓存 / 分档 / 其他币种按原样保留）'"
          >
            <table class="mini-price-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>金额</th>
                  <th>单位</th>
                  <th>条件</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in remainingPrices" :key="priceId(p.key)">
                  <td>{{ priceKindLabels[p.key.kind] ?? p.key.kind }}</td>
                  <td>{{ p.amount.value ?? "未知" }} {{ p.key.currency }}</td>
                  <td>{{ p.key.unit }}</td>
                  <td>
                    {{
                      [p.key.tier, p.key.durationSeconds ? p.key.durationSeconds + " 秒" : null]
                        .filter(Boolean)
                        .join(" · ") || "默认"
                    }}
                  </td>
                </tr>
              </tbody>
            </table>
          </CollapsiblePanel>
        </section>
      </template>
    </fieldset>

    <RateCardEditor
      v-if="tab === 'prices'"
      :value="currentCard"
      :currency="currency"
      :context="context"
      :scope="{
        providerId: catalog.providerId,
        offeringId: catalog.offeringId,
        protocol: catalog.protocol,
        operation: entry.operation,
        upstreamModelId: entry.selection.modelId,
        planKey: planKey ?? entry.ratePlanKey,
      }"
      :readonly="locked || busy"
      :resettable="!!own.rateCard || card !== undefined"
      @change="card = $event"
    />

    <p v-if="error" role="alert" tabindex="-1" class="form-message">
      {{ error.message }}
      <span v-for="(f, fi) in error.fields" :key="fi"> {{ f.path }} · {{ f.message }}</span>
    </p>

    <p v-if="stale && dirty" role="status" class="stale-banner">
      <span>配置已在别处更新。</span>
      <button
        type="button"
        class="outline-action compact-btn"
        @click="
          baseline = snapshot.settingsRevision;
          packRevision = snapshot.pack.active;
        "
      >
        核对最新值并保留草稿
      </button>
    </p>

    <p v-if="locked" class="setting-hint">
      {{ entry.actions.edit.state === "disabled" ? entry.actions.edit.reason : "当前范围只读" }}
    </p>

    <pre v-if="preview" class="request-preview-box" aria-label="请求预览">{{
      JSON.stringify(preview, null, 2)
    }}</pre>

    <footer class="editor-sticky-footer">
      <div class="footer-status">
        <span v-if="dirtyCount" class="dirty-counter">已更改 {{ dirtyCount }} 项</span>
        <span v-else-if="message" role="status" class="saved-notice">{{ message }}</span>
        <span v-else class="clean-notice">当前无未保存更改</span>
      </div>
      <div class="footer-actions">
        <button
          v-if="entry.operation === 'chat'"
          type="button"
          class="outline-action"
          :disabled="busy || stale || entry.actions.preview.state !== 'enabled'"
          @click="previewDraft"
        >
          预览请求
        </button>
        <button
          v-if="entry.operation === 'chat'"
          type="button"
          class="outline-action"
          :disabled="busy || stale || dirty || entry.actions.select.state !== 'enabled'"
          @click="chooseTest"
        >
          用于测试对话
        </button>
        <button v-if="isSelected" type="button" class="outline-action" @click="emit('chat')">
          前往测试对话 <AppIcon name="arrow-right" :size="14" />
        </button>
        <button type="button" class="outline-action" :disabled="!dirty || busy" @click="discard">
          放弃草稿
        </button>
        <button
          type="button"
          class="primary-action"
          :disabled="!dirty || busy || stale || locked"
          @click="save"
        >
          保存配置
        </button>
      </div>
    </footer>

    <FormDialog v-if="leaveOpen" title="离开前保存模型配置？" @close="closeDecision(false)">
      <p>{{ entry.displayName }} 有 {{ dirtyCount }} 项未保存的修改。</p>
      <footer>
        <button @click="closeDecision(false)">继续编辑</button>
        <button
          @click="
            discard();
            closeDecision(true);
          "
        >
          放弃修改
        </button>
        <button
          class="primary-action"
          :disabled="busy || locked || stale"
          @click="
            async () => {
              const ok = await save();
              closeDecision(ok);
            }
          "
        >
          保存并离开
        </button>
      </footer>
    </FormDialog>

    <FormDialog v-if="publicTest" title="选择具体测试账号" @close="publicTest = false">
      <p>使用取样账号 {{ catalog.accountDisplayName }} 的协议和参数进行测试。</p>
      <footer>
        <button @click="publicTest = false">取消</button>
        <button
          class="primary-action"
          @click="
            emit('pickAccount');
            publicTest = false;
          "
        >
          进入该账号配置
        </button>
      </footer>
    </FormDialog>
  </section>
</template>
