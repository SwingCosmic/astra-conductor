<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch, nextTick } from "vue";
import { ConnectionDialog, FormDialog, ProviderMark } from "@astra-conductor/shared-ui";
import type { ProviderManagementSnapshot, PublicAccount } from "@astra-conductor/contract/common";
import type {
  CustomProvider,
  CustomProviderReference,
} from "@astra-conductor/contract/graph-agent";
import CustomProviderEditor from "./CustomProviderEditor.vue";
import { graphServiceKey } from "../services/graph-agent-service";
const props = defineProps<{ snapshot: ProviderManagementSnapshot | null; focusAccount?: string }>();
const emit = defineEmits<{ reload: []; models: [account: PublicAccount] }>();
const service = inject(graphServiceKey)!;
const list = ref<CustomProvider[]>([]),
  error = ref(""),
  busy = ref(false);
const editor = ref<{
  provider?: CustomProvider;
  account?: { accountId: string; expectedRevision: string };
} | null>(null);
const deletion = ref<{ provider: CustomProvider; references: CustomProviderReference[] } | null>(
  null,
);
const connection = ref<{ providerId: string; offeringId: string; accountId?: string } | null>(null);
const impact = ref<Record<string, string[]>>({});
const binding = ref<PublicAccount | null>(null),
  target = ref("");
