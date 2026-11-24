<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import AppIcon from "./AppIcon.vue";
import ChevronIcon from "./ChevronIcon.vue";
import ProviderMark from "./ProviderMark.vue";
import type { IconName } from "./icons";

export interface RichSelectOption {
  value: string;
  label: string;
  subtitle?: string;
  tag?: string;
  tagTone?: "neutral" | "brand" | "blue" | "green" | "amber";
  icon?: string | null;
  iconName?: IconName;
  showMark?: boolean;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: readonly RichSelectOption[];
    label?: string;
    placeholder?: string;
    disabledPlaceholder?: string;
    searchPlaceholder?: string;
    emptyText?: string;
    searchable?: boolean;
    disabled?: boolean;
  }>(),
  {
    placeholder: "请选择",
    searchPlaceholder: "搜索…",
    emptyText: "没有匹配项",
    searchable: false,
    disabled: false,
  },
);

const emit = defineEmits<{ select: [value: string] }>();

const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const searchInput = ref<HTMLInputElement>();
const open = ref(false);
const openAbove = ref(false);
const query = ref("");
const activeIndex = ref(0);
const listboxId = useId();
const labelId = useId();

function updatePlacement() {
  if (typeof window === "undefined" || !trigger.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  openAbove.value = spaceBelow < 280 && rect.top > spaceBelow;
}

const selected = computed(() => props.options.find((item) => item.value === props.modelValue));
const filtered = computed(() => {
  const term = query.value.trim().toLowerCase();
  if (!term) return props.options;
  return props.options.filter(
    (item) =>
      item.label.toLowerCase().includes(term) ||
      item.subtitle?.toLowerCase().includes(term) ||
      item.tag?.toLowerCase().includes(term),
  );
});

watch(open, async (isOpen) => {
  if (!isOpen) {
    query.value = "";
    return;
  }
  updatePlacement();
  const idx = filtered.value.findIndex((item) => item.value === props.modelValue && !item.disabled);
  activeIndex.value = idx >= 0 ? idx : filtered.value.findIndex((item) => !item.disabled);
  await nextTick();
  if (props.searchable) searchInput.value?.focus();
});

watch(query, () => {
  activeIndex.value = filtered.value.findIndex((item) => !item.disabled);
});

watch(
  () => props.disabled,
  (isDisabled) => {
    if (isDisabled) open.value = false;
  },
);

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
}

function close(restoreFocus = false) {
  if (!open.value) return;
  open.value = false;
  if (restoreFocus) void nextTick(() => trigger.value?.focus());
}

function choose(option: RichSelectOption) {
  if (option.disabled) return;
  open.value = false;
  if (option.value !== props.modelValue) emit("select", option.value);
  void nextTick(() => trigger.value?.focus());
}

function move(delta: number) {
  const list = filtered.value;
  if (!list.length) return;
  let index = activeIndex.value;
  for (let step = 0; step < list.length; step++) {
    index = (index + delta + list.length) % list.length;
    if (!list[index]?.disabled) {
      activeIndex.value = index;
      return;
    }
  }
}

