<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { modelEndpointDescriptors } from "@astra-conductor/contract/common";
import type {
  CatalogQuote,
  GraphModelSnapshot,
  ModelCatalogView,
  ModelEntryView,
} from "@astra-conductor/contract/graph-agent";
import { graphServiceKey } from "../services/graph-agent-service";
import { modalityLabels, operationLabels, typeLabels } from "./catalog-labels";
import { compareAmount } from "./amounts";
import ModelFactsPanel from "./ModelFactsPanel.vue";
const props = defineProps<{
  snapshot: GraphModelSnapshot;
  catalog: ModelCatalogView;
  scope: "account" | "offering";
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
const compatible = computed(() => mediaType.value === endpoint.value?.modelType);
const plan = ref("");
const plans = computed(() => [...new Set(entries.value.flatMap((e) => Object.keys(e.rateCards)))]);
const access = ref(""),
  tier = ref("");
// Without an explicit plan the effective card covers base prices; with no card at
// all the quoted rows are the flat prices (planKey null).
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
        <h2>模型目录</h2>
        <button
          class="outline-action"
          :disabled="busy || catalog.refreshing || catalog.refresh.state !== 'enabled'"
          @click="mutate('refresh')"
        >
          {{ catalog.refreshing ? "读取中…" : "刷新目录" }}
        </button>
      </div>
      <p class="setting-hint">
        {{ endpoint?.label }} · {{ catalog.accountDisplayName || "无可用取样账号"
        }}<template v-if="catalog.catalog.state === 'ready'">
          · {{ catalog.catalog.stale ? "上次成功" : "更新于" }}
          {{ new Date(catalog.catalog.fetchedAt).toLocaleString() }}</template
        >
      </p>
      <p
        v-if="catalog.lastRefreshError || catalog.catalog.state === 'unavailable' || frozen"
        class="setting-hint"
      >
        {{
          catalog.lastRefreshError?.message ||
          (catalog.catalog.state === "unavailable"
            ? catalog.catalog.reason
            : "暂无取样账号，供应商默认只读。")
        }}
      </p>
      <label class="graph-field"
        >搜索模型<input v-model.trim="search" type="search" placeholder="显示名称或上游 ID"
      /></label>
      <details>
        <summary>筛选目录</summary>
        <div class="graph-grid">
          <label class="graph-field"
            >用途<select v-model="operation">
              <option value="">全部</option>
              <option v-for="(title, id) in operationLabels" :value="id">{{ title }}</option>
            </select></label
          >
          <label class="graph-field"
            >输入<select v-model="input">
              <option value="">全部</option>
              <option v-for="(title, id) in modalityLabels" :value="id">{{ title }}</option>
            </select></label
          >
          <label v-if="input"><input v-model="requiredInput" type="checkbox" />仅限必需输入</label>
          <label class="graph-field"
            >能力<select v-model="capability">
              <option value="">全部</option>
              <option value="call">可试聊</option>
              <option value="tool">工具调用</option>
              <option value="structured">结构化输出</option>
            </select></label
          ><label class="graph-field"
            >模型来源<select v-model="evidence">
              <option value="">全部</option>
              <option value="manual">手工登记</option>
              <option value="remote">远端目录</option>
              <option value="missing">已缺失</option>
            </select></label
          >
          <label class="graph-field"
            >输出<select v-model="output">
              <option value="">全部</option>
              <option v-for="(title, id) in modalityLabels" :value="id">{{ title }}</option>
            </select></label
          >
          <label class="graph-field"
            >接入方案 / 套餐<select v-model="plan">
              <option value="">当前方案</option>
              <option v-for="p in plans" :value="p">{{ p }}</option>
            </select></label
          >
          <label class="graph-field"
            >接入方式<select v-model="access">
              <option value="">全部</option>
              <option value="api">API 按量</option>
              <option value="subscription">订阅</option>
            </select></label
          ><label class="graph-field"
            >可比较单价<select v-model="meter">
              <option value="">全部</option>
              <option v-for="[id, label] in priceOptions" :value="id">{{ label }}</option>
            </select></label
          >
          <template v-if="meter"
            ><label class="graph-field">币种<input v-model.trim="currency" /></label
            ><label class="graph-field"
              >适用档位<select v-model="tier">
                <option value="">选择条件</option>
                <option v-for="key in conditions" :value="key">{{ key }}</option>
              </select></label
            ><label class="graph-field"
              >价格上限<input v-model="maxPrice" type="number" min="0" step="any" /></label
            ><label><input v-model="sort" type="checkbox" />按价格升序</label></template
          >
        </div>
      </details>
      <ul class="catalog-list">
        <li v-for="item in filtered" :key="item.selection.modelId">
          <button
            :aria-pressed="item.selection.modelId === model"
            @click="choose(item.selection.modelId)"
          >
            <strong>{{ item.displayName }}</strong
            ><small v-if="item.displayName !== item.selection.modelId">{{
              item.selection.modelId
            }}</small
            ><span
              >{{ operationLabels[item.operation] }} ·
              {{
                {
                  remote: "目录",
                  manual: "手工",
                  "remote-and-manual": "目录 / 手工",
                  missing: "已缺失",
                }[item.presence]
              }}</span
            >
          </button>
        </li>
      </ul>
      <p v-if="!filtered.length" class="setting-hint">
        {{ entries.length ? "没有匹配的模型。" : "此端点尚无模型。" }}
      </p>
      <details v-if="scope === 'account'">
        <summary>手工登记模型</summary>
        <form class="graph-row" @submit.prevent="mutate('upsert')">
          <label class="graph-field"
            >模型类型<select v-model="mediaType">
              <option v-for="(title, id) in typeLabels" :value="id">{{ title }}</option>
            </select></label
          ><label class="graph-field">上游模型 ID<input v-model.trim="manualId" required /></label
          ><label class="graph-field"
            >显示名称<input v-model.trim="manualName" placeholder="可选" /></label
          ><span v-if="!compatible" class="setting-hint">所选类型与当前端点不匹配。</span
          ><button
            :disabled="busy || !compatible || !manualId || catalog.register.state !== 'enabled'"
          >
            登记模型
          </button>
        </form>
      </details>
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
      :readonly="frozen"
      @reload="emit('reload')"
      @chat="emit('chat')"
      @pick-account="emit('pickAccount', catalog.accountId, model)"
    />
    <p v-else class="select-entry-hint">选择一个模型查看配置。</p>
  </div>
  <button
    v-if="entry?.presence.includes('manual') && scope === 'account'"
    class="outline-action danger-text"
    :disabled="busy"
    @click="mutate('remove')"
  >
    移除当前手工登记
  </button>
</template>
