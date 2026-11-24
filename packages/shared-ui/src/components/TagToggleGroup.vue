<script setup lang="ts">
import AppIcon from "./AppIcon.vue";

export interface TagOption {
  value: string;
  label: string;
}

const props = defineProps<{
  values: readonly string[] | null;
  options: readonly TagOption[];
  disabled?: boolean;
}>();

const emit = defineEmits<{ toggle: [value: string] }>();

function isSelected(value: string) {
  return Array.isArray(props.values) && props.values.includes(value);
}
</script>

<template>
  <div class="tag-toggle-group">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="tag-toggle-chip"
      :class="{ 'is-selected': isSelected(option.value) }"
      :aria-pressed="isSelected(option.value)"
      :disabled="disabled"
      @click="emit('toggle', option.value)"
    >
      <AppIcon v-if="isSelected(option.value)" name="check" :size="13" :stroke-width="2.2" />
      <span>{{ option.label }}</span>
    </button>
    <span v-if="values === null" class="tag-state-note">未知</span>
    <span v-else-if="values.length === 0" class="tag-state-note">无</span>
  </div>
</template>

<style scoped>
.tag-toggle-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.tag-toggle-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: var(--control-h-sm, 28px);
  padding: 0 9px;
  border: 1px solid #d4dce7;
  border-radius: var(--radius-sm, 6px);
  background: var(--surface, #ffffff);
  color: #475569;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    border-color 0.14s ease,
    color 0.14s ease;
}

.tag-toggle-chip:hover:not(:disabled) {
  border-color: #94a3b8;
  background: #f8fafc;
}

.tag-toggle-chip.is-selected {
  border-color: color-mix(in srgb, var(--brand-accent) 45%, transparent);
  background: var(--brand-selected);
  color: var(--brand-hover);
  font-weight: 600;
}

.tag-toggle-chip:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.tag-state-note {
  color: var(--text-muted);
  font-size: 12px;
  padding-left: 4px;
}
</style>
