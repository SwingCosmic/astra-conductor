<script setup lang="ts">
export interface AppBrand {
  name: string;
  icon: string;
  version?: string;
  theme?: "blue" | "purple";
}
export interface NavigationItem {
  id: string;
  label: string;
  icon?: string;
}
defineProps<{
  brand: AppBrand;
  navigation: readonly NavigationItem[];
  activeId: string;
  width?: "wide" | "normal";
}>();
defineEmits<{ navigate: [id: string] }>();
</script>

<template>
  <div class="app-shell" :class="`theme-${brand.theme ?? 'blue'}`">
    <aside class="sidebar">
      <div class="brand">
        <img class="brand-mark" :src="brand.icon" alt="" />
        <strong>{{ brand.name }}</strong>
      </div>
      <nav aria-label="主导航">
        <button
          v-for="item in navigation"
          :key="item.id"
          :class="{ active: activeId === item.id }"
          :aria-current="activeId === item.id ? 'page' : undefined"
          @click="$emit('navigate', item.id)"
        >
          <span v-if="item.icon" aria-hidden="true">{{ item.icon }}</span
          >{{ item.label }}
        </button>
      </nav>
      <span v-if="brand.version" class="version">v{{ brand.version }}</span>
    </aside>
    <main class="main-panel" :class="{ 'main-panel--wide': width === 'wide' }">
      <slot />
    </main>
  </div>
</template>
