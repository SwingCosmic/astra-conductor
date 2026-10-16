<script setup lang="ts">
import { computed } from "vue";
import { emptyCompositeRemaining, type PublicCompositeRemaining } from "../models";

const props = defineProps<{ remaining?: PublicCompositeRemaining | null }>();

const state = computed(() => props.remaining ?? emptyCompositeRemaining());
const circumference = 2 * Math.PI * 14;

function ring(
  score: number | null,
  band: PublicCompositeRemaining["sessionBand"],
  caption: string,
) {
  if (score === null) {
    return {
      caption,
      band: "unknown" as const,
      label: "—",
      offset: circumference,
      valueNow: undefined,
    };
  }
  const percent = Math.min(100, Math.max(0, Math.round(score)));
  return {
    caption,
    band,
    label: String(percent),
    offset: circumference * (1 - percent / 100),
    valueNow: percent,
  };
}

const session = computed(() => ring(state.value.sessionScore, state.value.sessionBand, "5h"));
const weekly = computed(() => ring(state.value.weeklyScore, state.value.weeklyBand, "周"));
</script>

<template>
  <div class="usage-score-rings" role="group" aria-label="综合剩余">
    <div v-for="item in [session, weekly]" :key="item.caption" class="usage-score-ring">
      <span class="usage-score-caption">{{ item.caption }}</span>
      <div class="usage-score-dial">
        <svg
          viewBox="0 0 36 36"
          role="meter"
          :aria-label="item.caption"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="item.valueNow"
        >
          <circle class="usage-score-track" cx="18" cy="18" r="14" />
          <circle
            class="usage-score-fill"
            :class="`score-band-${item.band}`"
            cx="18"
            cy="18"
            r="14"
            :stroke-dasharray="circumference"
            :stroke-dashoffset="item.offset"
          />
        </svg>
        <span class="usage-score-value">{{ item.label }}</span>
      </div>
    </div>
  </div>
</template>
