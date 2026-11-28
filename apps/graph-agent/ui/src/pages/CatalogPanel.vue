<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import {
  AppIcon,
  CollapsiblePanel,
  RichSelect,
  type RichSelectOption,
} from "@astra-conductor/shared-ui";
import { modelEndpointDescriptors } from "@astra-conductor/contract/common";
import type {
  CatalogQuote,
  GraphModelSnapshot,
  ModelCatalogView,
  ModelEntryView,
} from "@astra-conductor/contract/graph-agent";
import { graphServiceKey } from "../services/graph-agent-service";
import {
  modalityLabels,
  operationLabels,
  operationShortLabels,
  presenceLabels,
  typeLabels,
} from "./catalog-labels";
import { compareAmount } from "./amounts";
import ModelFactsPanel from "./ModelFactsPanel.vue";

const props = defineProps<{
  snapshot: GraphModelSnapshot;
  catalog: ModelCatalogView;
  scope: "account" | "offering";
  breadcrumb?: string;
  initialModel?: string;
}>();
const emit = defineEmits<{ reload: []; chat: []; pickAccount: [id: string, modelId: string] }>();
const service = inject(graphServiceKey)!;

const search = ref(""),
  operation = ref(""),
  input = ref(""),
  output = ref("");
const currency = ref("USD"),
  meter = ref(""),
  maxPrice = ref(""),
  sort = ref(false);
const entries = computed(() =>
  props.scope === "account" ? props.catalog.entries : props.catalog.publicEntries,
);
const capability = ref(""),
  evidence = ref(""),
  requiredInput = ref(false);
const model = ref(props.initialModel ?? "");
const entry = computed(() => entries.value.find((e) => e.selection.modelId === model.value));
const editor = ref<InstanceType<typeof ModelFactsPanel>>();

async function mayLeave() {
  return (await editor.value?.mayLeave()) ?? true;
}
defineExpose({ mayLeave });

const endpoint = computed(() =>
  modelEndpointDescriptors.find((d) => d.protocol === props.catalog.protocol),
);
const mediaType = ref(endpoint.value?.modelType),
  manualId = ref(""),
  manualName = ref(""),
  error = ref(""),
  busy = ref(false);

watch(endpoint, (ep) => {
  mediaType.value = ep?.modelType;
});

const compatible = computed(() => mediaType.value === endpoint.value?.modelType);
const plan = ref("");
const plans = computed(() => [...new Set(entries.value.flatMap((e) => Object.keys(e.rateCards)))]);
const access = ref(""),
  tier = ref("");

const operationOptions: RichSelectOption[] = [
  { value: "", label: "全部" },
  ...Object.entries(operationLabels).map(([value, label]) => ({ value, label })),
];
const capabilityOptions: RichSelectOption[] = [
  { value: "", label: "全部" },
  { value: "call", label: "可试聊" },
  { value: "tool", label: "工具调用" },
  { value: "structured", label: "结构化输出" },
];
const modalityOptions: RichSelectOption[] = [
  { value: "", label: "全部" },
  ...Object.entries(modalityLabels).map(([value, label]) => ({ value, label })),
];
const evidenceOptions: RichSelectOption[] = [
  { value: "", label: "全部" },
  { value: "manual", label: "手工登记" },
  { value: "remote", label: "远端目录" },
  { value: "missing", label: "已缺失" },
];
const accessOptions: RichSelectOption[] = [
  { value: "", label: "全部" },
  { value: "api", label: "API 按量" },
  { value: "subscription", label: "订阅" },
];
const mediaTypeOptions: RichSelectOption[] = Object.entries(typeLabels).map(([value, label]) => ({
  value,
  label,
}));
const planOptions = computed<RichSelectOption[]>(() => [
  { value: "", label: "当前方案" },
  ...plans.value.map((p) => ({ value: p, label: p })),
]);
const meterOptions = computed<RichSelectOption[]>(() => [
  { value: "", label: "全部" },
  ...priceOptions.value.map(([value, label]) => ({ value, label })),
]);
const tierOptions = computed<RichSelectOption[]>(() => [
  { value: "", label: "选择条件" },
  ...conditions.value.map((key) => ({ value: key, label: key })),
]);

const activeFilterCount = computed(
  () =>
    [
      operation.value,
      input.value,
      output.value,
      capability.value,
      evidence.value,
      plan.value,
      access.value,
      meter.value,
    ].filter(Boolean).length,
);

