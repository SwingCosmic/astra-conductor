<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  label: string;
  source?: string;
  details?: string;
  hint?: string;
  unit?: string;
  dirty?: boolean;
  resettable?: boolean;
}>();

const emit = defineEmits<{ reset: [] }>();

const badgeTone = computed(() => {
  if (props.dirty) return "is-dirty";
  if (!props.source) return "is-neutral";
  if (props.source.includes("覆盖")) return "is-override";
  if (props.source.includes("供应商默认")) return "is-offering";
  return "is-neutral";
});
</script>

<template>
  <div class="config-field">
    <div class="config-field-head">
      <label class="config-field-label">
        <span class="config-field-title">{{ label }}</span>
        <span
          v-if="source || dirty"
          class="config-source-badge"
          :class="badgeTone"
          :title="details"
        >
          {{ dirty ? "未保存" : source }}
        </span>
        <span class="config-field-control" :class="{ 'has-unit': !!unit }">
          <slot />
          <span v-if="unit" class="config-field-unit">{{ unit }}</span>
        </span>
      </label>
      <button v-if="resettable" type="button" class="config-reset-link" @click="emit('reset')">
        恢复继承
      </button>
    </div>
    <small v-if="hint" class="config-field-hint">{{ hint }}</small>
  </div>
</template>

<style scoped>
.config-field {
  display: grid;
  align-content: start;
  min-width: 0;
  gap: 5px;
}

.config-field-head {
  position: relative;
  min-width: 0;
}

.config-field-label {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  min-width: 0;
  gap: 5px 8px;
  color: var(--text-primary);
  font-size: 12.5px;
  font-weight: 600;
}

.config-field-title {
  line-height: 1.4;
}

.config-source-badge {
  justify-self: start;
  padding: 1px 6px;
  border-radius: var(--radius-xs, 4px);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.5;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.config-source-badge.is-neutral {
  color: #64748b;
  background: #f1f5f9;
}

.config-source-badge.is-override,
.config-source-badge.is-dirty {
  color: var(--brand-hover);
  background: var(--brand-selected);
}

.config-source-badge.is-offering {
  color: #1d4ed8;
  background: #eff6ff;
}

.config-field-control {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.config-field-unit {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: 12.5px;
  font-weight: 400;
  white-space: nowrap;
}

.config-reset-link {
  position: absolute;
  top: 0;
  right: 0;
  background: transparent;
  border: 0;
  padding: 1px 2px;
  color: var(--brand-accent);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.config-reset-link:hover {
  color: var(--brand-hover);
  text-decoration: underline;
}

.config-field-hint {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.config-field :deep(input:not([type="checkbox"])),
.config-field :deep(select) {
  width: 100%;
  min-width: 0;
  height: var(--control-h-md, 32px);
  padding: 0 10px;
  border: 1px solid #cbd5e1;
  border-radius: var(--radius-sm, 6px);
  background: var(--surface, #ffffff);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  transition: border-color 0.14s ease;
}

.config-field :deep(textarea) {
  width: 100%;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid #cbd5e1;
  border-radius: var(--radius-sm, 6px);
  background: var(--surface, #ffffff);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.5;
  transition: border-color 0.14s ease;
}

.config-field :deep(input:not([type="checkbox"]):focus),
.config-field :deep(select:focus),
.config-field :deep(textarea:focus) {
  border-color: var(--brand-accent);
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand-accent) 12%, transparent);
}

.config-field :deep(input:disabled),
.config-field :deep(select:disabled),
.config-field :deep(textarea:disabled) {
  background: #f8fafc;
  color: var(--text-muted);
}
</style>
