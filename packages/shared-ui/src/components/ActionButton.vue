<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "./AppIcon.vue";
import type { IconName } from "./icons";

const props = withDefaults(
  defineProps<{
    variant?: "primary" | "accent" | "outline" | "ghost" | "icon";
    size?: "sm" | "md" | "lg";
    type?: "button" | "submit" | "reset";
    loading?: boolean;
    loadingLabel?: string;
    icon?: IconName;
    iconSize?: number;
    danger?: boolean;
    disabled?: boolean;
    minWidth?: string;
  }>(),
  {
    variant: "outline",
    size: "md",
    type: "button",
    loading: false,
    iconSize: 14,
    danger: false,
    disabled: false,
  },
);

const variantClass = computed(() => {
  switch (props.variant) {
    case "primary":
      return "primary-action";
    case "accent":
      return "accent-action";
    case "ghost":
      return "ghost-action";
    case "icon":
      return "icon-action-btn";
    default:
      return "outline-action";
  }
});

const sizeClass = computed(() => {
  if (props.variant === "icon") return undefined;
  if (props.size === "sm") return "action-btn--sm";
  if (props.size === "lg") return "action-btn--lg";
  return undefined;
});
</script>

<template>
  <button
    :type="type"
    class="action-button"
    :class="[variantClass, sizeClass, { 'danger-text': danger, 'is-loading': loading }]"
    :style="minWidth ? { minWidth } : undefined"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
  >
    <AppIcon v-if="loading" name="loader" :size="iconSize" class="is-spinning" />
    <AppIcon v-else-if="icon" :name="icon" :size="iconSize" />
    <template v-if="variant !== 'icon'">
      <span v-if="loading && loadingLabel" class="action-button-label">{{ loadingLabel }}</span>
      <span v-else-if="$slots.default" class="action-button-label"><slot /></span>
      <slot v-if="!loading" name="trailing" />
    </template>
  </button>
</template>

<style scoped>
.action-button {
  white-space: nowrap;
}

.action-button-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.action-btn--sm {
  height: var(--control-h-sm, 28px);
  padding: 0 9px;
  font-size: 12px;
}

.action-btn--lg {
  height: var(--control-h-lg, 34px);
  padding: 0 16px;
  font-size: 13.5px;
}
</style>
