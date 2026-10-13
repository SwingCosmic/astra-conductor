<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import QuotaCard from "../components/QuotaCard.vue";
import UsageScoreRings from "../components/UsageScoreRings.vue";
import type {
  PublicAccount,
  PublicCompositeRemaining,
  PublicProviderDescriptor,
  PublicUsage,
  ResetCreditRedemption,
} from "../models";

const props = defineProps<{
  accounts: PublicAccount[];
  usage: Record<string, PublicUsage | null>;
  busy: boolean;
  providers?: readonly PublicProviderDescriptor[];
  remaining?: PublicCompositeRemaining | null;
}>();
defineEmits<{
  refresh: [account: PublicAccount];
  toggle: [account: PublicAccount];
  redeem: [account: PublicAccount, redemption: ResetCreditRedemption];
  refreshAll: [];
}>();

const singleColumn = ref(false);
let mediaQuery: MediaQueryList | null = null;

const accountColumns = computed(() => {
  if (singleColumn.value) return [props.accounts];
  return [
    props.accounts.filter((_, index) => index % 2 === 0),
    props.accounts.filter((_, index) => index % 2 === 1),
  ].filter((column) => column.length > 0);
});

function updateColumnMode(event?: MediaQueryListEvent): void {
  singleColumn.value = event?.matches ?? mediaQuery?.matches ?? false;
}

onMounted(() => {
  if (typeof window.matchMedia !== "function") return;
  mediaQuery = window.matchMedia("(max-width: 980px)");
  updateColumnMode();
  mediaQuery.addEventListener("change", updateColumnMode);
});

onBeforeUnmount(() => mediaQuery?.removeEventListener("change", updateColumnMode));
</script>

<template>
  <section class="content-page">
    <header class="content-header">
      <div class="content-header-copy">
        <h1>用量概览</h1>
        <p>查看各账号最新的订阅用量</p>
      </div>
      <UsageScoreRings :remaining="remaining" />
      <button
        class="outline-action"
        :disabled="busy || !accounts.length"
        @click="$emit('refreshAll')"
      >
        ↻&nbsp; 刷新全部
      </button>
    </header>
    <div v-if="accounts.length" class="quota-grid" aria-label="账号用量">
      <div v-for="(column, index) in accountColumns" :key="index" class="quota-column">
        <QuotaCard
          v-for="account in column"
          :key="account.id"
          :account="account"
          :usage="usage[account.id] ?? null"
          :busy="busy"
          :providers="providers"
          @refresh="$emit('refresh', account)"
          @toggle="$emit('toggle', account)"
          @redeem="$emit('redeem', account, $event)"
        />
      </div>
    </div>
    <div v-else class="empty-state">
      <h2>还没有接入账号</h2>
      <p>请前往“服务商”页面添加账号。</p>
    </div>
  </section>
</template>
