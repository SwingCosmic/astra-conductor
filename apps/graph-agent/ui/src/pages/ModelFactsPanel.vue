<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ConfigField, FormDialog } from "@astra-conductor/shared-ui";
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
  parameterLabels,
  paramKeys,
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
  readonly: boolean;
}>();
const emit = defineEmits<{ reload: []; chat: []; pickAccount: [] }>();
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
const dirty = computed(
  () =>
    Object.keys(edits.value).length > 0 ||
    Object.keys(params.value).length > 0 ||
    Object.keys(prices.value).length > 0 ||
    card.value !== undefined ||
    preset.value !== undefined ||
    planKey.value !== undefined,
);
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
  return source
    ? { account: "当前账号覆盖", offering: "供应商默认", preset: "型号建议" }[source]
    : "协议默认";
}
const groups: { label: string; keys: (keyof ModelFacts)[] }[] = [
  {
    label: "容量与模态",
    keys: [
      "contextWindow",
      "maxInputTokens",
      "maxOutputTokens",
      "operations",
      "inputModalities",
      "outputModalities",
    ],
  },
  {
    label: "工具与输出",
    keys: ["vision", "toolCalling", "parallelToolCalling", "structuredOutput"],
  },
  { label: "推理", keys: ["reasoningMode", "effortLevels", "defaultEffort"] },
  { label: "缓存与约束", keys: ["promptCacheRead", "promptCacheWrite", "unsupportedParameters"] },
];
const groupsShown = computed(() =>
  props.entry.operationId === "chat"
    ? groups
    : [
        {
          label: "操作与模态",
          keys: ["operations", "inputModalities", "outputModalities"] as (keyof ModelFacts)[],
        },
      ],
);
const tokenFields = ["contextWindow", "maxInputTokens", "maxOutputTokens"];
const lists = [
  "operations",
  "inputModalities",
  "outputModalities",
  "effortLevels",
  "unsupportedParameters",
];
function choices(k: keyof ModelFacts): string[] {
  switch (k) {
    case "inputModalities":
    case "outputModalities":
      return Object.keys(modalityLabels);
    case "operations":
      return Object.keys(operationLabels);
    case "effortLevels":
      return ["none", "minimal", "low", "medium", "high", "xhigh"];
    case "unsupportedParameters":
      return Object.keys(parameterLabels);
    case "structuredOutput":
      return ["unknown", "unsupported", "json", "schema"];
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
    return "系列参考";
  if (edits.value[k]?.operation === "clear") return "恢复继承";
  if (Object.hasOwn(own.value.facts, k))
    return props.scope === "account" ? "当前账号覆盖" : "供应商默认";
  if (Object.hasOwn(props.entry.offeringOverrides.facts, k)) return "供应商默认";
  return src
    ? ({ remote: "远端目录", preset: "型号预置", user: "用户覆盖" }[src.kind] ?? src.kind)
    : "未知";
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
function listValues(k: keyof ModelFacts) {
  const a = fact(k);
  return [...new Set([...choices(k), ...(Array.isArray(a) ? a : [])])];
}
function parameter(k: keyof ModelParameters) {
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
const parameterKeys = computed(() =>
  props.entry.parameterTemplate
    ? (Object.keys(props.entry.parameterTemplate.fields) as (keyof ModelParameters)[])
    : (paramKeys[props.entry.operationId] ?? []),
);
const parameterSpec = (k: keyof ModelParameters) => props.entry.parameterTemplate?.fields[k];
function numeric(k: keyof ModelParameters) {
  const spec = parameterSpec(k);
  return spec ? spec.type !== "string" : numericParams.includes(k);
}
function setParam(k: keyof ModelParameters, s: string) {
  params.value[k] = {
    field: k,
    operation: "set",
    value: s === "" ? null : numeric(k) ? Number(s) : s,
  };
}
const priceKinds = ["input", "output"] as const;
function priceKey(kind: "input" | "output"): ModelPriceKey {
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
function priceRow(kind: "input" | "output") {
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
        ? "当前账号覆盖"
        : "供应商默认"
      : props.entry.offeringOverrides.prices.some((p) => priceId(p) === id)
        ? "供应商默认"
        : row?.amount.source?.kind === "preset"
          ? "预置报价"
          : row?.amount.source?.kind === "remote"
            ? "远端报价"
            : "未知",
    resettable,
  };
}
function setPrice(kind: "input" | "output", s: string) {
  const r = priceRow(kind);
  prices.value[r.id] = { operation: "set", key: r.key, amount: s.trim() || null };
}
function resetPrice(kind: "input" | "output") {
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
      operationId: props.entry.operationId,
      protocolRouteId: props.catalog.protocolRouteId,
      upstreamModelId: props.entry.selection.modelId,
      planId: planKey.value ?? props.entry.ratePlanKey,
    },
  };
}
function draft(): SaveModelDraftRequest {
  return {
    ...command(),
    scope: props.scope,
    operationId: props.entry.operationId,
    profileId: props.entry.profileId,
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
      const section = target.closest("details");
      if (section) section.open = true;
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
      operation: props.entry.operationId,
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
    v.protocolRouteId === props.catalog.protocolRouteId &&
    v.modelId === props.entry.selection.modelId
  );
});
</script>
<template>
  <section ref="form" class="graph-card graph-editor">
    <header class="graph-card-header">
      <div>
        <h2>{{ entry.displayName }}</h2>
        <small
          ><template v-if="entry.displayName !== entry.selection.modelId"
            >{{ entry.selection.modelId }} · </template
          >{{ typeLabels[entry.modelType] }} · {{ entry.profileId }}</small
        >
      </div>
      <span v-if="isSelected" class="method-chip">当前测试模型</span>
    </header>
    <div v-for="p in entry.ioProfiles" :key="p.id" class="io-profile">
      {{
        [
          ...p.requiredInputs.map((v) => modalityLabels[v] ?? v),
          ...p.optionalInputs.map((v) => (modalityLabels[v] ?? v) + "（可选）"),
        ].join(" + ")
      }}
      → {{ p.outputs.map((v) => modalityLabels[v] ?? v).join(" + ") }}
    </div>
    <nav class="editor-tabs" aria-label="模型配置页签">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        :aria-pressed="tab === t.id"
        @click="tab = t.id"
      >
        {{ t.label }}
      </button>
    </nav>
    <fieldset class="plain-fields" :disabled="locked || busy">
      <template v-if="tab === 'facts'">
        <ConfigField label="参考型号" :dirty="preset !== undefined"
          ><select
            :value="preset === undefined ? (entry.presetKey ?? '') : (preset ?? '')"
            @change="preset = val($event) || null"
          >
            <option value="">自动匹配</option>
            <option
              v-for="item in snapshot.presets.filter((p) =>
                p.operations.includes(entry.operationId),
              )"
              :value="item.key"
            >
              {{ item.family }} / {{ item.series }} · {{ item.displayName }}
            </option>
          </select></ConfigField
        >
        <details v-for="(g, gi) in groupsShown" :key="g.label" :open="gi === 0">
          <summary>{{ g.label }}</summary>
          <div class="graph-grid editor-fields">
            <div v-for="k in g.keys" :key="k" :data-field="k">
              <template v-if="lists.includes(k)"
                ><fieldset class="tag-field">
                  <legend>{{ factLabels[k] }}</legend>
                  <label v-for="v in listValues(k)" :key="v"
                    ><input
                      type="checkbox"
                      :checked="Array.isArray(fact(k)) && (fact(k) as string[]).includes(v)"
                      @change="pickList(k, v)"
                    />{{ valueLabels[v] ?? v }}</label
                  >
                </fieldset>
                <div class="config-meta">
                  <small :title="factDetails(k)">{{ edits[k] ? "未保存" : fieldSource(k) }}</small
                  ><button type="button" @click="setFact(k, null)">未知</button
                  ><button
                    v-if="Object.hasOwn(own.facts, k) || edits[k]"
                    type="button"
                    @click="edits[k] = { field: k, operation: 'clear' }"
                  >
                    恢复继承
                  </button>
                </div></template
              >
              <ConfigField
                v-else
                :label="factLabels[k]"
                :dirty="!!edits[k]"
                :source="fieldSource(k)"
                :details="factDetails(k)"
                :resettable="Object.hasOwn(own.facts, k) || !!edits[k]"
                @reset="edits[k] = { field: k, operation: 'clear' }"
              >
                <input
                  v-if="tokenFields.includes(k)"
                  type="number"
                  min="1"
                  step="1"
                  :value="fact(k) ?? ''"
                  placeholder="未知"
                  @input="setFact(k, val($event) === '' ? null : Number(val($event)))"
                />
                <select v-else :value="fact(k) ?? ''" @change="setFact(k, val($event) || null)">
                  <option v-if="k === 'defaultEffort'" value="">未知</option>
                  <option v-for="v in choices(k)" :value="v">{{ valueLabels[v] ?? v }}</option>
                </select></ConfigField
              >
            </div>
          </div>
        </details>
      </template>
      <template v-if="tab === 'parameters'"
        ><div class="graph-grid">
          <ConfigField
            v-for="k in parameterKeys"
            :key="k"
            :label="parameterLabels[k] ?? k"
            :data-field="k"
            :dirty="!!params[k]"
            :source="parameterSource(k)"
            :resettable="Object.hasOwn(own.parameters, k) || !!params[k]"
            @reset="params[k] = { field: k, operation: 'clear' }"
            ><select
              v-if="parameterSpec(k)?.choices?.length"
              :value="parameter(k) ?? ''"
              :disabled="entry.fields.unsupportedParameters.value?.includes(k)"
              @change="setParam(k, val($event))"
            >
              <option value="">协议默认</option>
              <option v-for="choice in parameterSpec(k)?.choices" :value="choice">
                {{ choice }}
              </option></select
            ><input
              v-else
              :type="numeric(k) ? 'number' : 'text'"
              :step="parameterSpec(k)?.type === 'integer' ? 1 : 'any'"
              :min="parameterSpec(k)?.minimum"
              :max="parameterSpec(k)?.maximum"
              :value="parameter(k) ?? ''"
              :disabled="entry.fields.unsupportedParameters.value?.includes(k)"
              placeholder="使用默认值"
              @input="setParam(k, val($event))"
          /></ConfigField></div
      ></template>
      <template v-if="tab === 'prices'"
        ><ConfigField label="接入方案 / 套餐"
          ><input
            list="model-rate-plans"
            :value="planKey ?? entry.ratePlanKey ?? 'default'"
            @change="switchPlan($event)"
            placeholder="default" /></ConfigField
        ><datalist id="model-rate-plans">
          <option value="default" />
          <option v-for="id in Object.keys(entry.rateCards ?? {})" :value="id" /></datalist
        ><ConfigField label="基础报价币种"
          ><input v-model.trim="currency" maxlength="3" list="price-currencies" /></ConfigField
        ><datalist id="price-currencies">
          <option>USD</option>
          <option>CNY</option>
          <option>EUR</option>
        </datalist>
        <div class="graph-grid">
          <ConfigField
            v-for="k in priceKinds"
            :data-field="k"
            :key="k"
            :label="(k === 'input' ? '输入单价' : '输出单价') + ' / 每 1,000,000 tokens'"
            :source="priceRow(k).source"
            :dirty="!!priceRow(k).change"
            :resettable="priceRow(k).resettable || !!priceRow(k).change"
            @reset="resetPrice(k)"
            ><input
              inputmode="decimal"
              :value="priceRow(k).value ?? ''"
              placeholder="未知"
              @input="setPrice(k, val($event))"
          /></ConfigField>
        </div>
        <details v-if="entry.referencePrices.length">
          <summary>型号原厂参考价</summary>
          <p v-for="p in entry.referencePrices" :key="priceId(p)">
            {{ p.kind }} · {{ p.amount }} {{ p.currency }} / {{ p.unit }} {{ p.tier }}
          </p>
        </details>
        <details v-if="remainingPrices.length">
          <summary>其他已保存报价（{{ remainingPrices.length }}）</summary>
          <p v-for="p in remainingPrices" :key="priceId(p.key)">
            {{ p.key.kind }} · {{ p.amount.value ?? "未知" }} {{ p.key.currency }} /
            {{ p.key.unit }} {{ p.key.tier }}
            {{ p.key.durationSeconds ? p.key.durationSeconds + " 秒" : "" }}
          </p>
        </details></template
      >
    </fieldset>
    <RateCardEditor
      v-if="tab === 'prices'"
      :value="currentCard"
      :currency="currency"
      :context="context"
      :scope="{
        providerId: catalog.providerId,
        offeringId: catalog.offeringId,
        protocolRouteId: catalog.protocolRouteId,
        operationId: entry.operationId,
        upstreamModelId: entry.selection.modelId,
        planId: planKey ?? entry.ratePlanKey,
      }"
      :readonly="locked || busy"
      :resettable="!!own.rateCard || card !== undefined"
      @change="card = $event"
    />
    <p v-if="error" role="alert" tabindex="-1" class="form-message">
      {{ error.message }} <span v-for="f in error.fields">{{ f.path }} · {{ f.message }}</span>
    </p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="stale && dirty" role="status">
      配置已更新。<button
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
    <footer class="graph-actions">
      <button class="primary-action" :disabled="!dirty || busy || stale || locked" @click="save">
        保存配置</button
      ><button class="outline-action" :disabled="!dirty || busy" @click="discard">放弃草稿</button>
      <button
        v-if="entry.operationId === 'chat'"
        class="outline-action"
        :disabled="busy || stale || entry.actions.preview.state !== 'enabled'"
        @click="previewDraft"
      >
        预览请求
      </button>
      <button
        v-if="entry.operationId === 'chat'"
        class="outline-action"
        :disabled="busy || stale || dirty || entry.actions.select.state !== 'enabled'"
        @click="chooseTest"
      >
        用于测试对话</button
      ><button v-if="isSelected" @click="emit('chat')">前往测试对话</button>
    </footer>
    <pre v-if="preview" aria-label="请求预览">{{ JSON.stringify(preview, null, 2) }}</pre>
    <FormDialog v-if="leaveOpen" title="离开前保存模型配置？" @close="closeDecision(false)"
      ><p>{{ entry.displayName }} 有未保存的修改。</p>
      <footer>
        <button @click="closeDecision(false)">继续编辑</button
        ><button
          @click="
            discard();
            closeDecision(true);
          "
        >
          放弃修改</button
        ><button
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
      </footer></FormDialog
    >
    <FormDialog v-if="publicTest" title="选择具体测试账号" @close="publicTest = false"
      ><p>使用取样账号 {{ catalog.accountDisplayName }} 的协议和参数进行测试。</p>
      <footer>
        <button @click="publicTest = false">取消</button
        ><button
          class="primary-action"
          @click="
            emit('pickAccount');
            publicTest = false;
          "
        >
          进入该账号配置
        </button>
      </footer></FormDialog
    >
  </section>
</template>