function clearFilters() {
  operation.value = "";
  input.value = "";
  output.value = "";
  capability.value = "";
  evidence.value = "";
  requiredInput.value = false;
  plan.value = "";
  access.value = "";
  meter.value = "";
  maxPrice.value = "";
  sort.value = false;
}

function planVisible(e: ModelEntryView, q: CatalogQuote) {
  if (plan.value) return q.planKey === plan.value;
  return e.rateCard ? q.planKey === e.ratePlanKey : q.planKey === null;
}
const quoteRows = computed(
  () =>
    new Map(
      entries.value.map((e) => [
        e.selection.modelId,
        e.quotes.filter((q) => planVisible(e, q) && (!access.value || q.access === access.value)),
      ]),
    ),
);
const quotations = computed(() => [...quoteRows.value.values()].flat());
const priceOptions = computed(() => [
  ...new Map(quotations.value.map((q) => [q.meter, q.meterLabel])),
]);
const conditions = computed(() => [
  ...new Set(
    quotations.value
      .filter((q) => q.meter === meter.value && q.currency === currency.value)
      .map((q) => q.condition),
  ),
]);
watch([conditions, meter, currency], () => {
  if (!conditions.value.some((k) => k === tier.value))
    tier.value = conditions.value.length === 1 ? conditions.value[0]! : "";
});
function price(e: ModelEntryView) {
  const rows =
    quoteRows.value
      .get(e.selection.modelId)
      ?.filter(
        (q) =>
          q.meter === meter.value && q.currency === currency.value && q.condition === tier.value,
      ) ?? [];
  return rows.length === 1 ? rows[0]!.amount : null;
}
const filtered = computed(() => {
  let rows = entries.value.filter(
    (e) =>
      (!search.value ||
        (e.displayName + " " + e.selection.modelId)
          .toLowerCase()
          .includes(search.value.toLowerCase())) &&
      (!access.value || !!quoteRows.value.get(e.selection.modelId)?.length) &&
      (!plan.value || !!e.rateCards[plan.value]) &&
      (!evidence.value || e.presence.includes(evidence.value)) &&
      (!capability.value ||
        (capability.value === "call"
          ? e.actions.select.state === "enabled"
          : capability.value === "tool"
            ? e.fields.toolCalling.value === "supported"
            : e.fields.structuredOutput.value === "schema" ||
              e.fields.structuredOutput.value === "json")) &&
      (!operation.value || e.operation === operation.value) &&
      ((!input.value && !output.value) ||
        e.ioProfiles.some(
          (p) =>
            (!input.value ||
              (requiredInput.value
                ? p.requiredInputs
                : [...p.requiredInputs, ...p.optionalInputs]
              ).includes(input.value)) &&
            (!output.value || p.outputs.includes(output.value)),
        )),
  );
  if (meter.value) {
    rows = rows.filter((e) => {
      const v = price(e);
      return (
        v !== null &&
        (!maxPrice.value ||
          (/^\d+(?:\.\d+)?$/.test(String(maxPrice.value)) &&
            compareAmount(v, String(maxPrice.value)) <= 0))
      );
    });
    if (sort.value) rows.sort((a, b) => compareAmount(price(a)!, price(b)!));
  }
  return rows;
});

watch(
  () => props.initialModel,
  (v) => {
    if (v) model.value = v;
  },
);

async function choose(id: string) {
  if (id !== model.value && (await mayLeave())) model.value = id;
}

const frozen = computed(
  () => props.scope === "offering" && props.catalog.refresh.state !== "enabled",
);

function isSavedTest(modelId: string) {
  const v = props.snapshot.savedSelection?.selection;
  return (
    v?.accountId === props.catalog.accountId &&
    v.protocol === props.catalog.protocol &&
    v.modelId === modelId
  );
}

