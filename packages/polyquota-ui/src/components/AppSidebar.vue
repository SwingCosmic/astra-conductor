<script setup lang="ts">
import polyquotaIcon from "../assets/icon/polyquota.svg";

export type PageId = "usage" | "providers" | "settings";
defineProps<{ page: PageId }>();
defineEmits<{ navigate: [page: PageId] }>();
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <img class="brand-mark" :src="polyquotaIcon" alt="" />
      <strong>PolyQuota</strong>
    </div>
    <nav aria-label="主导航">
      <button :class="{ active: page === 'usage' }" @click="$emit('navigate', 'usage')">
        <span aria-hidden="true">▥</span>用量
      </button>
      <button :class="{ active: page === 'providers' }" @click="$emit('navigate', 'providers')">
        <span aria-hidden="true">▦</span>服务商
      </button>
      <button :class="{ active: page === 'settings' }" @click="$emit('navigate', 'settings')">
        <span aria-hidden="true">⚙</span>设置
      </button>
    </nav>
    <span class="version">v0.1.0</span>
  </aside>
</template>
