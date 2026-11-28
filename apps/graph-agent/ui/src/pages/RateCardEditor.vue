<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import {
  AppIcon,
  CollapsiblePanel,
  ConfigField,
  RichSelect,
  type RichSelectOption,
} from "@astra-conductor/shared-ui";
import type {
  BillingEstimate,
  BillingWorkload,
  ChargeLine,
  CommandContext,
  RateCard,
  RateRule,
} from "@astra-conductor/contract/graph-agent";
import { modelMeterLabels as moneyMeters } from "@astra-conductor/contract/graph-agent";
import { graphServiceKey } from "../services/graph-agent-service";
import {
  defaultMeterForOperation,
  defaultUnitForMeter,
  estimateStatusLabels,
} from "./catalog-labels";

const props = defineProps<{
  value: RateCard | null;
  context: CommandContext;
  scope: NonNullable<RateCard["scope"]>;
  readonly: boolean;
  currency: string;
  resettable: boolean;
}>();
const emit = defineEmits<{ change: [card: RateCard | null] }>();
const service = inject(graphServiceKey)!;

const uid = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const card = ref<RateCard | null>(null);
const result = ref<BillingEstimate | null>(null),
  error = ref(""),
  busy = ref(false);
const quantities = ref<Record<string, number>>({}),
  remaining = ref<Record<string, number>>({}),
  when = ref(""),
  quality = ref(""),
  region = ref("");
const days = ["一", "二", "三", "四", "五", "六", "日"];
const prior = ref<Record<string, number>>({}),
  itemQuantities = ref<Record<string, string>>({});
const holidays = ref<Record<string, string>>({});

const calendarIds = computed(() => [
  ...new Set(
    card.value?.overrides.flatMap((r) =>
      r.mode === "replace" && r.when.excludeCalendarRef ? [r.when.excludeCalendarRef] : [],
    ) ?? [],
  ),
]);

const hasTimeRules = computed(
  () =>
    card.value?.overrides.some(
      (r) =>
        r.mode === "replace" &&
        (!!r.when.windows?.length ||
          !!r.when.weekdays?.length ||
          !!r.when.timeZone ||
          !!r.when.excludeCalendarRef),
    ) ?? false,
);

const hasQualityOrRegionRules = computed(
  () =>
    card.value?.overrides.some(
      (r) => r.mode === "replace" && (!!r.when.quality || !!r.when.region),
    ) ?? false,
);

const accessOptions: RichSelectOption[] = [
  { value: "", label: "未指定" },
  { value: "api", label: "API 按量" },
  { value: "subscription", label: "订阅" },
];
const roundingModeOptions: RichSelectOption[] = [
  { value: "exact", label: "精确计量" },
  { value: "ceil", label: "向上取整" },
];
const roundingScopeOptions: RichSelectOption[] = [
  { value: "total", label: "合并用量" },
  { value: "per-item", label: "逐项取整" },
];
const applyToOptions: RichSelectOption[] = [
  { value: "single", label: "本次用量" },
  { value: "accountBillingCycle", label: "账号账期累计" },
];
const billingPeriodOptions: RichSelectOption[] = [
  { value: "month", label: "每月" },
  { value: "year", label: "每年" },
];
const resetPeriodOptions: RichSelectOption[] = [
  { value: "", label: "未指定" },
  { value: "account-billing-month", label: "按账号账期月重置" },
];
const overagePolicyOptions: RichSelectOption[] = [
  { value: "block", label: "阻止" },
  { value: "charge", label: "按量计费" },
];
const chargeLineOptions = computed<RichSelectOption[]>(() =>
  (card.value?.chargeLines ?? []).map((l) => ({
    value: l.lineId,
    label: moneyMeters[l.meter] ?? l.meter,
  })),
);

const isSubscription = computed(
  () =>
    card.value?.scope?.access === "subscription" ||
    !!card.value?.subscriptionFee ||
    (card.value?.entitlements.length ?? 0) > 0,
);

function toggleDay(rule: Extract<RateRule, { mode: "replace" }>, day: number) {
  const selected = rule.when.weekdays ?? [];
  const next = selected.includes(day) ? selected.filter((n) => n !== day) : [...selected, day];
  rule.when.weekdays = next.length ? next : undefined;
  publish();
}

