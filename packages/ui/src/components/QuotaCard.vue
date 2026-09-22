<script setup lang="ts">
import type { QuotaWindow, SampleCard } from "../fixtures/sampleCards";

defineProps<{
  card: SampleCard;
}>();

const countFormat = new Intl.NumberFormat("en-US");

function formatCount(value: number): string {
  return countFormat.format(value);
}

function tone(percent: number | null): "unknown" | "ok" | "low" | "critical" {
  if (percent === null) {
    return "unknown";
  }
  if (percent < 5) {
    return "critical";
  }
  if (percent < 20) {
    return "low";
  }
  return "ok";
}

function width(percent: number | null): string {
  if (percent === null) {
    return "0%";
  }
  return `${Math.min(100, Math.max(0, percent))}%`;
}

function meterAttrs(quota: QuotaWindow): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    "aria-label": quota.label,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
  };
  if (quota.remainingPercent !== null) {
    attrs["aria-valuenow"] = quota.remainingPercent;
  }
  return attrs;
}
</script>

<template>
  <article class="card">
    <header class="card-head">
      <div>
        <h2>{{ card.providerName }}</h2>
        <p class="account">{{ card.accountLabel }}</p>
      </div>
      <div class="card-side">
        <span class="plan">{{ card.plan }}</span>
        <span class="status">{{ card.statusLabel }}</span>
      </div>
    </header>

    <section
      v-for="(group, groupIndex) in card.groups"
      :key="group.title ?? `group-${groupIndex}`"
      class="group"
    >
      <h3 v-if="group.title" class="group-title">{{ group.title }}</h3>
      <div v-for="quota in group.windows" :key="quota.label" class="window">
        <div class="window-head">
          <span>{{ quota.label }}</span>
          <span class="percent" :class="`tone-${tone(quota.remainingPercent)}`">
            {{ quota.remainingPercent === null ? "无百分比" : `剩余 ${quota.remainingPercent}%` }}
          </span>
        </div>
        <div class="bar" role="meter" v-bind="meterAttrs(quota)">
          <div
            class="bar-fill"
            :class="`tone-${tone(quota.remainingPercent)}`"
            :style="{ width: width(quota.remainingPercent) }"
          />
        </div>
        <p v-if="quota.used !== undefined && quota.total !== undefined" class="usage-count">
          已用 {{ formatCount(quota.used) }} / {{ formatCount(quota.total) }}
        </p>
        <p v-if="quota.resetLabel" class="reset">重置 {{ quota.resetLabel }}</p>
      </div>
    </section>

    <dl v-if="card.extras.length > 0" class="extras">
      <div v-for="extra in card.extras" :key="extra.label" class="extra-row">
        <dt>{{ extra.label }}</dt>
        <dd>{{ extra.value }}</dd>
      </div>
    </dl>

    <p class="updated">更新于 {{ card.updatedAt }}</p>
  </article>
</template>
