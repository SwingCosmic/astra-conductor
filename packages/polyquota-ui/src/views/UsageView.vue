<script setup lang="ts">
import QuotaCard from "../components/QuotaCard.vue";
import type { PublicAccount, PublicUsage } from "../models";

defineProps<{
  accounts: PublicAccount[];
  usage: Record<string, PublicUsage | null>;
  busy: boolean;
}>();
defineEmits<{
  refresh: [account: PublicAccount];
  toggle: [account: PublicAccount];
  refreshAll: [];
}>();
</script>

<template>
  <section class="content-page">
    <header class="content-header">
      <div>
        <h1>用量概览</h1>
        <p>查看各账号最新的订阅用量</p>
      </div>
      <button
        class="outline-action"
        :disabled="busy || !accounts.length"
        @click="$emit('refreshAll')"
      >
        ↻&nbsp; 刷新全部
      </button>
    </header>
    <div v-if="accounts.length" class="quota-grid" aria-label="账号用量">
      <QuotaCard
        v-for="account in accounts"
        :key="account.id"
        :account="account"
        :usage="usage[account.id] ?? null"
        :busy="busy"
        @refresh="$emit('refresh', account)"
        @toggle="$emit('toggle', account)"
      />
    </div>
    <div v-else class="empty-state">
      <h2>还没有接入账号</h2>
      <p>请前往“服务商”页面添加账号。</p>
    </div>
  </section>
</template>