function datedCalendars() {
  const out: NonNullable<BillingWorkload["calendars"]> = {};
  for (const id of calendarIds.value) {
    const dates = holidays.value[id]?.trim();
    if (!dates) continue;
    const years: Record<string, string[]> = {};
    for (const date of dates.split(/[\s,，]+/)) {
      if (/^\d{4}$/.test(date)) {
        years[date] ??= [];
        continue;
      }
      if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw Error("日历日期请使用 YYYY-MM-DD");
      (years[date.slice(0, 4)] ??= []).push(date);
    }
    out[id] = years;
  }
  return out;
}

let trial = 0;
watch(
  [quantities, remaining, prior, itemQuantities, holidays, when, quality, region],
  () => {
    trial++;
    result.value = null;
  },
  { deep: true, flush: "sync" },
);
watch(
  () => props.value,
  (v) => {
    card.value = v ? copy(v) : null;
    result.value = null;
    trial++;
  },
  { immediate: true },
);

const meters = computed(() => [
  ...new Set([
    ...(card.value?.chargeLines.map((l) => l.meter) ?? []),
    ...(card.value?.overrides.flatMap((r) =>
      r.mode === "replace" && r.when.meter ? [r.when.meter] : [],
    ) ?? []),
  ]),
]);

function newLine(): ChargeLine {
  const preset = defaultMeterForOperation(props.scope.operation);
  return {
    lineId: "line-" + uid(),
    meter: preset.meter,
    per: { quantity: preset.quantity, unit: preset.unit },
    amount: null,
    rounding: { mode: "exact" },
  };
}

function onMeterChange(line: ChargeLine) {
  const suggested = defaultUnitForMeter(line.meter);
  line.per.quantity = suggested.quantity;
  line.per.unit = suggested.unit;
  publish();
}

function update(fn: (c: RateCard) => void) {
  if (!card.value) return;
  fn(card.value);
  publish();
}

function publish() {
  if (!card.value) return;
  result.value = null;
  const candidate = copy(card.value);
  for (const rule of candidate.overrides) {
    if (rule.mode !== "replace") continue;
    for (const field of ["meter", "region", "quality", "timeZone", "excludeCalendarRef"] as const) {
      if (rule.when[field] === "") delete rule.when[field];
    }
  }
  emit("change", candidate);
}

function dateInput(s?: string | null) {
  if (!s) return "";
  const d = new Date(s);
  return Number.isFinite(d.getTime())
    ? new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    : "";
}

function setTime(field: "effectiveFrom" | "effectiveUntil", s: string) {
  update((c) => {
    if (s) c[field] = new Date(s).toISOString();
    else delete c[field];
  });
}

function initialize() {
  emit("change", {
    rateCardId: "local-" + uid(),
    revision: uid(),
    scope: { ...props.scope, access: "api" },
    currency: props.currency || "USD",
    chargeLines: [newLine()],
    overrides: [],
    entitlements: [],
  });
}

function addRule(mode: "replace" | "graduated") {
  update((c) => {
    const line = c.chargeLines[0];
    if (!line) return;
    c.overrides.push(
      mode === "graduated"
        ? {
            ruleId: "rule-" + uid(),
            mode,
            lineId: line.lineId,
            bands: [{ upToInclusive: null, amount: line.amount }],
          }
        : {
            ruleId: "rule-" + uid(),
            mode,
            when: { meter: line.meter, atLeast: 0 },
            setAmounts: { [line.lineId]: line.amount },
          },
    );
  });
}

function setTarget(rule: Extract<RateRule, { mode: "replace" }>, id: string) {
  rule.setAmounts = { [id]: Object.values(rule.setAmounts)[0] ?? null };
  publish();
}

function number(e: Event) {
  const s = (e.target as HTMLInputElement).value;
  return s === "" ? undefined : Number(s);
}
const val = (e: Event) => (e.target as HTMLInputElement).value;

function removeLine(id: string) {
  update((c) => {
    c.chargeLines = c.chargeLines.filter((l) => l.lineId !== id);
    c.overrides = c.overrides.flatMap((r): RateRule[] => {
      if (r.mode === "graduated") return r.lineId === id ? [] : [r];
      delete r.setAmounts[id];
      return Object.keys(r.setAmounts).length ? [r] : [];
    });
  });
}

function hasExtraRuleFilters(rule: Extract<RateRule, { mode: "replace" }>) {
  return (
    rule.when.above !== undefined ||
    (rule.when.atLeast !== undefined && rule.when.atLeast > 0) ||
    !!rule.when.region ||
    !!rule.when.weekdays?.length ||
    !!rule.when.excludeCalendarRef
  );
}

