<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import AppIcon from "./AppIcon.vue";
import type { IconName } from "./icons";

export interface DropdownMenuItem {
  id: string;
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}

const props = withDefaults(
  defineProps<{
    items: readonly DropdownMenuItem[];
    align?: "left" | "right";
    ariaLabel?: string;
    disabled?: boolean;
  }>(),
  {
    align: "right",
    ariaLabel: "更多操作",
    disabled: false,
  },
);

const emit = defineEmits<{ select: [id: string] }>();

const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const menuRef = ref<HTMLElement>();
const open = ref(false);
const openAbove = ref(false);
const activeIndex = ref(0);
const menuId = useId();

function firstEnabledIndex() {
  return props.items.findIndex((item) => !item.disabled);
}

function updatePlacement() {
  if (typeof window === "undefined" || !trigger.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const estimatedHeight = Math.min(260, props.items.length * 34 + 12);
  const spaceBelow = window.innerHeight - rect.bottom;
  openAbove.value = spaceBelow < estimatedHeight && rect.top > spaceBelow;
}

watch(open, async (isOpen) => {
  if (!isOpen) return;
  updatePlacement();
  activeIndex.value = firstEnabledIndex();
  await nextTick();
  focusActiveItem();
});

watch(
  () => props.disabled,
  (isDisabled) => {
    if (isDisabled) open.value = false;
  },
);

function focusActiveItem() {
  const buttons = menuRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
  buttons?.[activeIndex.value]?.focus();
}

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
}

function close(restoreFocus = false) {
  if (!open.value) return;
  open.value = false;
  if (restoreFocus) void nextTick(() => trigger.value?.focus());
}

function choose(item: DropdownMenuItem) {
  if (item.disabled) return;
  open.value = false;
  emit("select", item.id);
  void nextTick(() => trigger.value?.focus());
}

function move(delta: number) {
  const list = props.items;
  if (!list.length) return;
  let index = activeIndex.value;
  for (let step = 0; step < list.length; step++) {
    index = (index + delta + list.length) % list.length;
    if (!list[index]?.disabled) {
      activeIndex.value = index;
      focusActiveItem();
      return;
    }
  }
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (props.disabled) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    open.value = true;
  } else if (event.key === "Escape" && open.value) {
    event.preventDefault();
    close(true);
  }
}

function onMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    close(true);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
  } else if (event.key === "Home") {
    event.preventDefault();
    const idx = firstEnabledIndex();
    if (idx >= 0) {
      activeIndex.value = idx;
      focusActiveItem();
    }
  } else if (event.key === "End") {
    event.preventDefault();
    for (let i = props.items.length - 1; i >= 0; i--) {
      if (!props.items[i]?.disabled) {
        activeIndex.value = i;
        focusActiveItem();
        break;
      }
    }
  } else if (event.key === "Tab") {
    close(false);
  }
}

function onDocumentPointerDown(event: PointerEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) close(false);
}

onMounted(() => document.addEventListener("pointerdown", onDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocumentPointerDown));
</script>

<template>
  <div ref="root" class="dropdown-menu" :class="{ 'is-open': open }">
    <slot
      name="trigger"
      :open="open"
      :toggle="toggle"
      :menu-id="menuId"
      :on-keydown="onTriggerKeydown"
    >
      <button
        ref="trigger"
        type="button"
        class="icon-action-btn dropdown-trigger"
        :aria-label="ariaLabel"
        :title="ariaLabel"
        :disabled="disabled"
        aria-haspopup="menu"
        :aria-expanded="open"
        :aria-controls="menuId"
        @click="toggle"
        @keydown="onTriggerKeydown"
      >
        <AppIcon name="more" :size="15" />
      </button>
    </slot>

    <div
      v-if="open"
      :id="menuId"
      ref="menuRef"
      role="menu"
      class="dropdown-popover"
      :class="[`align-${align}`, { 'is-above': openAbove }]"
      @keydown="onMenuKeydown"
    >
      <button
        v-for="(item, index) in items"
        :key="item.id"
        type="button"
        role="menuitem"
        class="dropdown-item"
        :class="{ 'is-danger': item.danger, 'is-active': index === activeIndex }"
        :disabled="item.disabled"
        :title="item.title"
        @mouseenter="activeIndex = index"
        @click="choose(item)"
      >
        <AppIcon v-if="item.icon" :name="item.icon" :size="14" class="dropdown-item-icon" />
        <span>{{ item.label }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.dropdown-menu {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.dropdown-popover {
  position: absolute;
  z-index: 50;
  top: calc(100% + 4px);
  min-width: 152px;
  padding: 4px;
  border: 1px solid var(--border, #dde3ec);
  border-radius: var(--radius-md, 8px);
  background: var(--surface, #ffffff);
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12);
  display: grid;
  gap: 2px;
}

.dropdown-popover.align-right {
  right: 0;
}

.dropdown-popover.align-left {
  left: 0;
}

.dropdown-popover.is-above {
  top: auto;
  bottom: calc(100% + 4px);
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  color: var(--text-primary, #172033);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
}

.dropdown-item:hover:not(:disabled),
.dropdown-item:focus-visible:not(:disabled),
.dropdown-item.is-active:not(:disabled) {
  background: var(--surface-subtle, #f7f9fc);
  outline: none;
}

.dropdown-item.is-danger {
  color: #dc2626;
}

.dropdown-item.is-danger:hover:not(:disabled),
.dropdown-item.is-danger:focus-visible:not(:disabled),
.dropdown-item.is-danger.is-active:not(:disabled) {
  background: #fef2f2;
  color: #b91c1c;
}

.dropdown-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.dropdown-item-icon {
  flex: 0 0 auto;
}
</style>
