<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import ChevronIcon from "./ChevronIcon.vue";

const props = withDefaults(
  defineProps<{
    open?: boolean;
    defaultOpen?: boolean;
    title?: string;
    summary?: string;
    variant?: "card" | "subtle" | "inline" | "plain";
    disabled?: boolean;
    lazy?: boolean;
    headerClass?: string;
    bodyClass?: string;
  }>(),
  {
    open: undefined,
    defaultOpen: false,
    variant: "card",
    disabled: false,
    lazy: false,
  },
);

const emit = defineEmits<{ "update:open": [value: boolean] }>();

const internalOpen = ref(props.defaultOpen);
const isControlled = computed(() => props.open !== undefined);
const isOpen = computed(() => (isControlled.value ? Boolean(props.open) : internalOpen.value));

const shouldRenderBody = ref(!props.lazy || isOpen.value);
const headerId = useId();
const panelId = useId();
let unmountTimer: ReturnType<typeof setTimeout> | undefined;

function clearUnmountTimer() {
  if (unmountTimer !== undefined) {
    clearTimeout(unmountTimer);
    unmountTimer = undefined;
  }
}

watch(
  isOpen,
  (next) => {
    clearUnmountTimer();
    if (next) {
      shouldRenderBody.value = true;
    } else if (props.lazy) {
      const reduced =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        shouldRenderBody.value = false;
      } else {
        unmountTimer = setTimeout(() => {
          if (!isOpen.value) shouldRenderBody.value = false;
        }, 180);
      }
    }
  },
  { flush: "sync" },
);

onBeforeUnmount(clearUnmountTimer);

function setOpen(next: boolean) {
  if (props.disabled && next !== isOpen.value) return;
  if (!isControlled.value) internalOpen.value = next;
  emit("update:open", next);
}

function toggle() {
  if (props.disabled) return;
  setOpen(!isOpen.value);
}

function onBodyTransitionEnd(event: TransitionEvent) {
  if (event.target !== event.currentTarget) return;
  if (event.propertyName === "grid-template-rows" && props.lazy && !isOpen.value) {
    clearUnmountTimer();
    shouldRenderBody.value = false;
  }
}

defineExpose({ open: isOpen, setOpen, toggle });
</script>

<template>
  <div
    class="collapsible-panel"
    :class="[`collapsible-panel--${variant}`, { 'is-open': isOpen, 'is-disabled': disabled }]"
    data-collapsible
    :data-open="String(isOpen)"
  >
    <div v-if="$slots.header" class="collapsible-custom-header" :class="headerClass">
      <slot
        name="header"
        :open="isOpen"
        :toggle="toggle"
        :panel-id="panelId"
        :header-id="headerId"
      />
    </div>
    <div v-else class="collapsible-header-row" :class="headerClass">
      <button
        :id="headerId"
        type="button"
        class="collapsible-trigger"
        :disabled="disabled"
        :aria-expanded="isOpen"
        :aria-controls="panelId"
        @click="toggle"
      >
        <span class="collapsible-title">
          <slot name="title">{{ title }}</slot>
        </span>
        <span v-if="$slots.summary || summary" class="collapsible-summary">
          <slot name="summary">{{ summary }}</slot>
        </span>
        <ChevronIcon :collapsed="!isOpen" class="collapsible-chevron" />
      </button>
      <div v-if="$slots.actions" class="collapsible-header-actions">
        <slot name="actions" />
      </div>
    </div>

    <div
      :id="panelId"
      role="region"
      class="collapsible-body"
      :aria-labelledby="$slots.header ? undefined : headerId"
      :aria-hidden="!isOpen"
      @transitionend="onBodyTransitionEnd"
    >
      <div class="collapsible-inner" :class="bodyClass">
        <slot v-if="shouldRenderBody" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.collapsible-panel {
  min-width: 0;
}

.collapsible-panel--card {
  border: 1px solid var(--border-subtle, #e8edf4);
  border-radius: var(--radius-md, 8px);
  background: var(--surface-subtle, #f7f9fc);
  overflow: hidden;
}

.collapsible-panel--subtle {
  border: 1px solid var(--border-subtle, #e8edf4);
  border-radius: var(--radius-md, 8px);
  background: var(--surface-subtle, #f7f9fc);
  overflow: hidden;
}

.collapsible-panel--inline {
  border: 1px solid var(--border, #dde3ec);
  border-radius: var(--radius-sm, 6px);
  background: var(--surface, #ffffff);
  overflow: hidden;
}

.collapsible-panel--plain {
  border: 0;
  background: transparent;
}

.collapsible-header-row {
  display: flex;
  align-items: center;
  min-width: 0;
}

.collapsible-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text-primary, #172033);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    color 0.14s ease;
}

.collapsible-panel--card .collapsible-trigger {
  padding: 10px 14px;
  font-size: 13.5px;
  font-weight: 650;
}

.collapsible-panel--subtle .collapsible-trigger {
  padding: 8px 12px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary, #475569);
}

.collapsible-panel--inline .collapsible-trigger {
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted, #64748b);
}

.collapsible-trigger:hover:not(:disabled) {
  background: rgba(15, 23, 42, 0.025);
}

.collapsible-trigger:focus-visible {
  outline: 2px solid var(--brand-accent, #1475f7);
  outline-offset: -2px;
}

.collapsible-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.collapsible-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.collapsible-summary {
  margin-left: auto;
  color: var(--text-muted, #718096);
  font-size: 12px;
  font-weight: 400;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.collapsible-chevron {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--text-muted, #64748b);
  transition: transform 180ms ease;
}

.collapsible-summary + .collapsible-chevron {
  margin-left: 4px;
}

.collapsible-header-actions {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  padding-right: 10px;
}

.collapsible-body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  visibility: hidden;
  transition:
    grid-template-rows 160ms cubic-bezier(0.4, 0, 1, 1),
    opacity 140ms ease,
    visibility 0s linear 160ms;
}

.collapsible-panel.is-open > .collapsible-body {
  grid-template-rows: 1fr;
  opacity: 1;
  visibility: visible;
  transition:
    grid-template-rows 200ms cubic-bezier(0.2, 0, 0, 1),
    opacity 180ms ease,
    visibility 0s linear 0s;
}

.collapsible-inner {
  min-height: 0;
  overflow: hidden;
}

@media (prefers-reduced-motion: reduce) {
  .collapsible-body,
  .collapsible-panel.is-open > .collapsible-body,
  .collapsible-chevron,
  .collapsible-trigger {
    transition-duration: 0ms !important;
    transition-delay: 0ms !important;
  }
}
</style>
