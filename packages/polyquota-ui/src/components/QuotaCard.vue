<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import ChevronIcon from "./ChevronIcon.vue";
import type {
  PublicAccount,
  PublicUsage,
  UsageExtra,
  UsageExtraItem,
  UsageQuota,
  UsageQuotaGroup,
} from "../models";
import {
  extraLabel,
  extraItemLabel,
  groupLabel,
  planLabel,
  providerPresentation,
  quotaLabel,
} from "../presentation";

const props = defineProps<{ account: PublicAccount; usage: PublicUsage | null; busy: boolean }>();
const emit = defineEmits<{ refresh: []; toggle: []; redeem: [selectionToken: string] }>();

type Tone = "unknown" | "ok" | "warning" | "danger" | "critical";
const collapsed = reactive(new Set<string>());
const selectedExtra = ref<UsageExtra | null>(null);
const presentation = computed(() => providerPresentation(props.account));
const cardTone = computed(() => tone(props.usage?.overallRemainingPercentage ?? null));

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

function resetLabel(value: string | null): string | null {
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

function useResetCredit(item: UsageExtraItem): void {
  if (!item.actionToken) return;
  const label = extraItemLabel(props.account, item.kind);
  if (!window.confirm(`确定使用这张${label}吗？该操作会立即消耗一次重置机会。`)) return;
  selectedExtra.value = null;
  emit("redeem", item.actionToken);
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
        <h2>{{ presentation.name }}</h2>
        <p>
          <span>{{ usage ? planLabel(account, usage.plan) : "未刷新" }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ account.maskedIdentifier }}</span>
        </p>
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
          v-if="groupLabel(account, group)"
          class="group-toggle"
          type="button"
          :aria-expanded="!collapsed.has(group.key)"
          @click="toggleGroup(group.key)"
        >
          <ChevronIcon :collapsed="collapsed.has(group.key)" />
          <span>{{ groupLabel(account, group) }}</span>
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
            <h3>{{ quotaLabel(account, quota) }}</h3>
            <div class="progress-row">
              <div
                class="progress-track"
                role="meter"
                :aria-label="quotaLabel(account, quota)"
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
            <p v-if="resetLabel(quota.resetAt)" class="reset-time">
              重置时间：{{ resetLabel(quota.resetAt) }}
            </p>
          </div>
        </div>
      </section>

      <div v-if="usage.extras.length" class="extra-list">
        <button
          v-for="extra in usage.extras"
          :key="extra.key"
          class="extra-button"
          type="button"
          @click="selectedExtra = extra"
        >
          <span>↻&nbsp; {{ extraLabel(account, extra) }} {{ extra.value }}</span>
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
      <section class="detail-modal" role="dialog" aria-modal="true" aria-label="重置额度详情">
        <header>
          <div>
            <h2>{{ extraLabel(account, selectedExtra) }}</h2>
            <p>{{ presentation.name }}</p>
          </div>
          <button class="icon-button" aria-label="关闭" @click="selectedExtra = null">×</button>
        </header>
        <div class="credit-summary">
          <span>当前可用次数</span><strong>{{ selectedExtra.value }}</strong>
        </div>
        <ul v-if="selectedExtra.items?.length" class="credit-items">
          <li v-for="item in selectedExtra.items" :key="item.key">
            <div class="credit-item-details">
              <span>{{ extraItemLabel(account, item.kind) }}</span>
              <strong>{{
                item.expiresAt ? `有效期至 ${resetLabel(item.expiresAt)}` : "未提供有效期"
              }}</strong>
            </div>
            <button
              v-if="item.actionToken"
              class="credit-redeem-action"
              type="button"
              :disabled="busy || !account.enabled"
              @click="useResetCredit(item)"
            >
              使用
            </button>
          </li>
        </ul>
        <p v-else class="detail-note">上游未提供可展示的逐项明细。</p>
        <p v-if="selectedExtra.items?.some((item) => item.actionToken)" class="detail-note">
          使用后会立即更新本地剩余次数，并重新读取服务商用量。
        </p>
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
  </article>
</template>