async function estimate() {
  if (!card.value) return;
  const serial = ++trial;
  busy.value = true;
  error.value = "";
  result.value = null;
  try {
    const workload: BillingWorkload = {
      meters: { ...quantities.value },
      calendars: datedCalendars(),
      remaining: { ...remaining.value },
      usageBefore: { ...prior.value },
      items: Object.fromEntries(
        Object.entries(itemQuantities.value)
          .filter(([, s]) => s.trim())
          .map(([k, s]) => [
            k,
            s
              .trim()
              .split(/[\s,，]+/)
              .map(Number),
          ]),
      ),
      ...(when.value ? { time: new Date(when.value).toISOString() } : {}),
      ...(region.value ? { region: region.value } : {}),
      ...(quality.value ? { quality: quality.value } : {}),
    };
    const r = await service.estimateModelCost({
      ...props.context,
      rateCard: copy(card.value),
      workload,
    });
    if (serial !== trial) return;
    if (!r.ok) throw Error(r.error.message);
    result.value = r.value;
  } catch (e) {
    if (serial === trial) error.value = e instanceof Error ? e.message : "试算失败";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <CollapsiblePanel
    class="rate-card-editor"
    variant="card"
    title="条件价卡与费用试算"
    :summary="
      card
        ? `${card.currency} · ${card.chargeLines.length} 条收费行${card.overrides.length ? ` · ${card.overrides.length} 条规则` : ''}`
        : '支持阶梯、峰谷时段、订阅权益与试算'
    "
  >
    <div class="rate-card-body">
      <div v-if="!card" class="rate-card-empty">
        <p class="setting-hint">
          当前仅使用基础 token
          单价。如需配置按张、按次、峰谷时段、阶梯单价或订阅包含额度，可新建条件价卡。
        </p>
        <button :disabled="readonly" type="button" class="outline-action" @click="initialize">
          <AppIcon name="plus" :size="14" /> 新建条件价卡
        </button>
      </div>

      <template v-else>
        <fieldset class="plain-fields" :disabled="readonly">
          <div class="rate-card-top">
            <div class="editor-two-col rate-card-basics">
              <ConfigField label="接入与计费方式">
                <RichSelect
                  :model-value="card.scope?.access ?? ''"
                  :options="accessOptions"
                  :disabled="readonly"
                  @select="
                    card.scope = {
                      ...props.scope,
                      ...card.scope,
                      access: ($event || undefined) as 'api' | 'subscription' | undefined,
                    };
                    publish();
                  "
                />
              </ConfigField>
              <ConfigField label="价卡币种">
                <input
                  v-model.trim="card.currency"
                  maxlength="3"
                  list="price-currencies"
                  @change="publish"
                />
              </ConfigField>
            </div>
            <button
              v-if="resettable"
              type="button"
              class="link-action"
              @click="emit('change', null)"
            >
              恢复继承
            </button>
          </div>

          <CollapsiblePanel
            class="nested-advanced-box"
            variant="inline"
            title="生效时间与价卡标识"
            :default-open="!!card.effectiveFrom || !!card.effectiveUntil"
            :summary="card.effectiveFrom || card.effectiveUntil ? '已限时' : '长期有效'"
          >
            <div class="nested-advanced-body">
              <div class="editor-two-col">
                <ConfigField label="生效时间">
                  <input
                    type="datetime-local"
                    :value="dateInput(card.effectiveFrom)"
                    @change="setTime('effectiveFrom', val($event))"
                  />
                </ConfigField>
                <ConfigField label="截至时间">
                  <input
                    type="datetime-local"
                    :value="dateInput(card.effectiveUntil)"
                    @change="setTime('effectiveUntil', val($event))"
                  />
                </ConfigField>
              </div>
              <small class="setting-hint">价卡 ID：{{ card.rateCardId }}</small>
            </div>
          </CollapsiblePanel>

          <div class="rate-subsection">
            <div class="section-head-row">
              <h4>收费行</h4>
              <button
                type="button"
                class="outline-action compact-btn"
                @click="update((c) => c.chargeLines.push(newLine()))"
              >
                <AppIcon name="plus" :size="13" /> 添加收费行
              </button>
            </div>

            <div v-for="line in card.chargeLines" :key="line.lineId" class="rate-line-card">
              <div class="rate-row">
                <ConfigField label="计量项">
                  <input
                    v-model.trim="line.meter"
                    list="rate-meter-options"
                    @change="onMeterChange(line)"
                  />
                </ConfigField>
                <ConfigField label="金额" :unit="card.currency || 'USD'">
                  <input
                    :value="line.amount ?? ''"
                    inputmode="decimal"
                    placeholder="未知"
                    @input="
                      line.amount = val($event) || null;
                      publish();
                    "
                  />
                </ConfigField>
                <ConfigField label="计费分母">
                  <input
                    v-model.number="line.per.quantity"
                    type="number"
                    min="1"
                    @change="publish"
                  />
                </ConfigField>
                <ConfigField label="单位">
                  <input v-model.trim="line.per.unit" @change="publish" />
                </ConfigField>
                <button
                  type="button"
                  class="icon-action-btn danger-text"
                  aria-label="移除计量项"
                  title="移除计量项"
                  :disabled="card.chargeLines.length === 1"
                  @click="removeLine(line.lineId)"
                >
                  <AppIcon name="trash" :size="14" />
                </button>
              </div>

              <CollapsiblePanel
                class="nested-advanced-box"
                variant="inline"
                title="取整规则"
                :default-open="line.rounding?.mode === 'ceil'"
                :summary="
                  line.rounding?.mode === 'ceil'
                    ? `向上取整 · 步长 ${line.rounding.step ?? 1}`
                    : '精确计量'
                "
              >
                <div class="rate-row nested-advanced-body">
                  <ConfigField label="取整">
                    <RichSelect
                      :model-value="line.rounding?.mode ?? 'exact'"
                      :options="roundingModeOptions"
                      :disabled="readonly"
                      @select="
                        line.rounding =
                          $event === 'ceil' ? { mode: 'ceil', step: 1 } : { mode: 'exact' };
                        publish();
                      "
                    />
                  </ConfigField>
                  <ConfigField v-if="line.rounding?.mode === 'ceil'" label="取整范围">
                    <RichSelect
                      :model-value="line.rounding.scope ?? 'total'"
                      :options="roundingScopeOptions"
                      :disabled="readonly"
                      @select="
                        line.rounding.scope = $event === 'per-item' ? 'per-item' : 'total';
                        publish();
                      "
                    />
                  </ConfigField>
                  <ConfigField v-if="line.rounding?.mode === 'ceil'" label="取整步长">
                    <input
                      v-model.number="line.rounding.step"
                      type="number"
                      min="1"
                      @change="publish"
                    />
                  </ConfigField>
                </div>
              </CollapsiblePanel>
            </div>
          </div>

          <datalist id="rate-meter-options">
            <option v-for="(name, key) in moneyMeters" :key="key" :value="key">{{ name }}</option>
          </datalist>

          <div class="rate-subsection">
            <div class="section-head-row">
              <h4>条件覆盖与阶梯规则</h4>
              <div class="inline-actions">
                <button
                  type="button"
                  class="outline-action compact-btn"
                  @click="addRule('replace')"
                >
                  <AppIcon name="plus" :size="13" /> 添加条件覆盖
                </button>
                <button
                  type="button"
                  class="outline-action compact-btn"
                  @click="addRule('graduated')"
                >
                  <AppIcon name="plus" :size="13" /> 添加累进阶梯
                </button>
              </div>
            </div>

            <div v-for="(rule, ri) in card.overrides" :key="rule.ruleId" class="rate-rule">
              <div class="section-head-row">
                <strong
                  >{{ rule.mode === "replace" ? "条件覆盖" : "累进阶梯" }} {{ ri + 1 }}</strong
                >
                <button
                  type="button"
                  class="icon-action-btn danger-text"
                  aria-label="移除规则"
                  title="移除规则"
                  @click="update((c) => c.overrides.splice(ri, 1))"
                >
                  <AppIcon name="trash" :size="14" />
                </button>
              </div>

              <template v-if="rule.mode === 'replace'">
                <div class="rate-row">
                  <ConfigField label="目标收费行">
                    <RichSelect
                      :model-value="Object.keys(rule.setAmounts)[0] ?? ''"
                      :options="chargeLineOptions"
                      :disabled="readonly"
                      @select="setTarget(rule, $event)"
                    />
                  </ConfigField>
                  <ConfigField
                    v-for="id in Object.keys(rule.setAmounts)"
                    :key="id"
                    label="覆盖金额"
                    :unit="card.currency || 'USD'"
                  >
                    <input
                      :value="rule.setAmounts[id] ?? ''"
                      inputmode="decimal"
                      placeholder="输入新单价"
                      @input="
                        rule.setAmounts[id] = val($event) || null;
                        publish();
                      "
                    />
                  </ConfigField>
                  <ConfigField label="质量">
                    <input
                      v-model.trim="rule.when.quality"
                      placeholder="例如 HD"
                      @change="publish"
                    />
                  </ConfigField>
                  <ConfigField label="时区">
                    <input
                      v-model.trim="rule.when.timeZone"
                      placeholder="Asia/Shanghai"
                      @change="publish"
                    />
                  </ConfigField>
                </div>

                <div class="time-windows-block">
                  <div v-for="(win, wi) in rule.when.windows" :key="wi" class="window-row">
                    <label>开始 <input v-model="win[0]" type="time" @change="publish" /></label>
                    <label>结束 <input v-model="win[1]" type="time" @change="publish" /></label>
                    <button
                      type="button"
                      class="icon-action-btn danger-text"
                      aria-label="移除时段"
                      title="移除时段"
                      @click="
                        rule.when.windows!.splice(wi, 1);
                        publish();
                      "
                    >
                      <AppIcon name="trash" :size="14" />
                    </button>
                  </div>
                  <button
                    type="button"
                    class="outline-action compact-btn"
                    @click="
                      (rule.when.windows ??= []).push(['09:00', '17:00']);
                      publish();
                    "
                  >
                    <AppIcon name="plus" :size="13" /> 添加时段
                  </button>
                </div>

                <CollapsiblePanel
                  class="nested-advanced-box"
                  variant="inline"
                  title="更多匹配条件（用量阈值、地区、星期、排除日历）"
                  :default-open="hasExtraRuleFilters(rule)"
                >
                  <div class="nested-advanced-body">
                    <div class="rate-row">
                      <ConfigField label="计量条件">
                        <input
                          v-model="rule.when.meter"
                          list="rate-meter-options"
                          @change="publish"
                        />
                      </ConfigField>
                      <ConfigField label="大于">
                        <input
                          :value="rule.when.above"
                          type="number"
                          placeholder="不限"
                          @change="
                            rule.when.above = number($event);
                            publish();
                          "
                        />
                      </ConfigField>
                      <ConfigField label="至少">
                        <input
                          :value="rule.when.atLeast"
                          type="number"
                          placeholder="0"
                          @change="
                            rule.when.atLeast = number($event);
                            publish();
                          "
                        />
                      </ConfigField>
                      <ConfigField label="地区">
                        <input
                          v-model.trim="rule.when.region"
                          placeholder="不限"
                          @change="publish"
                        />
                      </ConfigField>
                      <ConfigField label="排除日历">
                        <input
                          v-model.trim="rule.when.excludeCalendarRef"
                          placeholder="例如 cn-holidays"
                          @change="publish"
                        />
                      </ConfigField>
                    </div>
                    <fieldset class="tag-field">
                      <legend>适用星期</legend>
                      <label v-for="(day, di) in days" :key="day">
                        <input
                          type="checkbox"
                          :checked="rule.when.weekdays?.includes(di + 1)"
                          @change="toggleDay(rule, di + 1)"
                        />
                        周{{ day }}
                      </label>
                    </fieldset>
                  </div>
                </CollapsiblePanel>
              </template>

              <template v-else>
                <div class="editor-two-col">
                  <ConfigField label="阶梯累计范围">
                    <RichSelect
                      :model-value="rule.applyTo ?? 'single'"
                      :options="applyToOptions"
                      :disabled="readonly"
                      @select="
                        rule.applyTo =
                          $event === 'accountBillingCycle' ? 'accountBillingCycle' : undefined;
                        publish();
                      "
                    />
                  </ConfigField>
                  <ConfigField label="阶梯计量项">
                    <RichSelect
                      :model-value="rule.lineId"
                      :options="chargeLineOptions"
                      :disabled="readonly"
                      @select="
                        rule.lineId = $event;
                        publish();
                      "
                    />
                  </ConfigField>
                </div>

                <div v-for="(band, bi) in rule.bands" :key="bi" class="rate-row">
                  <ConfigField label="用量上限（含）">
                    <input
                      :value="band.upToInclusive"
                      placeholder="无上限"
                      type="number"
                      @change="
                        band.upToInclusive = number($event) ?? null;
                        publish();
                      "
                    />
                  </ConfigField>
                  <ConfigField label="本档金额" :unit="card.currency || 'USD'">
                    <input
                      :value="band.amount"
                      inputmode="decimal"
                      @input="
                        band.amount = val($event) || null;
                        publish();
                      "
                    />
                  </ConfigField>
                  <button
                    type="button"
                    class="icon-action-btn danger-text"
                    aria-label="移除档位"
                    title="移除档位"
                    :disabled="rule.bands.length === 1"
                    @click="
                      rule.bands.splice(bi, 1);
                      publish();
                    "
                  >
                    <AppIcon name="trash" :size="14" />
                  </button>
                </div>
                <button
                  type="button"
                  class="outline-action compact-btn"
                  @click="
                    rule.bands.push({ upToInclusive: null, amount: null });
                    publish();
                  "
                >
                  <AppIcon name="plus" :size="13" /> 添加档位
                </button>
              </template>
            </div>
          </div>

          <CollapsiblePanel
            class="nested-advanced-box"
            variant="inline"
            title="订阅固定费与包含权益"
            :default-open="isSubscription"
            :summary="
              card.subscriptionFee || card.entitlements.length
                ? `${card.entitlements.length} 项权益`
                : '按量计费默认关闭'
            "
          >
            <div class="nested-advanced-body">
              <div v-if="card.subscriptionFee" class="rate-row">
                <ConfigField label="订阅固定费" :unit="card.currency || 'USD'">
                  <input
                    v-model.trim="card.subscriptionFee.amount"
                    inputmode="decimal"
                    @input="publish"
                  />
                </ConfigField>
                <ConfigField label="收费周期">
                  <RichSelect
                    :model-value="card.subscriptionFee.period"
                    :options="billingPeriodOptions"
                    :disabled="readonly"
                    @select="
                      card.subscriptionFee.period = $event as 'month' | 'year';
                      publish();
                    "
                  />
                </ConfigField>
                <button
                  type="button"
                  class="icon-action-btn danger-text"
                  aria-label="移除固定费"
                  title="移除固定费"
                  @click="
                    delete card.subscriptionFee;
                    publish();
                  "
                >
                  <AppIcon name="trash" :size="14" />
                </button>
              </div>
              <button
                v-else
                type="button"
                class="outline-action compact-btn"
                @click="
                  card.subscriptionFee = { amount: '0', period: 'month' };
                  publish();
                "
              >
                <AppIcon name="plus" :size="13" /> 添加订阅固定费
              </button>

              <div v-for="(ent, ei) in card.entitlements" :key="ei" class="rate-row">
                <ConfigField label="权益计量项">
                  <input v-model="ent.meter" list="rate-meter-options" @change="publish" />
                </ConfigField>
                <ConfigField label="包含数量">
                  <input
                    v-model.number="ent.included.quantity"
                    type="number"
                    min="0"
                    @change="publish"
                  />
                </ConfigField>
                <ConfigField label="单位">
                  <input v-model="ent.included.unit" @change="publish" />
                </ConfigField>
                <ConfigField label="权益重置">
                  <RichSelect
                    :model-value="ent.reset?.period ?? ''"
                    :options="resetPeriodOptions"
                    :disabled="readonly"
                    @select="
                      ent.reset = $event
                        ? { period: 'account-billing-month', timeZone: 'UTC' }
                        : undefined;
                      publish();
                    "
                  />
                </ConfigField>
                <ConfigField v-if="ent.reset" label="账期时区">
                  <input v-model.trim="ent.reset.timeZone" @change="publish" />
                </ConfigField>
                <ConfigField label="超额处理">
                  <RichSelect
                    :model-value="ent.overagePolicy"
                    :options="overagePolicyOptions"
                    :disabled="readonly"
                    @select="
                      ent.overagePolicy = $event as 'block' | 'charge';
                      publish();
                    "
                  />
                </ConfigField>
                <button
                  type="button"
                  class="icon-action-btn danger-text"
                  aria-label="移除权益"
                  title="移除权益"
                  @click="update((c) => c.entitlements.splice(ei, 1))"
                >
                  <AppIcon name="trash" :size="14" />
                </button>
              </div>
              <button
                type="button"
                class="outline-action compact-btn"
                @click="
                  update((c) =>
                    c.entitlements.push({
                      meter: 'requests',
                      included: { quantity: 1, unit: 'request' },
                      overagePolicy: 'block',
                    }),
                  )
                "
              >
                <AppIcon name="plus" :size="13" /> 添加权益
              </button>
            </div>
          </CollapsiblePanel>
        </fieldset>

        <section class="trial-card">
          <div class="section-head-row">
            <h4>费用试算</h4>
            <button
              type="button"
              class="outline-action compact-btn"
              :disabled="busy"
              @click="estimate"
            >
              试算费用
            </button>
          </div>
          <div class="rate-row workload-fields">
            <ConfigField v-for="m in meters" :key="m" :label="moneyMeters[m] ?? m">
              <input
                :value="quantities[m]"
                type="number"
                min="0"
                :placeholder="m.toLowerCase().includes('token') ? '如 500000' : '如 1'"
                @input="
                  if (number($event) === undefined) delete quantities[m];
                  else quantities[m] = number($event)!;
                  result = null;
                "
              />
            </ConfigField>
            <ConfigField
              v-for="e in card.entitlements"
              :key="'rem-' + e.meter"
              :label="'剩余额度 · ' + (moneyMeters[e.meter] ?? e.meter)"
            >
              <input
                v-model.number="remaining[e.meter]"
                type="number"
                min="0"
                @input="result = null"
              />
            </ConfigField>
            <ConfigField v-for="id in calendarIds" :key="'cal-' + id" :label="id + ' · 排除日期'">
              <textarea
                v-model="holidays[id]"
                rows="2"
                placeholder="YYYY-MM-DD，每行一个日期"
                @input="result = null"
              />
            </ConfigField>
            <ConfigField
              v-for="m in card.chargeLines
                .filter((l) =>
                  card!.overrides.some(
                    (r) =>
                      r.mode === 'graduated' &&
                      r.applyTo === 'accountBillingCycle' &&
                      r.lineId === l.lineId,
                  ),
                )
                .map((l) => l.meter)"
              :key="'prior-' + m"
              :label="'账期已有用量 · ' + (moneyMeters[m] ?? m)"
            >
              <input
                :value="prior[m]"
                type="number"
                min="0"
                @input="
                  number($event) === undefined ? delete prior[m] : (prior[m] = number($event)!)
                "
              />
            </ConfigField>
            <ConfigField
              v-for="m in card.chargeLines
                .filter((l) => l.rounding?.scope === 'per-item')
                .map((l) => l.meter)"
              :key="'item-' + m"
              :label="'逐项用量 · ' + (moneyMeters[m] ?? m)"
            >
              <input v-model="itemQuantities[m]" placeholder="逗号分隔，如 1, 2, 3" />
            </ConfigField>
            <CollapsiblePanel
              class="trial-extra-conditions"
              variant="inline"
              title="试算上下文（时间、质量、地区）"
              :default-open="hasTimeRules || hasQualityOrRegionRules"
            >
              <div class="rate-row trial-extra-body">
                <ConfigField label="计费时间">
                  <input v-model="when" type="datetime-local" @change="result = null" />
                </ConfigField>
                <ConfigField label="质量">
                  <input v-model="quality" placeholder="可选" @input="result = null" />
                </ConfigField>
                <ConfigField label="地区">
                  <input v-model="region" placeholder="可选" @input="result = null" />
                </ConfigField>
              </div>
            </CollapsiblePanel>
          </div>

          <p v-if="error" role="alert" class="form-message">{{ error }}</p>
          <div v-if="result" role="status" class="trial-result">
            <div class="trial-result-badge">
              <strong>
                小计 {{ result.subtotal }} {{ result.currency }} ·
                {{ estimateStatusLabels[result.status] }}
              </strong>
            </div>
            <ul class="trial-result-lines">
              <li v-for="l in result.lines" :key="l.lineId">
                <span>{{ moneyMeters[l.meter] ?? l.meter }} · {{ l.quantity ?? "未知用量" }}</span>
                <strong>{{ l.amount ?? "未知金额" }} {{ result.currency }}</strong>
                <small v-if="l.rules.length">命中 {{ l.rules.join("、") }}</small>
              </li>
            </ul>
            <p v-if="result.missing.length" class="setting-hint">
              缺少 {{ result.missing.join("、") }}
            </p>
          </div>
        </section>
      </template>
    </div>
  </CollapsiblePanel>
</template>