async function mutate(action: "refresh" | "upsert" | "remove") {
  if (busy.value || !props.catalog.accountId || !(await mayLeave())) return;
  const selected = action === "upsert" ? manualId.value.trim() : model.value;
  if (action !== "refresh" && !selected) return;
  busy.value = true;
  error.value = "";
  const s = props.snapshot,
    c = props.catalog;
  const base = {
    instanceId: s.stamp.instanceId,
    contextId: s.backend.contextId,
    expectedBindingRevision: c.bindingRevision,
  };
  try {
    if (action === "refresh" && (!c.protocolFamily || !c.familyBindingRevision))
      throw Error("请先统一协议族配置再刷新目录");
    const r =
      action === "refresh"
        ? await service.refreshCatalog({
            instanceId: base.instanceId,
            contextId: base.contextId,
            accountId: c.accountId,
            protocolFamily: c.protocolFamily!,
            expectedFamilyBindingRevision: c.familyBindingRevision!,
          })
        : await service.editManualModel({
            ...base,
            selection: {
              providerId: c.providerId,
              accountId: c.accountId,
              protocol: c.protocol,
              modelId: selected,
            },
            expectedSettingsRevision: s.settingsRevision,
            change:
              action === "upsert"
                ? {
                    operation: "upsert",
                    displayName: manualName.value.trim() || selected,
                    modelType: mediaType.value,
                    modelOperation: endpoint.value?.operation,
                    ioProfile: endpoint.value?.ioProfile,
                  }
                : { operation: "remove" },
          });
    if (!r.ok) throw Error(r.error.message);
    if (action === "upsert") {
      model.value = selected;
      manualId.value = "";
      manualName.value = "";
    } else if (action === "remove") {
      model.value = "";
    }
    emit("reload");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "操作失败";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="catalog-layout">
    <section class="graph-card catalog-browser">
      <div class="graph-card-header">
        <div class="catalog-title-row">
          <h2>模型</h2>
          <span class="count-pill">{{ filtered.length }}</span>
        </div>
        <button
          class="icon-action-btn"
          aria-label="刷新目录"
          :title="catalog.refreshing ? '读取中…' : '刷新目录'"
          :disabled="busy || catalog.refreshing || catalog.refresh.state !== 'enabled'"
          @click="mutate('refresh')"
        >
          <AppIcon name="refresh" :size="14" :class="{ 'is-spinning': catalog.refreshing }" />
        </button>
      </div>

      <p class="setting-hint catalog-status-line">
        {{ endpoint?.label }} · {{ catalog.accountDisplayName || "无可用取样账号"
        }}<template v-if="catalog.catalog.state === 'ready'">
          · {{ catalog.catalog.stale ? "上次成功" : "更新于" }}
          {{ new Date(catalog.catalog.fetchedAt).toLocaleString() }}</template
        >
      </p>

      <p
        v-if="catalog.lastRefreshError || catalog.catalog.state === 'unavailable' || frozen"
        class="catalog-warning"
      >
        {{
          catalog.lastRefreshError?.message ||
          (catalog.catalog.state === "unavailable"
            ? catalog.catalog.reason
            : "暂无取样账号，供应商默认只读。")
        }}
      </p>

      <div class="catalog-search-box">
        <AppIcon name="search" :size="15" class="catalog-search-icon" />
        <input
          v-model.trim="search"
          type="search"
          aria-label="搜索模型"
          placeholder="搜索模型或上游 ID"
        />
      </div>

      <CollapsiblePanel class="catalog-filters" variant="subtle">
        <template #title>
          <span class="inline-icon">
            <AppIcon name="filter" :size="14" />
            筛选目录
            <span v-if="activeFilterCount" class="count-pill is-brand">{{
              activeFilterCount
            }}</span>
          </span>
        </template>
        <template v-if="activeFilterCount" #actions>
          <button type="button" class="link-action" @click.stop="clearFilters">清除</button>
        </template>
        <div class="catalog-filter-body">
          <div class="filter-grid">
            <RichSelect v-model="operation" size="sm" label="用途" :options="operationOptions" />
            <RichSelect v-model="capability" size="sm" label="能力" :options="capabilityOptions" />
            <RichSelect v-model="input" size="sm" label="输入" :options="modalityOptions" />
            <RichSelect v-model="output" size="sm" label="输出" :options="modalityOptions" />
            <RichSelect v-model="evidence" size="sm" label="模型来源" :options="evidenceOptions" />
          </div>
          <label v-if="input" class="inline-check">
            <input v-model="requiredInput" type="checkbox" />
            <span>仅限必需输入</span>
          </label>

          <CollapsiblePanel class="nested-filter" variant="inline" title="价格与套餐筛选">
            <div class="filter-grid nested-filter-body">
              <RichSelect v-model="plan" size="sm" label="接入方案 / 套餐" :options="planOptions" />
              <RichSelect v-model="access" size="sm" label="接入方式" :options="accessOptions" />
              <RichSelect v-model="meter" size="sm" label="可比较单价" :options="meterOptions" />
              <template v-if="meter">
                <label class="graph-field">币种<input v-model.trim="currency" /></label>
                <RichSelect v-model="tier" size="sm" label="适用档位" :options="tierOptions" />
                <label class="graph-field">
                  价格上限
                  <input v-model="maxPrice" type="number" min="0" step="any" placeholder="不限" />
                </label>
                <label class="inline-check">
                  <input v-model="sort" type="checkbox" />
                  <span>按价格升序</span>
                </label>
              </template>
            </div>
          </CollapsiblePanel>
        </div>
      </CollapsiblePanel>

      <ul v-if="filtered.length" class="catalog-list">
        <li v-for="item in filtered" :key="item.selection.modelId">
          <button
            :aria-pressed="item.selection.modelId === model"
            @click="choose(item.selection.modelId)"
          >
            <span class="catalog-item-head">
              <strong>{{ item.displayName }}</strong>
              <span v-if="isSavedTest(item.selection.modelId)" class="mini-badge is-brand">
                测试中
              </span>
            </span>
            <small v-if="item.displayName !== item.selection.modelId">{{
              item.selection.modelId
            }}</small>
            <span class="catalog-item-meta">
              {{ operationShortLabels[item.operation] ?? operationLabels[item.operation] }} ·
              {{ presenceLabels[item.presence] ?? item.presence }}
            </span>
          </button>
        </li>
      </ul>
      <div v-else class="catalog-empty">
        <p>{{ entries.length ? "没有匹配的模型。" : "此端点尚无模型。" }}</p>
        <button
          v-if="activeFilterCount || search"
          class="link-action"
          @click="
            search = '';
            clearFilters();
          "
        >
          清除筛选条件
        </button>
      </div>

      <CollapsiblePanel v-if="scope === 'account'" class="manual-register" variant="subtle">
        <template #title>
          <span class="inline-icon"><AppIcon name="plus" :size="14" /> 手工登记模型</span>
        </template>
        <form class="manual-register-form" @submit.prevent="mutate('upsert')">
          <label class="graph-field">
            上游模型 ID
            <input v-model.trim="manualId" required placeholder="例如：gpt-4.1-mini" />
          </label>
          <label class="graph-field">
            显示名称
            <input v-model.trim="manualName" placeholder="留空默认使用模型 ID" />
          </label>
          <CollapsiblePanel
            class="nested-filter"
            variant="inline"
            :title="'模型类型（默认 ' + (typeLabels[mediaType ?? ''] ?? '当前端点类型') + '）'"
          >
            <div class="nested-filter-body">
              <RichSelect
                :model-value="mediaType ?? ''"
                label="模型类型"
                :options="mediaTypeOptions"
                @select="mediaType = $event as typeof mediaType"
              />
            </div>
          </CollapsiblePanel>
          <span v-if="!compatible" class="setting-hint">所选类型与当前端点不匹配。</span>
          <button
            class="primary-action compact-btn"
            :disabled="busy || !compatible || !manualId || catalog.register.state !== 'enabled'"
          >
            登记模型
          </button>
        </form>
      </CollapsiblePanel>

      <p v-if="error" class="form-message" role="alert">{{ error }}</p>
    </section>

    <ModelFactsPanel
      v-if="entry"
      ref="editor"
      :key="entry.selection.modelId"
      :entry="entry"
      :snapshot="snapshot"
      :catalog="catalog"
      :scope="scope"
      :breadcrumb="breadcrumb"
      :readonly="frozen"
      :removable="entry.presence.includes('manual') && scope === 'account'"
      :remove-busy="busy"
      @reload="emit('reload')"
      @chat="emit('chat')"
      @pick-account="emit('pickAccount', catalog.accountId, model)"
      @remove-manual="mutate('remove')"
    />
    <div v-else class="graph-card editor-empty-state">
      <AppIcon name="models" :size="28" class="empty-icon" />
      <p>从左侧选择一个模型查看和编辑配置</p>
      <small v-if="scope === 'account'">找不到想要的模型？可在左侧底部「手工登记模型」。</small>
    </div>
  </div>
</template>
