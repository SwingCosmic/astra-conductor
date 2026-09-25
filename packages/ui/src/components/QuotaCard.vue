<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import type { PublicAccount, PublicUsage, UsageExtra, UsageQuota } from "../models";
import {
  extraLabel,
  groupLabel,
  planLabel,
  providerPresentation,
  quotaLabel,
} from "../presentation";

const props = defineProps<{ account: PublicAccount; usage: PublicUsage | null; busy: boolean }>();
defineEmits<{ refresh: []; toggle: [] }>();

type Tone = "unknown" | "ok" | "warning" | "danger" | "critical";
const collapsed = reactive(new Set<string>());
const selectedExtra = ref<UsageExtra | null>(null);
const presentation = computed(() => providerPresentation(props.account.provider));
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

function toggleGroup(key: string): void {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
}
</script>

<template>
  <article
    class="quota-card"
    :class="[`card-tone-${cardTone}`, { 'is-disabled': !account.enabled }]"
  >
    <header class="quota-card-head">
      <span class="provider-mark" aria-hidden="true">{{ presentation.mark }}</span>
      <div class="provider-identity">
        <h2>{{ presentation.name }}</h2>
        <p>
          <span>{{ usage ? planLabel(account.provider, usage.plan) : "未刷新" }}</span>
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
          v-if="groupLabel(account.provider, group)"
          class="group-toggle"
          type="button"
          :aria-expanded="!collapsed.has(group.key)"
          @click="toggleGroup(group.key)"
        >
          <span aria-hidden="true">{{ collapsed.has(group.key) ? "›" : "⌄" }}</span>
          <span>{{ groupLabel(account.provider, group) }}</span>
          <span v-if="collapsed.has(group.key)" class="group-summary">
            {{
              Math.min(...group.quotas.map((quota) => quota.remainingPercentage ?? 100)).toFixed(0)
            }}%
          </span>
        </button>
        <div v-show="!collapsed.has(group.key)" class="quota-list">
          <div v-for="quota in group.quotas" :key="quota.key" class="quota-window">
            <h3>{{ quotaLabel(account.provider, quota) }}</h3>
            <div class="progress-row">
              <div
                class="progress-track"
                role="meter"
                :aria-label="quotaLabel(account.provider, quota)"
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
          <span>↻&nbsp; {{ extraLabel(account.provider, extra) }} {{ extra.value }}</span>
          <span class="extra-detail">查看详情&nbsp; ›</span>
        </button>
      </div>

      <p v-if="!account.enabled" class="disabled-note">ⓘ 停用后不再自动刷新和通知</p>
      <footer class="quota-card-foot">
        <span>更新于：{{ new Date(usage.fetchedAt).toLocaleString("zh-CN") }}</span>
        <button :disabled="busy || !account.enabled" @click="$emit('refresh')">↻&nbsp; 刷新</button>
      </footer>
    </template>
    <p v-else class="empty-usage">尚无用量数据</p>
    <div v-if="selectedExtra" class="modal-backdrop" @click.self="selectedExtra = null">
      <section class="detail-modal" role="dialog" aria-modal="true" aria-label="重置额度详情">
        <header>
          <div>
            <h2>{{ extraLabel(account.provider, selectedExtra) }}</h2>
            <p>{{ presentation.name }}</p>
          </div>
          <button class="icon-button" aria-label="关闭" @click="selectedExtra = null">×</button>
        </header>
        <div class="credit-summary">
          <span>当前可用次数</span><strong>{{ selectedExtra.value }}</strong>
        </div>
        <p class="detail-note">
          当前上游只返回可用总数，未提供每次额度的重置类型与过期时间，因此这里不会生成或合并占位记录。
        </p>
        <footer>
          <button @click="selectedExtra = null">关闭</button>
          <a href="https://chatgpt.com/" target="_blank" rel="noreferrer">前往官网</a>
        </footer>
      </section>
    </div>
  </article>
</template>