function onKeydown(event: KeyboardEvent) {
  if (props.disabled) return;
  if (!open.value) {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      open.value = true;
    }
    return;
  }
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
    activeIndex.value = filtered.value.findIndex((item) => !item.disabled);
  } else if (event.key === "End") {
    event.preventDefault();
    for (let i = filtered.value.length - 1; i >= 0; i--) {
      if (!filtered.value[i]?.disabled) {
        activeIndex.value = i;
        break;
      }
    }
  } else if (event.key === "Enter") {
    event.preventDefault();
    const candidate = filtered.value[activeIndex.value];
    if (candidate && !candidate.disabled) choose(candidate);
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
  <div ref="root" class="rich-select" :class="{ 'is-open': open, 'is-disabled': disabled }">
    <span v-if="label" :id="labelId" class="rich-select-label">{{ label }}</span>
    <button
      ref="trigger"
      type="button"
      class="rich-select-trigger"
      role="combobox"
      :disabled="disabled"
      :aria-expanded="open"
      :aria-controls="listboxId"
      :aria-labelledby="label ? labelId : undefined"
      aria-haspopup="listbox"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="rich-select-value">
        <template v-if="selected">
          <ProviderMark
            v-if="selected.showMark"
            class="rich-select-mark"
            :name="selected.label"
            :icon="selected.icon"
          />
          <AppIcon
            v-else-if="selected.iconName"
            class="rich-select-icon"
            :name="selected.iconName"
            :size="16"
          />
          <span class="rich-select-text">{{ selected.label }}</span>
          <span
            v-if="selected.tag"
            class="rich-select-tag"
            :class="`tone-${selected.tagTone ?? 'neutral'}`"
          >
            {{ selected.tag }}
          </span>
        </template>
        <span v-else class="rich-select-placeholder">
          {{ disabled && disabledPlaceholder ? disabledPlaceholder : placeholder }}
        </span>
      </span>
      <ChevronIcon :collapsed="false" class="rich-select-chevron" :class="{ 'is-rotated': open }" />
    </button>

    <div
      v-if="open"
      class="rich-select-popover"
      :class="{ 'is-above': openAbove }"
      @keydown="onKeydown"
    >
      <div v-if="searchable" class="rich-select-search">
        <AppIcon name="search" :size="15" class="rich-select-search-icon" />
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          :placeholder="searchPlaceholder"
          :aria-label="searchPlaceholder"
        />
      </div>
      <ul
        :id="listboxId"
        role="listbox"
        :aria-labelledby="label ? labelId : undefined"
        class="rich-select-list"
      >
        <li
          v-for="(option, index) in filtered"
          :key="option.value"
          role="option"
          class="rich-select-option"
          :class="{
            'is-selected': option.value === modelValue,
            'is-active': index === activeIndex,
            'is-disabled': option.disabled,
          }"
          :aria-selected="option.value === modelValue"
          :aria-disabled="option.disabled || undefined"
          @mouseenter="activeIndex = index"
          @mousedown.prevent
          @click="choose(option)"
        >
          <ProviderMark
            v-if="option.showMark"
            class="rich-select-mark"
            :name="option.label"
            :icon="option.icon"
          />
          <AppIcon
            v-else-if="option.iconName"
            class="rich-select-icon"
            :name="option.iconName"
            :size="16"
          />
          <span class="rich-select-option-copy">
            <span class="rich-select-option-label">{{ option.label }}</span>
            <small v-if="option.subtitle" class="rich-select-option-sub">{{
              option.subtitle
            }}</small>
          </span>
          <span
            v-if="option.tag"
            class="rich-select-tag"
            :class="`tone-${option.tagTone ?? 'neutral'}`"
          >
            {{ option.tag }}
          </span>
        </li>
        <li v-if="!filtered.length" class="rich-select-empty">{{ emptyText }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.rich-select {
  position: relative;
  display: grid;
  gap: 6px;
  min-width: 0;
}

.rich-select-label {
  color: var(--text-primary);
  font-size: 12.5px;
  font-weight: 600;
}

.rich-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  height: var(--control-h-md, 32px);
  min-height: var(--control-h-md, 32px);
  padding: 0 10px;
  border: 1px solid #cbd5e1;
  border-radius: var(--radius-sm, 6px);
  background: var(--surface, #ffffff);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.rich-select-trigger:hover:not(:disabled) {
  border-color: #94a3b8;
}

.rich-select.is-open .rich-select-trigger,
.rich-select-trigger:focus-visible {
  border-color: var(--brand-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand-accent) 14%, transparent);
  outline: none;
}

.rich-select-trigger:disabled {
  background: #f8fafc;
  color: var(--text-muted);
  cursor: not-allowed;
  opacity: 0.72;
}

.rich-select-value {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  flex: 1;
}

.rich-select-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.rich-select-placeholder {
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rich-select-icon {
  color: var(--text-muted);
}

.rich-select-mark {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-xs, 4px);
  font-size: 11px;
}

.rich-select-mark :deep(img) {
  width: 15px;
  height: 15px;
}

.rich-select-chevron {
  color: #64748b;
  transition: transform 0.15s ease;
}

.rich-select-chevron.is-rotated {
  transform: rotate(180deg);
}

.rich-select-popover {
  position: absolute;
  z-index: 40;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  min-width: 240px;
  border: 1px solid var(--border, #dde3ec);
  border-radius: var(--radius-md, 8px);
  background: var(--surface, #ffffff);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.12);
  overflow: hidden;
}

.rich-select-popover.is-above {
  top: auto;
  bottom: calc(100% + 4px);
}

.rich-select-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--border-subtle, #e8edf4);
}

.rich-select-search-icon {
  color: #94a3b8;
}

.rich-select-search input {
  width: 100%;
  min-width: 0;
  height: var(--control-h-sm, 28px);
  border: 1px solid var(--border, #dde3ec);
  border-radius: var(--radius-sm, 6px);
  padding: 0 8px;
  font: inherit;
  font-size: 12.5px;
  color: var(--text-primary);
  background: var(--surface-subtle, #f7f9fc);
}

.rich-select-search input:focus {
  outline: none;
  border-color: var(--brand-accent);
  background: var(--surface, #ffffff);
}

.rich-select-list {
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 260px;
  overflow-y: auto;
}

.rich-select-option {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  font-size: 13px;
  transition: background-color 0.12s ease;
}

.rich-select-option.is-active {
  background: #f4f6fa;
}

.rich-select-option.is-selected {
  background: var(--brand-selected);
  color: var(--brand-hover);
}

.rich-select-option.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.rich-select-option-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.rich-select-option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.rich-select-option-sub {
  color: var(--text-muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rich-select-tag {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: var(--radius-xs, 4px);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
}

.rich-select-tag.tone-neutral {
  color: #475569;
  background: #eef2f6;
}

.rich-select-tag.tone-brand {
  color: var(--brand-hover);
  background: var(--brand-selected);
}

.rich-select-tag.tone-blue {
  color: #1d4ed8;
  background: #e7f1ff;
}

.rich-select-tag.tone-green {
  color: #15803d;
  background: #dcfce7;
}

.rich-select-tag.tone-amber {
  color: #b45309;
  background: #fef3c7;
}

.rich-select-empty {
  padding: 16px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
