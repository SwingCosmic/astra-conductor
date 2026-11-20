<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref } from "vue";
import { FormDialog } from "@astra-conductor/shared-ui";
import type {
  NewApiAccountRequest,
  NewApiOfferingRequest,
  NewApiKeyPage,
  NewApiUsage,
} from "@astra-conductor/contract/graph-agent";
import { graphServiceKey } from "../services/graph-agent-service";
const props = defineProps<{
  target: NewApiOfferingRequest | NewApiAccountRequest;
  label: string;
  site: string;
  editable: boolean;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const service = inject(graphServiceKey)!.newApi;
const account = computed(() => ("accountId" in props.target ? props.target : undefined));
const displayName = ref("");
const creationAttempts = new Map<string, string>();
function creationId(tokenId: number, name: string) {
  const intent = JSON.stringify([tokenId, name]);
  let id = creationAttempts.get(intent);
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join("");
    creationAttempts.set(intent, id);
  }
  return id;
}
const usage = ref<NewApiUsage>(),
  keys = ref<NewApiKeyPage>(),
  access = ref<HTMLInputElement>();
const hasAccess = ref(false),
  busy = ref(false),
  error = ref("");
const lifetime = new AbortController();
async function perform(run: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await run();
  } catch (cause) {
    if (!lifetime.signal.aborted)
      error.value = cause instanceof Error ? cause.message : "站点请求失败";
  } finally {
    if (!lifetime.signal.aborted) busy.value = false;
  }
}
function readUsage() {
  const existing = account.value;
  if (!existing) return;
  void perform(async () => {
    usage.value = undefined;
    const result = await service.getUsage(existing, lifetime.signal);
    if (lifetime.signal.aborted) return;
    if (!result.ok) throw Error(result.error.message);
    usage.value = result.value;
  });
}
function tokenChanged() {
  keys.value = undefined;
  hasAccess.value = !!access.value?.value.trim();
}
function listKeys(page: number) {
  const accessToken = access.value?.value.trim();
  if (!accessToken) return;
  void perform(async () => {
    keys.value = undefined;
    const args = { accessToken, page };
    const result = account.value
      ? await service.listKeys({ ...account.value, ...args }, lifetime.signal)
      : await service.listOfferingKeys({ ...props.target, ...args }, lifetime.signal);
    if (lifetime.signal.aborted) return;
    if (!result.ok) throw Error(result.error.message);
    keys.value = result.value;
  });
}
function selectKey(tokenId: number) {
  const accessToken = access.value?.value.trim();
  if (!accessToken) return;
  void perform(async () => {
    const args = { accessToken, tokenId };
    const name = displayName.value.trim();
    const result = account.value
      ? await service.selectKey({ ...account.value, ...args }, lifetime.signal)
      : await service.createAccountWithKey(
          { ...props.target, ...args, displayName: name, operationId: creationId(tokenId, name) },
          lifetime.signal,
        );
    if (lifetime.signal.aborted) return;
    if (!result.ok) throw Error(result.error.message);
    if (access.value) access.value.value = "";
    emit("saved");
  });
}
function quota(value: number | null) {
  return value?.toLocaleString() ?? "未提供";
}
function expiry(seconds: number | null) {
  return seconds === null
    ? "未提供"
    : seconds <= 0
      ? "长期有效"
      : new Date(seconds * 1000).toLocaleString();
}
onBeforeUnmount(() => {
  lifetime.abort();
  if (access.value) access.value.value = "";
});
</script>
<template>
  <FormDialog
    :title="(account ? 'Key 与用量 · ' : '从站点 Key 添加账号 · ') + label"
    @close="$emit('close')"
  >
    <p class="setting-hint site-address">{{ site }}</p>
    <template v-if="account">
      <h3>当前 Key 用量</h3>
      <button class="outline-action" :disabled="busy" @click="readUsage">查询用量</button>
      <dl v-if="usage" class="key-usage">
        <dt>已用额度</dt>
        <dd>{{ quota(usage.totalUsed) }}</dd>
        <dt>剩余额度</dt>
        <dd>{{ usage.unlimitedQuota ? "不限额" : quota(usage.totalAvailable) }}</dd>
        <dt>总额度</dt>
        <dd>{{ usage.unlimitedQuota ? "不限额" : quota(usage.totalGranted) }}</dd>
        <dt>有效期</dt>
        <dd>{{ expiry(usage.expiresAt) }}</dd>
        <template v-if="usage.userQuota">
          <dt>账户剩余额度</dt>
          <dd>{{ quota(usage.userQuota.totalAvailable) }}</dd>
          <dt>账户已用额度</dt>
          <dd>{{ quota(usage.userQuota.totalUsed) }}</dd>
        </template>
      </dl>
    </template>
    <template v-if="editable">
      <h3 v-if="account">从站点选择 Key</h3>
      <p class="setting-hint">
        输入该站点的个人访问令牌。列出 Key 需要 api_key:read，{{
          account ? "替换当前账号的 Key" : "绑定所选 Key"
        }}
        还需要 api_key:reveal。未开放个人令牌管理的站点可在「{{
          account ? "编辑账号" : "添加账号"
        }}」手工填写 Key。
      </p>
      <form @submit.prevent="listKeys(1)">
        <label class="graph-field"
          >站点个人访问令牌（PAT）
          <input
            ref="access"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy"
            @input="tokenChanged"
          />
        </label>
        <button class="outline-action" :disabled="busy || !hasAccess">列出我的 Key</button>
      </form>
      <template v-if="keys">
        <label v-if="!account && keys.items.length" class="graph-field"
          >新账号名称
          <input
            v-model="displayName"
            maxlength="128"
            :disabled="busy"
            placeholder="例如：开发用 Key"
          />
        </label>
        <ul v-if="keys.items.length" class="site-keys">
          <li v-for="key in keys.items" :key="key.id">
            <span
              ><strong>{{ key.name || "Key #" + key.id }}</strong>
              <small
                >#{{ key.id }} · {{ key.group || "默认分组" }} · {{ expiry(key.expiresAt) }}</small
              ></span
            >
            <button
              class="outline-action"
              :disabled="
                busy ||
                (!account && !displayName.trim()) ||
                (key.status !== null && key.status !== 1)
              "
              @click="selectKey(key.id)"
            >
              {{ account ? "使用此 Key" : "用此 Key 添加账号" }}
            </button>
          </li>
        </ul>
        <p v-else>当前页没有 Key。</p>
        <footer v-if="keys.total > keys.pageSize">
          <button :disabled="busy || keys.page <= 1" @click="listKeys(keys.page - 1)">
            上一页
          </button>
          <span>第 {{ keys.page }} 页</span>
          <button
            :disabled="busy || keys.page * keys.pageSize >= keys.total"
            @click="listKeys(keys.page + 1)"
          >
            下一页
          </button>
        </footer>
      </template>
    </template>
    <p v-if="busy" role="status">正在联系站点…</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </FormDialog>
</template>
<style scoped>
.key-usage {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.3rem 1rem;
}
.key-usage dd {
  margin: 0;
}
.site-address,
.site-keys strong {
  overflow-wrap: anywhere;
}
.site-keys {
  list-style: none;
  padding: 0;
  max-height: 38dvh;
  overflow: auto;
}
.site-keys li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.5rem 0;
}
.site-keys small {
  display: block;
  color: var(--text-secondary);
}
</style>
