<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import ChevronIcon from "./ChevronIcon.vue";
import type {
  PublicAccount,
  PublicProviderDescriptor,
  PublicUsage,
  ResetCreditRedemption,
  UsageExtra,
  UsageQuota,
  UsageQuotaGroup,
} from "../models";
import {
  accountPresentation,
  extraItemLabel,
  extraLabel,
  groupLabel,
  isUnrecognizedPlan,
  planTagLabel,
  quotaLabel,
  resetCreditTypeLabel,
} from "../presentation";

const props = defineProps<{
  account: PublicAccount;
  usage: PublicUsage | null;
  busy: boolean;
  providers?: readonly PublicProviderDescriptor[];
}>();
const emit = defineEmits<{
  refresh: [];
  toggle: [];
  redeem: [redemption: ResetCreditRedemption];
}>();

type Tone = "unknown" | "ok" | "warning" | "danger" | "critical";
const collapsed = reactive(new Set<string>());
const selectedExtra = ref<UsageExtra | null>(null);
const showResetCredits = ref(false);
const presentation = computed(() => accountPresentation(props.account, props.providers));
const cardTone = computed(() => tone(props.usage?.overallRemainingPercentage ?? null));
const planName = computed(() => planTagLabel(props.usage));
const planUnrecognized = computed(() => isUnrecognizedPlan(props.usage));
const resetCredits = computed(() => props.usage?.resetCredits ?? null);
const resetCreditsCount = computed(() => {
  const credits = resetCredits.value;
  if (!credits) return null;
  return credits.kind === "itemized"
    ? credits.items.length
    : credits.totals.reduce((sum, total) => sum + total.total, 0);
});

function tone(percent: number | null): Tone {
  if (percent === null) return "unknown";
  if (percent <= 5) return "critical";
  if (percent <= 20) return "danger";
  if (percent <= 50) return "warning";
  return "ok";
}

function width(quota: UsageQuota): string {
  return quota.remainingPercentage === null
    ? "0%"
    : `${Math.min(100, Math.max(0, quota.remainingPercentage))}%`;
}

function timeLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function remainingLabel(quota: UsageQuota): string {
  if (quota.unlimited) return "无限";
  if (quota.remainingPercentage === null) return "未提供";
  return `${quota.remainingPercentage.toFixed(0)}% 剩余`;
}

/** 原始量展示：仅当上游真实上报了 used/total（credit/token/请求数），百分比合成刻度不展示。 */
function amountLabel(quota: UsageQuota): string | null {
  if (quota.unlimited || !quota.rawAmounts || quota.total <= 0) return null;
  return `${quota.used.toLocaleString("zh-CN")} / ${quota.total.toLocaleString("zh-CN")}`;
}

function groupRemainingPercentage(group: UsageQuotaGroup): number | null {
  const percentages = group.quotas.flatMap((quota) =>
    quota.remainingPercentage === null ? [] : [quota.remainingPercentage],
  );
  return percentages.length ? Math.min(...percentages) : null;
}

function groupRemainingLabel(group: UsageQuotaGroup): string {
  const percentage = groupRemainingPercentage(group);
  return percentage === null ? "未提供" : `${percentage.toFixed(0)}%`;
}

function toggleGroup(key: string): void {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
}

/** 分体消耗：带对应重置卡 id；兑换协议会重新校验列表。 */
function useResetCreditItem(item: { id: string; type: string }): void {
  const label = resetCreditTypeLabel(item.type);
  if (!window.confirm(`确定使用这张${label}吗？该操作会立即消耗一次重置机会。`)) return;
  showResetCredits.value = false;
  emit("redeem", { kind: "item", itemId: item.id });
}

/** 聚合消耗：按类型消耗，由服务端在该类型的计数中挑选；单桶不标注类型。 */
function useAggregateResetCredit(type: string | null): void {
  const label = type ? resetCreditTypeLabel(type) : "重置额度";
  if (!window.confirm(`确定使用一次${label}吗？该操作会立即消耗一次重置机会。`)) return;
  showResetCredits.value = false;
  emit("redeem", type ? { kind: "aggregate", type } : { kind: "aggregate" });
}
</script>

