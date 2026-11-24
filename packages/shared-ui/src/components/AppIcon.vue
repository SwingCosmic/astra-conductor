<script setup lang="ts">
import { computed } from "vue";
import { getIcon, type IconDefinition, type IconName } from "./icons";

const props = withDefaults(
  defineProps<{
    name: IconName;
    size?: number;
    strokeWidth?: number;
  }>(),
  {
    size: 18,
    strokeWidth: 1.75,
  },
);

const def = computed<IconDefinition | undefined>(() => getIcon(props.name));
</script>

<template>
  <svg
    v-if="def"
    class="app-icon"
    :width="size"
    :height="size"
    :viewBox="def.viewBox ?? '0 0 24 24'"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, index) in def.paths" :key="'p' + index" :d="d" />
    <circle
      v-for="(circle, index) in def.circles"
      :key="'c' + index"
      :cx="circle.cx"
      :cy="circle.cy"
      :r="circle.r"
    />
    <rect
      v-for="(rect, index) in def.rects"
      :key="'r' + index"
      :x="rect.x"
      :y="rect.y"
      :width="rect.width"
      :height="rect.height"
      :rx="rect.rx"
    />
    <line
      v-for="(line, index) in def.lines"
      :key="'l' + index"
      :x1="line.x1"
      :y1="line.y1"
      :x2="line.x2"
      :y2="line.y2"
    />
    <polyline v-for="(points, index) in def.polylines" :key="'pl' + index" :points="points" />
  </svg>
</template>

<style scoped>
.app-icon {
  display: inline-block;
  flex: 0 0 auto;
  vertical-align: middle;
}
</style>
