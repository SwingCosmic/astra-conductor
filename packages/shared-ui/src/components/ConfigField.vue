<script setup lang="ts">
defineProps<{
  label: string;
  source?: string;
  details?: string;
  dirty?: boolean;
  resettable?: boolean;
}>();
const emit = defineEmits<{ reset: [] }>();
</script>
<template>
  <div class="config-field">
    <label
      ><span>{{ label }}</span
      ><slot
    /></label>
    <div v-if="source || resettable || dirty" class="config-field-meta">
      <small :title="details">{{ dirty ? "未保存" : source }}</small>
      <button v-if="resettable" type="button" @click="emit('reset')">恢复继承</button>
    </div>
  </div>
</template>
<style scoped>
.config-field,
.config-field label {
  display: grid;
  align-content: start;
  min-width: 0;
  gap: 5px;
}
.config-field label {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
}
.config-field-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.config-field-meta small {
  color: var(--text-muted);
}
.config-field-meta button {
  background: transparent;
  border: 0;
  padding: 0;
  color: var(--brand-accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.config-field :deep(input),
.config-field :deep(select) {
  width: 100%;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: white;
  color: inherit;
  font: inherit;
  font-weight: 400;
}
</style>
