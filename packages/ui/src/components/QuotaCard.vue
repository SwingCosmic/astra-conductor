<script setup lang="ts">
import type { PublicAccount, PublicUsage, UsageQuota } from "../models";
defineProps<{ account: PublicAccount; usage: PublicUsage | null; busy: boolean }>();
defineEmits<{ refresh: []; toggle: []; remove: [] }>();
function tone(percent: number | null): "unknown" | "ok" | "low" | "critical" {
  if (percent === null) return "unknown";
  if (percent <= 5) return "critical";
  if (percent <= 20) return "low";
  return "ok";
}
function width(quota: UsageQuota): string {
  return quota.remainingPercentage === null
    ? "0%"
    : `${Math.min(100, Math.max(0, quota.remainingPercentage))}%`;
}
function resetLabel(value: string | null): string | null {
  if (!value) return null;
  const milliseconds = Date.parse(value) - Date.now();
  if (milliseconds <= 0) return "即将重置";
  const hours = Math.ceil(milliseconds / 3_600_000);
  return hours >= 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `${hours} 小时`;
}
const providerNames: Record<string, string> = {
  codex: "Codex",
  glm: "GLM",
  "grok-build": "Grok Build",
  antigravity: "Antigravity",
};
function providerName(provider: string): string {
  return providerNames[provider] ?? provider;
}
const countFormat = new Intl.NumberFormat("en-US");
</script>

<template>
  <article class="card" :class="{ disabled: !account.enabled }">
    <header class="card-head">
      <div>
        <h2>{{ providerName(account.provider) }}</h2>
        <p class="account">{{ account.maskedIdentifier }}</p>
      </div>
      <div class="card-side">
        <span class="plan">{{ usage?.plan ?? "未刷新" }}</span
        ><span class="status">{{ account.enabled ? "已启用" : "已停用" }}</span>
      </div>
    </header>
    <template v-if="usage">
      <section v-for="group in usage.groups" :key="group.key" class="group">
        <h3 v-if="group.title" class="group-title">{{ group.title }}</h3>
        <div v-for="quota in group.quotas" :key="quota.key" class="window">
          <div class="window-head">
            <span>{{ quota.title }}</span
            ><span class="percent" :class="`tone-${tone(quota.remainingPercentage)}`">{{
              quota.unlimited
                ? "无限"
                : quota.remainingPercentage === null
                  ? "无百分比"
                  : `剩余 ${quota.remainingPercentage.toFixed(0)}%`
            }}</span>
          </div>
          <div
            class="bar"
            role="meter"
            :aria-label="quota.title"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="quota.remainingPercentage ?? undefined"
          >
            <div
              class="bar-fill"
              :class="`tone-${tone(quota.remainingPercentage)}`"
              :style="{ width: width(quota) }"
            />
          </div>
          <p v-if="quota.total > 0" class="usage-count">
            已用 {{ countFormat.format(quota.used) }} / {{ countFormat.format(quota.total) }}
          </p>
          <p v-if="resetLabel(quota.resetAt)" class="reset">
            重置：{{ resetLabel(quota.resetAt) }}
          </p>
        </div>
      </section>
      <dl v-if="usage.extras.length" class="extras">
        <div v-for="extra in usage.extras" :key="extra.key" class="extra-row">
          <dt>{{ extra.label }}</dt>
          <dd>{{ extra.value }}</dd>
        </div>
      </dl>
      <p class="updated">更新于 {{ new Date(usage.fetchedAt).toLocaleString() }}</p>
    </template>
    <p v-else class="empty-usage">尚无用量数据</p>
    <footer class="card-actions">
      <button :disabled="busy || !account.enabled" @click="$emit('refresh')">刷新</button
      ><button :disabled="busy" @click="$emit('toggle')">
        {{ account.enabled ? "停用" : "启用" }}</button
      ><button class="danger" :disabled="busy" @click="$emit('remove')">删除</button>
    </footer>
  </article>
</template>
