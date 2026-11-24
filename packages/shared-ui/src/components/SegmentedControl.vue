<script setup lang="ts">
export interface SegmentOption {
  value: string;
  label: string;
  disabled?: boolean;
}

defineProps<{
  modelValue: string;
  options: readonly SegmentOption[];
  ariaLabel?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <div class="segmented-control" role="radiogroup" :aria-label="ariaLabel">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      class="segmented-option"
      :class="{ 'is-selected': modelValue === option.value }"
      :aria-checked="modelValue === option.value"
      :disabled="disabled || option.disabled"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.segmented-control {
  display: inline-flex;
  width: 100%;
  height: var(--control-h-md, 32px);
  border: 1px solid #d4dce7;
  border-radius: var(--radius-sm, 6px);
  background: var(--surface-subtle, #f7f9fc);
  overflow: hidden;
}

.segmented-option {
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: #475569;
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    color 0.14s ease;
}

.segmented-option + .segmented-option {
  border-left: 1px solid #d4dce7;
}

.segmented-option:hover:not(:disabled):not(.is-selected) {
  background: #eef2f7;
  color: var(--text-primary);
}

.segmented-option.is-selected {
  background: var(--brand-accent);
  color: #ffffff;
  font-weight: 600;
}

.segmented-option:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
