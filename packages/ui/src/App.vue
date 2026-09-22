<script setup lang="ts">
import QuotaCard from "./components/QuotaCard.vue";
import { sampleCards } from "./fixtures/sampleCards";
</script>

<template>
  <main class="page">
    <header class="page-header">
      <h1>订阅用量</h1>
      <p>示例数据。登录、刷新和开关尚未接入。</p>
    </header>
    <section class="card-grid" aria-label="示例账号">
      <QuotaCard v-for="card in sampleCards" :key="card.id" :card="card" />
    </section>
  </main>
</template>