const expanded = ref<string[]>([]);
const offeringLabel = computed(() => {
  const p = list.value.find((p) => p.providerId === connection.value?.providerId),
    o = p?.offerings.find((o) => o.offeringId === connection.value?.offeringId);
  return p && o ? p.name + " / " + o.name : undefined;
});
const ctx = computed(() =>
  props.snapshot
    ? { contextId: props.snapshot.backend.contextId, instanceId: props.snapshot.instanceId }
    : null,
);
const unbound = computed(() =>
  (props.snapshot?.accounts ?? []).filter(
    (a) =>
      !a.offeringId ||
      (a.provider.startsWith("custom-") &&
        !list.value.some(
          (p) =>
            p.providerId === a.provider && p.offerings.some((o) => o.offeringId === a.offeringId),
        )),
  ),
);
let generation = 0;
async function reload() {
  const g = ++generation;
  try {
    const r = await service.customProviders.list();
    if (g !== generation) return;
    if (!r.ok) throw Error(r.error.message);
    list.value = r.value;
    const owner = props.snapshot?.accounts.find((a) => a.id === props.focusAccount)?.provider;
    if (owner && !expanded.value.includes(owner)) {
      expanded.value.push(owner);
      await nextTick();
      document.getElementById("model-for-" + props.focusAccount)?.focus();
    }
  } catch (e) {
    if (g === generation) error.value = e instanceof Error ? e.message : "读取供应商失败";
  }
}
watch(() => props.snapshot?.revision, reload, { immediate: true });
onBeforeUnmount(() => generation++);
watch(
  () => props.snapshot?.backend.contextId,
  () => {
    connection.value = null;
    binding.value = null;
    deletion.value = null;
    impact.value = {};
    error.value = "";
    if (editor.value?.account) editor.value = null;
  },
);
async function changed() {
  editor.value = null;
  deletion.value = null;
  connection.value = null;
  binding.value = null;
  await reload();
  emit("reload");
}
async function perform(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "操作失败";
  } finally {
    busy.value = false;
  }
}
function references(provider: CustomProvider) {
  void perform(async () => {
    const [r, models] = await Promise.all([
      service.customProviders.references(provider.providerId),
      service.getSnapshot(),
    ]);
    impact.value = {};
    if (models.ok) {
      const chosen = models.value.savedSelection?.selection;
      for (const c of models.value.catalogs.filter((c) => c.providerId === provider.providerId)) {
        const rows = (impact.value[c.accountId] ??= []);
        for (const e of c.entries)
          if (
            e.presence.includes("manual") ||
            Object.keys(e.accountOverrides.parameters).length ||
            Object.keys(e.accountOverrides.facts).length ||
            e.accountOverrides.prices.length ||
            e.accountOverrides.rateCard ||
            e.accountOverrides.presetKey
          )
            rows.push(e.displayName + " · " + c.protocolRouteId);
        if (chosen?.accountId === c.accountId && chosen.protocolRouteId === c.protocolRouteId)
          rows.push("当前测试模型 · " + chosen.modelId);
      }
    }
    if (!r.ok) throw Error(r.error.message);
    deletion.value = { provider, references: r.value };
  });
}
function remove() {
  const d = deletion.value;
  if (!d || d.references.length) return;
  void perform(async () => {
    const result = await service.customProviders.remove(d.provider.providerId, d.provider.revision);
    if (!result.ok) {
      const updated = await service.customProviders.references(d.provider.providerId);
      if (updated.ok) d.references = updated.value;
      throw Error(result.error.message);
    }
    await changed();
  });
}
async function detachRef(p: CustomProvider, a: CustomProviderReference) {
  await perform(async () => {
    const result = await service.customProviders.bindAccount({
      providerId: p.providerId,
      accountId: a.accountId,
      offeringId: null,
      expectedOfferingId: a.offeringId,
      expectedRevision: a.bindingRevision,
    });
    if (!result.ok) throw Error(result.error.message);
    const refs = await service.customProviders.references(p.providerId);
    if (!refs.ok) throw Error(refs.error.message);
    deletion.value = { provider: p, references: refs.value };
    emit("reload");
  });
}
function configureProvider(account: PublicAccount) {
  const record = props.snapshot?.connections.find((c) => c.accountId === account.id);
  if (!record) return;
  editor.value = { account: { accountId: account.id, expectedRevision: record.recordRevision } };
}
function changeBinding(account: PublicAccount) {
  binding.value = account;
  target.value = account.offeringId;
  deletion.value = null;
  error.value = "";
}
function bind() {
  const a = binding.value;
  if (!a) return;
  const c = props.snapshot?.connections.find((row) => row.accountId === a.id);
  if (!c) return;
  void perform(async () => {
    const r = await service.customProviders.bindAccount({
      accountId: a.id,
      providerId: a.provider,
      offeringId: target.value || null,
      expectedRevision: c.recordRevision,
      expectedOfferingId: a.offeringId,
    });
    if (!r.ok) throw Error(r.error.message);
    await changed();
  });
}
function accountAction(a: PublicAccount, name: string) {
  return (
    props.snapshot?.connections.find((c) => c.accountId === a.id)?.actions[name] ??
    props.snapshot?.actions[name]
  );
}
function deleteAccount(a: PublicAccount) {
  const revision = props.snapshot?.connections.find((c) => c.accountId === a.id)?.recordRevision;
  if (!revision || !ctx.value || !window.confirm("删除账号 " + a.displayName + " 及其关联凭据？"))
    return;
  const arg = { ...ctx.value, expectedRecordRevision: revision };
  void perform(async () => {
    const r = await service.providers.deleteAccount(a.id, arg);
    if (!r.ok) throw Error(r.error.message);
    emit("reload");
  });
}
function toggle(a: PublicAccount) {
  void perform(async () => {
    const r = await service.providers.setAccountEnabled(a.id, !a.enabled, ctx.value ?? undefined);
    if (!r.ok) throw Error(r.error.message);
    emit("reload");
  });
}
function members(p: string, o: string) {
  return props.snapshot?.accounts.filter((a) => a.provider === p && a.offeringId === o) ?? [];
}
function openGroup(id: string) {
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter((v) => v !== id)
    : [...expanded.value, id];
}
</script>
<template>
  <section class="custom-providers">
    <div class="graph-card-header">
      <h2>自定义供应商</h2>
      <button class="primary-action" @click="editor = {}">创建自定义供应商</button>
    </div>
    <p v-if="error && !deletion && !binding" role="alert" class="form-message">{{ error }}</p>
    <article v-for="p in list" :key="p.providerId" class="provider-row">
      <div class="provider-summary">
        <ProviderMark :name="p.name" :icon="p.icon" />
        <div class="provider-heading">
          <h2>{{ p.name }}</h2>
          <small>{{ p.offerings.length }} 个接入点</small>
        </div>
        <button class="outline-action" @click="editor = { provider: p }">编辑供应商</button
        ><button class="outline-action danger-text" @click="references(p)">删除供应商</button>
        <button
          class="outline-action"
          :aria-expanded="expanded.includes(p.providerId)"
          @click="openGroup(p.providerId)"
        >
          {{ expanded.includes(p.providerId) ? "收起" : "查看接入点" }}
        </button>
      </div>
      <div v-if="expanded.includes(p.providerId)" class="provider-accounts">
        <section v-for="o in p.offerings" :key="o.offeringId" class="custom-offering">
          <div class="graph-card-header">
            <div>
              <h3>{{ o.name }}</h3>
              <small>{{ o.routes.length }} 个协议端点</small>
            </div>
            <button
              class="outline-action"
              :disabled="snapshot?.actions.createConnection?.state !== 'enabled'"
              @click="connection = { providerId: p.providerId, offeringId: o.offeringId }"
            >
              添加账号
            </button>
          </div>
          <div
            v-for="a in members(p.providerId, o.offeringId)"
            :key="a.id"
            class="provider-account-row"
          >
            <strong>{{ a.displayName }}</strong
            ><span class="method-chip">API Key</span>
            <button class="outline-action" @click="changeBinding(a)">变更绑定</button>
            <button
              class="outline-action"
              :disabled="
                snapshot?.connections.find((c) => c.accountId === a.id)?.actions.editConnection
                  ?.state !== 'enabled'
              "
              @click="
                connection = { providerId: p.providerId, offeringId: o.offeringId, accountId: a.id }
              "
            >
              编辑账号
            </button>
            <button
              v-if="accountAction(a, 'setAccountEnabled')?.state !== 'hidden'"
              :disabled="accountAction(a, 'setAccountEnabled')?.state !== 'enabled'"
              class="outline-action"
              @click="toggle(a)"
            >
              {{ a.enabled ? "停用" : "启用" }}
            </button>
            <button
              v-if="accountAction(a, 'deleteAccount')?.state !== 'hidden'"
              :disabled="accountAction(a, 'deleteAccount')?.state !== 'enabled'"
              class="outline-action danger-text"
              @click="deleteAccount(a)"
            >
              删除账号
            </button>
            <button :id="'model-for-' + a.id" class="outline-action" @click="emit('models', a)">
              模型配置
            </button>
          </div>
        </section>
      </div>
    </article>
    <section v-if="unbound.length" class="graph-card">
      <h3>待绑定账号</h3>
      <div v-for="a in unbound" :key="a.id" class="graph-card-header">
        <span>{{ a.displayName }}</span
        ><button v-if="list.some((p) => p.providerId === a.provider)" @click="changeBinding(a)">
          选择接入点</button
        ><button
          v-else
          :disabled="!snapshot?.connections.some((c) => c.accountId === a.id)"
          @click="configureProvider(a)"
        >
          配置此账号的供应商
        </button>
      </div>
    </section>
    <CustomProviderEditor
      v-if="editor"
      :provider="editor.provider"
      :account="editor.account"
      @close="editor = null"
      @saved="changed"
    />
    <ConnectionDialog
      v-if="connection && ctx"
      v-bind="connection"
      :offering-label="offeringLabel"
      :context="ctx"
      @close="connection = null"
      @saved="changed"
    />
    <FormDialog v-if="deletion" :title="'删除 ' + deletion.provider.name" @close="deletion = null"
      ><template v-if="deletion.references.length"
        ><p>请先移走或解绑以下账号。</p>
        <ul>
          <li v-for="a in deletion.references" :key="a.accountId">
            {{ a.displayName }} ·
            {{
              deletion.provider.offerings.find((o) => o.offeringId === a.offeringId)?.name ??
              a.offeringId
            }}
            · {{ a.enabled ? "已启用" : "已停用" }}
            <small v-if="impact[a.accountId]?.length">{{ impact[a.accountId]!.join("、") }}</small>
            <button
              v-if="snapshot?.accounts.some((x) => x.id === a.accountId)"
              @click="changeBinding(snapshot!.accounts.find((x) => x.id === a.accountId)!)"
            >
              变更绑定</button
            ><button v-else @click="detachRef(deletion.provider, a)">解绑账号</button>
          </li>
        </ul></template
      >
      <p v-else>确认删除这份供应商配置？</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <footer>
        <button @click="deletion = null">取消</button
        ><button
          class="primary-action"
          :disabled="busy || !!deletion.references.length"
          @click="remove"
        >
          删除供应商
        </button>
      </footer>
    </FormDialog>
    <FormDialog v-if="binding" :title="'变更绑定 · ' + binding.displayName" @close="binding = null"
      ><label class="graph-field"
        >接入点<select v-model="target">
          <option value="">解绑，保留凭据</option>
          <option
            v-for="o in list.find((p) => p.providerId === binding?.provider)?.offerings ?? []"
            :key="o.offeringId"
            :value="o.offeringId"
          >
            {{ o.name }}
          </option>
        </select></label
      >
      <p v-if="error" role="alert">{{ error }}</p>
      <footer>
        <button @click="binding = null">取消</button
        ><button
          class="primary-action"
          :disabled="busy || target === binding.offeringId"
          @click="bind"
        >
          保存绑定
        </button>
      </footer></FormDialog
    >
  </section>
</template>
