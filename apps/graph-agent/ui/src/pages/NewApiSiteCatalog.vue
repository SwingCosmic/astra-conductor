<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { FormDialog } from "@astra-conductor/shared-ui";
import type {
  NewApiSiteCatalogQuery,
  NewApiSiteModel,
} from "@astra-conductor/contract/graph-agent";
import { graphServiceKey } from "../services/graph-agent-service";

const props = defineProps<{ query: NewApiSiteCatalogQuery; label: string }>();
defineEmits<{ close: [] }>();
const service = inject(graphServiceKey)!;
const rows = ref<NewApiSiteModel[]>([]);
const busy = ref(true),
  error = ref(""),
  search = ref(""),
  page = ref(1);
const pageSize = 25;
const showPrices = ref("");
const meterLabels = {
  input: "输入",
  output: "输出",
  "cache-read": "缓存读取",
  "cache-write": "缓存写入",
};
const filtered = computed(() => {
  const term = search.value.trim().toLowerCase();
  return rows.value.filter((row) =>
    [row.modelId, row.displayName, ...row.endpointTypes].some((v) =>
      v.toLowerCase().includes(term),
    ),
  );
});
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)));
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize),
);
watch(search, () => {
  page.value = 1;
});
let controller: AbortController | undefined;
async function read() {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  busy.value = true;
  error.value = "";
  try {
    const result = await service.customProviders.listSiteModels(props.query, request.signal);
    if (request.signal.aborted) return;
    if (!result.ok) throw Error(result.error.message);
    rows.value = result.value;
    page.value = 1;
  } catch (cause) {
    if (!request.signal.aborted)
      error.value = cause instanceof Error ? cause.message : "读取站点目录失败";
  } finally {
    if (!request.signal.aborted) busy.value = false;
  }
}
function price({ billing }: NewApiSiteModel) {
  if (billing.kind === "per-request" && billing.modelPrice !== null)
    return "基础价 USD " + billing.modelPrice + " / 次";
  if (billing.kind === "dynamic") return "站点动态计价";
  if (billing.kind === "token-ratio") {
    const values = [];
    if (billing.modelRatio !== null) values.push("模型倍率 " + billing.modelRatio);
    if (billing.completionRatio !== null) values.push("输出倍率 " + billing.completionRatio);
    return values.join(" · ");
  }
  return "";
}
onMounted(read);
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <FormDialog :title="'站点模型目录 · ' + label" @close="$emit('close')">
    <p class="setting-hint">
      站点公开挂牌的模型和基础报价。添加账号后，可在「模型配置」查看该 Key 的可用模型。
    </p>
    <p v-if="busy" role="status">正在读取站点目录…</p>
    <template v-else-if="error">
      <p role="alert">{{ error }}</p>
      <button class="outline-action" @click="read">重试</button>
    </template>
    <template v-else>
      <label class="graph-field">搜索模型或端点<input v-model="search" type="search" /></label>
      <p class="setting-hint" role="status">{{ filtered.length }} 个模型</p>
      <ul v-if="visible.length" class="site-models">
        <li v-for="row in visible" :key="row.modelId">
          <strong>{{ row.displayName }}</strong>
          <small v-if="row.modelId !== row.displayName">{{ row.modelId }}</small>
          <small>{{ row.endpointTypes.join(" · ") || "站点未标注端点" }}</small>
          <small v-if="price(row)">{{ price(row) }}</small>
          <template v-if="row.prices.length">
            <button
              class="outline-action group-prices"
              :aria-expanded="showPrices === row.modelId"
              @click="showPrices = showPrices === row.modelId ? '' : row.modelId"
            >
              分组报价
            </button>
            <table v-if="showPrices === row.modelId">
              <thead>
                <tr>
                  <th>分组</th>
                  <th>计量</th>
                  <th>USD / 百万 token</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="quote in row.prices" :key="JSON.stringify([quote.tier, quote.kind])">
                  <td>{{ quote.tier }}</td>
                  <td>{{ meterLabels[quote.kind] }}</td>
                  <td>{{ quote.amount }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </li>
      </ul>
      <p v-else>{{ rows.length ? "没有匹配的模型。" : "站点尚未挂牌模型。" }}</p>
      <footer v-if="pages > 1">
        <button :disabled="page === 1" @click="page--">上一页</button>
        <span>{{ page }} / {{ pages }}</span>
        <button :disabled="page === pages" @click="page++">下一页</button>
      </footer>
    </template>
  </FormDialog>
</template>
<style scoped>
.site-models {
  list-style: none;
  padding: 0;
  max-height: 46dvh;
  overflow: auto;
}
.site-models li {
  display: grid;
  gap: 0.2rem;
  padding: 0.5rem 0;
  overflow-wrap: anywhere;
}
.site-models small {
  color: var(--text-secondary);
}
.group-prices {
  justify-self: start;
}
.site-models :is(th, td) {
  text-align: left;
  padding-right: 0.6rem;
}
</style>