<template>
  <article
    class="quota-card"
    :class="[`card-tone-${cardTone}`, { 'is-disabled': !account.enabled }]"
  >
    <header class="quota-card-head">
      <span class="provider-mark" aria-hidden="true">
        <img v-if="presentation.icon" :src="presentation.icon" alt="" />
        <template v-else>{{ presentation.mark }}</template>
      </span>
      <div class="provider-identity">
        <div class="provider-title">
          <h2>{{ presentation.name }}</h2>
          <span
            v-if="planName"
            class="plan-tag"
            :class="{ 'is-unrecognized': planUnrecognized }"
            :title="
              planUnrecognized
                ? '未识别的订阅档位：展示为上游原文，聚合评分按默认倍率估算'
                : undefined
            "
          >
            {{ planName }}<span v-if="planUnrecognized" class="plan-tag-mark">?</span>
          </span>
        </div>
        <p>{{ account.maskedIdentifier }}</p>
      </div>
      <label class="switch-field">
        <input
          type="checkbox"
          :checked="account.enabled"
          :disabled="busy"
          @change="$emit('toggle')"
        />
        <span class="switch" aria-hidden="true" />
        <span>{{ account.enabled ? "已启用" : "已停用" }}</span>
      </label>
    </header>

    <template v-if="usage">
      <section v-for="group in usage.groups" :key="group.key" class="quota-group">
        <button
          v-if="groupLabel(group)"
          class="group-toggle"
          type="button"
          :aria-expanded="!collapsed.has(group.key)"
          @click="toggleGroup(group.key)"
        >
          <ChevronIcon :collapsed="collapsed.has(group.key)" />
          <span>{{ groupLabel(group) }}</span>
          <span
            v-if="collapsed.has(group.key)"
            class="group-summary"
            :class="`text-${tone(groupRemainingPercentage(group))}`"
          >
            {{ groupRemainingLabel(group) }}
          </span>
        </button>
        <div v-show="!collapsed.has(group.key)" class="quota-list">
          <div v-for="quota in group.quotas" :key="quota.key" class="quota-window">
            <h3>{{ quotaLabel(quota) }}</h3>
            <div class="progress-row">
              <div
                class="progress-track"
                role="meter"
                :aria-label="quotaLabel(quota)"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="quota.remainingPercentage ?? undefined"
              >
                <div
                  class="progress-fill"
                  :class="`tone-${tone(quota.remainingPercentage)}`"
                  :style="{ width: width(quota) }"
                />
              </div>
              <strong class="remaining" :class="`text-${tone(quota.remainingPercentage)}`">
                {{ remainingLabel(quota) }}
              </strong>
            </div>
            <p v-if="timeLabel(quota.resetAt) || amountLabel(quota)" class="reset-time">
              <span v-if="timeLabel(quota.resetAt)">重置时间：{{ timeLabel(quota.resetAt) }}</span>
              <span v-if="amountLabel(quota)" class="quota-amounts">
                {{ amountLabel(quota) }}
              </span>
            </p>
          </div>
        </div>
      </section>

      <div v-if="resetCredits" class="extra-list">
        <button class="extra-button" type="button" @click="showResetCredits = true">
          <span>↻&nbsp; 重置额度 {{ resetCreditsCount }}</span>
          <span class="extra-detail">查看详情&nbsp; ›</span>
        </button>
      </div>

      <div v-if="usage.extras.length" class="extra-list">
        <button
          v-for="extra in usage.extras"
          :key="extra.key"
          class="extra-button"
          type="button"
          @click="selectedExtra = extra"
        >
          <span>↻&nbsp; {{ extraLabel(extra) }} {{ extra.value }}</span>
          <span class="extra-detail">查看详情&nbsp; ›</span>
        </button>
      </div>

      <p v-if="!account.enabled" class="disabled-note">ⓘ 停用后不再自动刷新和通知</p>
      <footer class="quota-card-foot">
        <span>更新于：{{ new Date(usage.fetchedAt).toLocaleString("zh-CN") }}</span>
        <button :disabled="busy || !account.enabled" @click="$emit('refresh')">↻&nbsp; 刷新</button>
      </footer>
    </template>
    <template v-else>
      <p class="empty-usage">尚无用量数据</p>
      <p v-if="!account.enabled" class="disabled-note">ⓘ 停用后不再自动刷新和通知</p>
      <footer class="quota-card-foot">
        <span>刷新后展示套餐与额度</span>
        <button :disabled="busy || !account.enabled" @click="$emit('refresh')">↻&nbsp; 刷新</button>
      </footer>
    </template>

    <div v-if="selectedExtra" class="modal-backdrop" @click.self="selectedExtra = null">
      <section class="detail-modal" role="dialog" aria-modal="true" aria-label="附加信息详情">
        <header>
          <div>
            <h2>{{ extraLabel(selectedExtra) }}</h2>
            <p>{{ presentation.name }}</p>
          </div>
          <button class="icon-button" aria-label="关闭" @click="selectedExtra = null">×</button>
        </header>
        <div class="credit-summary">
          <span>当前值</span><strong>{{ selectedExtra.value }}</strong>
        </div>
        <ul v-if="selectedExtra.items?.length" class="credit-items">
          <li v-for="item in selectedExtra.items" :key="item.key">
            <div class="credit-item-details">
              <span>{{ extraItemLabel(item.kind) }}</span>
              <strong>{{ item.expiresAt ? `有效期至 ${timeLabel(item.expiresAt)}` : "" }}</strong>
            </div>
          </li>
        </ul>
        <footer>
          <button @click="selectedExtra = null">关闭</button>
          <a
            v-if="presentation.websiteUrl"
            :href="presentation.websiteUrl"
            target="_blank"
            rel="noreferrer"
            >前往官网</a
          >
        </footer>
      </section>
    </div>

    <div
      v-if="showResetCredits && resetCredits"
      class="modal-backdrop"
      @click.self="showResetCredits = false"
    >
      <section class="detail-modal" role="dialog" aria-modal="true" aria-label="重置额度详情">
        <header>
          <div>
            <h2>重置额度</h2>
            <p>{{ presentation.name }}</p>
          </div>
          <button class="icon-button" aria-label="关闭" @click="showResetCredits = false">×</button>
        </header>
        <div class="credit-summary">
          <span>当前可用次数</span><strong>{{ resetCreditsCount }}</strong>
        </div>
        <ul
          v-if="resetCredits.kind === 'itemized' && resetCredits.items.length"
          class="credit-items"
        >
          <li v-for="item in resetCredits.items" :key="item.id">
            <div class="credit-item-details">
              <span>{{ resetCreditTypeLabel(item.type) }}</span>
              <strong>{{ item.expiresAt ? `有效期至 ${timeLabel(item.expiresAt)}` : "" }}</strong>
            </div>
            <button
              class="credit-redeem-action"
              type="button"
              :disabled="busy || !account.enabled"
              @click="useResetCreditItem(item)"
            >
              使用
            </button>
          </li>
        </ul>
        <ul
          v-else-if="resetCredits.kind === 'aggregate' && resetCredits.totals.length"
          class="credit-items"
        >
          <li v-for="total in resetCredits.totals" :key="total.type">
            <div class="credit-item-details">
              <span>{{
                resetCredits.totals.length === 1 ? "可用次数" : resetCreditTypeLabel(total.type)
              }}</span>
              <strong>{{ total.total }} 次</strong>
            </div>
            <button
              class="credit-redeem-action"
              type="button"
              :disabled="busy || !account.enabled || total.total <= 0"
              @click="useAggregateResetCredit(resetCredits.totals.length === 1 ? null : total.type)"
            >
              使用
            </button>
          </li>
        </ul>
        <p v-else class="detail-note">当前没有可用的重置额度。</p>
        <p class="detail-note">使用后会重新读取服务商用量，剩余次数以上游为准。</p>
        <footer>
          <button @click="showResetCredits = false">关闭</button>
          <a
            v-if="presentation.websiteUrl"
            :href="presentation.websiteUrl"
            target="_blank"
            rel="noreferrer"
            >前往官网</a
          >
        </footer>
      </section>
    </div>
  </article>
</template>
