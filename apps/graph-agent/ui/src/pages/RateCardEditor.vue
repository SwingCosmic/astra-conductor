<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { ConfigField } from "@astra-conductor/shared-ui";
import type {
  BillingEstimate,
  BillingWorkload,
  ChargeLine,
  CommandContext,
  RateCard,
  RateRule,
} from "@astra-conductor/contract/graph-agent";
import { graphServiceKey } from "../services/graph-agent-service";
import { modelMeterLabels as moneyMeters } from "@astra-conductor/contract/graph-agent";
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
const newLine = (): ChargeLine => ({
  lineId: "line-" + uid(),
  meter: "requests",
  per: { quantity: 1, unit: "request" },
  amount: null,
  rounding: { mode: "exact" },
});
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
    scope: { ...props.scope },
    currency: props.currency,
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
  <details class="rate-card-editor">
    <summary>条件价卡与试算{{ card ? " · " + card.currency : "" }}</summary>
    <button
      v-if="!card"
      :disabled="readonly"
      type="button"
      class="outline-action"
      @click="initialize"
    >
      新建条件价卡
    </button>
    <template v-else
      ><fieldset class="plain-fields" :disabled="readonly">
        <div class="graph-card-header">
          <strong>{{ card.rateCardId }}</strong
          ><button v-if="resettable" type="button" @click="emit('change', null)">恢复继承</button>
        </div>
        <ConfigField label="价卡币种"
          ><input v-model.trim="card.currency" maxlength="3" @change="publish"
        /></ConfigField>
        <div class="rate-row">
          <ConfigField label="生效时间"
            ><input
              type="datetime-local"
              :value="dateInput(card.effectiveFrom)"
              @change="setTime('effectiveFrom', val($event))" /></ConfigField
          ><ConfigField label="截至时间"
            ><input
              type="datetime-local"
              :value="dateInput(card.effectiveUntil)"
              @change="setTime('effectiveUntil', val($event))"
          /></ConfigField>
        </div>
        <ConfigField label="接入与计费方式"
          ><select
            :value="card.scope?.access ?? ''"
            @change="
              card.scope = {
                ...props.scope,
                ...card.scope,
                access: (val($event) || undefined) as 'api' | 'subscription' | undefined,
              };
              publish();
            "
          >
            <option value="">未指定</option>
            <option value="api">API 按量</option>
            <option value="subscription">订阅</option>
          </select></ConfigField
        >
        <h4>收费行</h4>
        <div v-for="line in card.chargeLines" :key="line.lineId" class="rate-row">
          <ConfigField label="计量项"
            ><input v-model.trim="line.meter" list="rate-meter-options" @change="publish"
          /></ConfigField>
          <ConfigField label="计费分母"
            ><input v-model.number="line.per.quantity" type="number" min="1" @change="publish"
          /></ConfigField>
          <ConfigField label="单位"
            ><input v-model.trim="line.per.unit" @change="publish"
          /></ConfigField>
          <ConfigField label="金额"
            ><input
              :value="line.amount ?? ''"
              inputmode="decimal"
              placeholder="未知"
              @input="
                line.amount = val($event) || null;
                publish();
              "
          /></ConfigField>
          <ConfigField label="取整"
            ><select
              :value="line.rounding?.mode ?? 'exact'"
              @change="
                line.rounding =
                  val($event) === 'ceil' ? { mode: 'ceil', step: 1 } : { mode: 'exact' };
                publish();
              "
            >
              <option value="exact">精确计量</option>
              <option value="ceil">向上取整</option>
            </select></ConfigField
          >
          <ConfigField v-if="line.rounding?.mode === 'ceil'" label="取整范围"
            ><select
              :value="line.rounding.scope ?? 'total'"
              @change="
                line.rounding.scope = val($event) === 'per-item' ? 'per-item' : 'total';
                publish();
              "
            >
              <option value="total">合并用量</option>
              <option value="per-item">逐项取整</option>
            </select></ConfigField
          ><ConfigField v-if="line.rounding?.mode === 'ceil'" label="取整步长"
            ><input v-model.number="line.rounding.step" type="number" min="1" @change="publish"
          /></ConfigField>
          <button
            type="button"
            :disabled="card.chargeLines.length === 1"
            @click="removeLine(line.lineId)"
          >
            移除计量项
          </button>
        </div>
        <datalist id="rate-meter-options">
          <option v-for="(name, key) in moneyMeters" :value="key">{{ name }}</option>
        </datalist>
        <div class="graph-actions">
          <button type="button" @click="update((c) => c.chargeLines.push(newLine()))">
            添加收费行</button
          ><button type="button" @click="addRule('replace')">添加条件覆盖</button
          ><button type="button" @click="addRule('graduated')">添加累进阶梯</button>
        </div>
        <div v-for="(rule, ri) in card.overrides" :key="rule.ruleId" class="rate-rule">
          <h4>{{ rule.mode === "replace" ? "条件覆盖" : "累进阶梯" }} {{ ri + 1 }}</h4>
          <template v-if="rule.mode === 'replace'"
            ><div class="rate-row">
              <ConfigField label="计量条件"
                ><input v-model="rule.when.meter" list="rate-meter-options" @change="publish"
              /></ConfigField>
              <ConfigField label="大于"
                ><input
                  :value="rule.when.above"
                  type="number"
                  @change="
                    rule.when.above = number($event);
                    publish();
                  "
              /></ConfigField>
              <ConfigField label="至少"
                ><input
                  :value="rule.when.atLeast"
                  type="number"
                  @change="
                    rule.when.atLeast = number($event);
                    publish();
                  "
              /></ConfigField>
              <ConfigField label="地区"
                ><input v-model.trim="rule.when.region" @change="publish"
              /></ConfigField>
              <ConfigField label="质量"
                ><input v-model.trim="rule.when.quality" @change="publish"
              /></ConfigField>
              <ConfigField label="时区"
                ><input
                  v-model.trim="rule.when.timeZone"
                  placeholder="Asia/Shanghai"
                  @change="publish"
              /></ConfigField>
              <ConfigField label="排除日历"
                ><input v-model.trim="rule.when.excludeCalendarRef" @change="publish"
              /></ConfigField>
              <ConfigField label="目标收费行"
                ><select
                  :value="Object.keys(rule.setAmounts)[0]"
                  @change="setTarget(rule, val($event))"
                >
                  <option v-for="l in card.chargeLines" :value="l.lineId">
                    {{ moneyMeters[l.meter] ?? l.meter }}
                  </option>
                </select></ConfigField
              >
              <ConfigField v-for="id in Object.keys(rule.setAmounts)" label="覆盖金额"
                ><input
                  :value="rule.setAmounts[id] ?? ''"
                  inputmode="decimal"
                  @input="
                    rule.setAmounts[id] = val($event) || null;
                    publish();
                  "
              /></ConfigField>
            </div>
            <fieldset class="tag-field">
              <legend>适用星期</legend>
              <label v-for="(day, di) in days"
                ><input
                  type="checkbox"
                  :checked="rule.when.weekdays?.includes(di + 1)"
                  @change="toggleDay(rule, di + 1)"
                />{{ day }}</label
              >
            </fieldset>
            <div v-for="(win, wi) in rule.when.windows" class="graph-row">
              <label>开始 <input v-model="win[0]" type="time" @change="publish" /></label
              ><label>结束 <input v-model="win[1]" type="time" @change="publish" /></label
              ><button
                type="button"
                @click="
                  rule.when.windows!.splice(wi, 1);
                  publish();
                "
              >
                移除时段
              </button>
            </div>
            <button
              type="button"
              @click="
                (rule.when.windows ??= []).push(['09:00', '17:00']);
                publish();
              "
            >
              添加时段
            </button></template
          >
          <template v-else
            ><ConfigField label="阶梯累计范围"
              ><select
                :value="rule.applyTo ?? 'single'"
                @change="
                  rule.applyTo =
                    val($event) === 'accountBillingCycle' ? 'accountBillingCycle' : undefined;
                  publish();
                "
              >
                <option value="single">本次用量</option>
                <option value="accountBillingCycle">账号账期累计</option>
              </select></ConfigField
            ><ConfigField label="阶梯计量项"
              ><select v-model="rule.lineId" @change="publish">
                <option v-for="l in card.chargeLines" :value="l.lineId">
                  {{ moneyMeters[l.meter] ?? l.meter }}
                </option>
              </select></ConfigField
            >
            <div v-for="(band, bi) in rule.bands" class="rate-row">
              <ConfigField label="用量上限（含）"
                ><input
                  :value="band.upToInclusive"
                  placeholder="无上限"
                  type="number"
                  @change="
                    band.upToInclusive = number($event) ?? null;
                    publish();
                  " /></ConfigField
              ><ConfigField label="本档金额"
                ><input
                  :value="band.amount"
                  inputmode="decimal"
                  @input="
                    band.amount = val($event) || null;
                    publish();
                  " /></ConfigField
              ><button
                type="button"
                :disabled="rule.bands.length === 1"
                @click="
                  rule.bands.splice(bi, 1);
                  publish();
                "
              >
                移除档位
              </button>
            </div>
            <button
              type="button"
              @click="
                rule.bands.push({ upToInclusive: null, amount: null });
                publish();
              "
            >
              添加档位
            </button></template
          >
          <button type="button" @click="update((c) => c.overrides.splice(ri, 1))">移除规则</button>
        </div>
        <h4>订阅权益</h4>
        <div class="rate-row" v-if="card.subscriptionFee">
          <ConfigField label="订阅固定费"
            ><input
              v-model.trim="card.subscriptionFee.amount"
              inputmode="decimal"
              @input="publish" /></ConfigField
          ><ConfigField label="收费周期"
            ><select v-model="card.subscriptionFee.period" @change="publish">
              <option value="month">每月</option>
              <option value="year">每年</option>
            </select></ConfigField
          ><button
            type="button"
            @click="
              delete card.subscriptionFee;
              publish();
            "
          >
            移除固定费
          </button>
        </div>
        <button
          type="button"
          v-else
          @click="
            card.subscriptionFee = { amount: '0', period: 'month' };
            publish();
          "
        >
          添加订阅固定费
        </button>
        <div v-for="(ent, ei) in card.entitlements" class="rate-row">
          <ConfigField label="权益计量项"
            ><input v-model="ent.meter" list="rate-meter-options" @change="publish" /></ConfigField
          ><ConfigField label="包含数量"
            ><input
              v-model.number="ent.included.quantity"
              type="number"
              min="0"
              @change="publish" /></ConfigField
          ><ConfigField label="单位"
            ><input v-model="ent.included.unit" @change="publish" /></ConfigField
          ><ConfigField label="权益重置"
            ><select
              :value="ent.reset?.period ?? ''"
              @change="
                ent.reset = val($event)
                  ? { period: 'account-billing-month', timeZone: 'UTC' }
                  : undefined;
                publish();
              "
            >
              <option value="">未指定</option>
              <option value="account-billing-month">按账号账期月重置</option>
            </select></ConfigField
          ><ConfigField v-if="ent.reset" label="账期时区"
            ><input v-model.trim="ent.reset.timeZone" @change="publish" /></ConfigField
          ><ConfigField label="超额处理"
            ><select v-model="ent.overagePolicy" @change="publish">
              <option value="block">阻止</option>
              <option value="charge">按量计费</option>
            </select></ConfigField
          ><button type="button" @click="update((c) => c.entitlements.splice(ei, 1))">
            移除权益
          </button>
        </div>
        <button
          type="button"
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
          添加权益
        </button>
      </fieldset>
      <h4>费用试算</h4>
      <div class="rate-row workload-fields">
        <ConfigField v-for="m in meters" :label="moneyMeters[m] ?? m"
          ><input
            :value="quantities[m]"
            type="number"
            min="0"
            @input="
              if (number($event) === undefined) delete quantities[m];
              else quantities[m] = number($event)!;
              result = null;
            " /></ConfigField
        ><ConfigField
          v-for="e in card.entitlements"
          :label="'剩余额度 · ' + (moneyMeters[e.meter] ?? e.meter)"
          ><input
            v-model.number="remaining[e.meter]"
            type="number"
            min="0"
            @input="result = null" /></ConfigField
        ><ConfigField v-for="id in calendarIds" :label="id + ' · 排除日期'">
          <textarea
            v-model="holidays[id]"
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
          :label="'账期已有用量 · ' + (moneyMeters[m] ?? m)"
          ><input
            :value="prior[m]"
            type="number"
            min="0"
            @input="number($event) === undefined ? delete prior[m] : (prior[m] = number($event)!)"
        /></ConfigField>
        <ConfigField
          v-for="m in card.chargeLines
            .filter((l) => l.rounding?.scope === 'per-item')
            .map((l) => l.meter)"
          :label="'逐项用量 · ' + (moneyMeters[m] ?? m)"
          ><input v-model="itemQuantities[m]" placeholder="逗号分隔，如 1, 2, 3" /></ConfigField
        ><ConfigField label="计费时间"
          ><input v-model="when" type="datetime-local" @change="result = null" /></ConfigField
        ><ConfigField label="质量"><input v-model="quality" @input="result = null" /></ConfigField
        ><ConfigField label="地区"><input v-model="region" @input="result = null" /></ConfigField>
      </div>
      <button type="button" class="outline-action" :disabled="busy" @click="estimate">
        试算费用
      </button>
      <p v-if="error" role="alert">{{ error }}</p>
      <div v-if="result" role="status">
        <strong
          >小计 {{ result.subtotal }} {{ result.currency }} ·
          {{
            {
              estimated: "估算",
              partial: "部分估算",
              unknown: "未知",
              included: "套餐内",
              blocked: "超出权益",
            }[result.status]
          }}</strong
        >
        <ul>
          <li v-for="l in result.lines" :key="l.lineId">
            {{ moneyMeters[l.meter] ?? l.meter }} · {{ l.quantity ?? "未知用量" }} ·
            {{ l.amount ?? "未知金额" }} {{ result.currency }}
            <small v-if="l.rules.length">命中 {{ l.rules.join("、") }}</small>
          </li>
        </ul>
        <p v-if="result.missing.length">缺少 {{ result.missing.join("、") }}</p>
      </div></template
    >
  </details>
</template>
