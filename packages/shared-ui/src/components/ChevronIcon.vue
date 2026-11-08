<script setup lang="ts">
// 统一的下拉箭头：固定尺寸 SVG 保证折叠/展开切换时不因字形差异上下漂移。
defineProps<{ collapsed?: boolean }>();
</script>

<template>
  <svg
    class="chevron"
    :class="{ 'is-collapsed': collapsed }"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    aria-hidden="true"
  >
    <path
      d="M4 6l4 4 4-4"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
