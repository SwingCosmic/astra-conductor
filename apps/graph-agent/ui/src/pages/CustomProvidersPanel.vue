<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch, nextTick } from "vue";
import {
  AppIcon,
  authMethodLabel,
  ChevronIcon,
  CollapsiblePanel,
  ConnectionDialog,
  FormDialog,
  ProviderMark,
} from "@astra-conductor/shared-ui";
import { modelEndpointDescriptors } from "@astra-conductor/contract/common";
import type { ProviderManagementSnapshot, PublicAccount } from "@astra-conductor/contract/common";
import type {
  CustomProvider,
  CustomProviderReference,
  NewApiAccountRequest,
  NewApiOfferingRequest,
  CustomOffering,
  NewApiSiteCatalogQuery,
} from "@astra-conductor/contract/graph-agent";
import CustomProviderEditor from "./CustomProviderEditor.vue";
import NewApiSiteCatalog from "./NewApiSiteCatalog.vue";
import NewApiAccountDialog from "./NewApiAccountDialog.vue";
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
const catalog = ref<{ query: NewApiSiteCatalogQuery; label: string } | null>(null);
const keyDialog = ref<{
  target: NewApiAccountRequest | NewApiOfferingRequest;
  label: string;
  site: string;
  editable: boolean;
} | null>(null);
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

const builtinProviderIds = computed(
  () =>
    new Set(
      (props.snapshot?.providers ?? [])
        .filter((p) => p.provider !== "compatible-api-key")
        .map((p) => p.provider),
    ),
);

const unbound = computed(() =>
  (props.snapshot?.accounts ?? []).filter(
    (a) =>
      !a.offeringId ||
      (!builtinProviderIds.value.has(a.provider) &&
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

watch([list, () => props.snapshot], () => {
  const q = catalog.value?.query;
  if (
    q &&
    !list.value.some((p) => p.providerId === q.providerId && p.revision === q.expectedRevision)
  )
    catalog.value = null;
  const a = keyDialog.value?.target;
  if (
    a &&
    (!list.value.some(
      (p) => p.providerId === a.providerId && p.revision === a.expectedProviderRevision,
    ) ||
      ("accountId" in a &&
        (!props.snapshot?.connections.some(
          (c) => c.accountId === a.accountId && c.recordRevision === a.expectedRecordRevision,
        ) ||
          !props.snapshot.accounts.some(
            (row) =>
              row.id === a.accountId &&
              row.enabled &&
              row.credentialState === "available" &&
              row.provider === a.providerId &&
              row.offeringId === a.offeringId,
          ))) ||
      ctx.value?.instanceId !== a.instanceId ||
      ctx.value?.contextId !== a.contextId)
  )
    keyDialog.value = null;
});

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
  keyDialog.value = null;
  catalog.value = null;
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
            rows.push(e.displayName + " · " + c.protocol);
        if (chosen?.accountId === c.accountId && chosen.protocol === c.protocol)
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

function providerAccountCount(p: CustomProvider) {
  return (props.snapshot?.accounts ?? []).filter((a) => a.provider === p.providerId).length;
}

function protocolShortName(protocol: string) {
  return modelEndpointDescriptors.find((d) => d.protocol === protocol)?.label ?? protocol;
}

function openKeys(p: CustomProvider, offering: CustomOffering, a?: PublicAccount) {
  if (!ctx.value || !offering.siteBaseUrl) return;
  const record = a && props.snapshot?.connections.find((c) => c.accountId === a.id);
  if (a && !record) return;
  const target = {
    ...ctx.value,
    providerId: p.providerId,
    offeringId: offering.offeringId,
    expectedProviderRevision: p.revision,
  };
  keyDialog.value = {
    target:
      a && record
        ? { ...target, accountId: a.id, expectedRecordRevision: record.recordRevision }
        : target,
    label: a?.displayName ?? p.name + " / " + offering.name,
    site: offering.siteBaseUrl,
    editable: record
      ? record.actions.editConnection?.state === "enabled"
      : props.snapshot?.actions.createConnection?.state === "enabled",
  };
}

function openGroup(id: string) {
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter((v) => v !== id)
    : [...expanded.value, id];
}
</script>

<template>
  <section class="custom-providers">
    <div class="custom-providers-bar">
      <div>
        <h2>自定义供应商</h2>
        <p class="setting-hint">接入 New API 中转站或任意 OpenAI / Anthropic 兼容服务</p>
      </div>
      <button class="primary-action" @click="editor = {}">
        <AppIcon name="plus" :size="15" /> 创建自定义供应商
      </button>
    </div>

    <p v-if="error && !deletion && !binding" role="alert" class="form-message">{{ error }}</p>

    <div v-if="list.length" class="provider-list">
      <article v-for="p in list" :key="p.providerId" class="provider-row">
        <CollapsiblePanel variant="plain" :open="expanded.includes(p.providerId)">
          <template #header="{ panelId }">
            <div class="provider-summary">
              <ProviderMark :name="p.name" :icon="p.icon" />
              <div class="provider-heading">
                <div class="provider-name-row">
                  <h2>{{ p.name }}</h2>
                  <p class="provider-status">
                    <span class="status-dot" :class="{ connected: providerAccountCount(p) > 0 }" />
                    {{
                      providerAccountCount(p)
                        ? `已接入 · ${providerAccountCount(p)} 个账号`
                        : `${p.offerings.length} 个接入点`
                    }}
                  </p>
                </div>
                <p class="provider-description">
                  {{ p.templateKind === "new-api" ? "New API 中转站" : "兼容接口" }} ·
                  {{ p.offerings.map((o) => o.name).join(" / ") }}
                </p>
              </div>
              <div class="custom-provider-actions">
                <button
                  class="icon-action-btn"
                  aria-label="编辑供应商"
                  title="编辑供应商"
                  @click="editor = { provider: p }"
                >
                  <AppIcon name="edit" :size="15" />
                </button>
                <button
                  class="icon-action-btn danger-text"
                  aria-label="删除供应商"
                  title="删除供应商"
                  @click="references(p)"
                >
                  <AppIcon name="trash" :size="15" />
                </button>
                <button
                  class="icon-button"
                  :aria-label="expanded.includes(p.providerId) ? '收起接入点' : '展开接入点'"
                  :title="expanded.includes(p.providerId) ? '收起接入点' : '展开接入点'"
                  :aria-expanded="expanded.includes(p.providerId)"
                  :aria-controls="panelId"
                  @click="openGroup(p.providerId)"
                >
                  <ChevronIcon :collapsed="!expanded.includes(p.providerId)" />
                </button>
              </div>
            </div>
          </template>

          <div class="provider-accounts">
            <section v-for="o in p.offerings" :key="o.offeringId" class="custom-offering">
              <div class="offering-header">
                <div class="offering-meta">
                  <h3>{{ o.name }}</h3>
                  <div class="method-chips">
                    <span v-for="r in o.routes" :key="r.protocol">{{
                      protocolShortName(r.protocol)
                    }}</span>
                  </div>
                </div>
                <div class="offering-header-actions">
                  <button
                    v-if="p.templateKind === 'new-api' && o.siteBaseUrl"
                    class="outline-action compact-btn"
                    @click="
                      catalog = {
                        query: {
                          providerId: p.providerId,
                          offeringId: o.offeringId,
                          expectedRevision: p.revision,
                        },
                        label: p.name + ' / ' + o.name,
                      }
                    "
                  >
                    站点模型目录
                  </button>
                  <button
                    v-if="p.templateKind === 'new-api' && o.siteBaseUrl"
                    class="outline-action compact-btn"
                    :disabled="snapshot?.actions.createConnection?.state !== 'enabled'"
                    @click="openKeys(p, o)"
                  >
                    <AppIcon name="plus" :size="14" /> 从站点 Key 添加账号
                  </button>
                  <button
                    class="accent-action compact-btn"
                    :disabled="snapshot?.actions.createConnection?.state !== 'enabled'"
                    @click="connection = { providerId: p.providerId, offeringId: o.offeringId }"
                  >
                    <AppIcon name="plus" :size="14" /> 添加账号
                  </button>
                </div>
              </div>

              <div
                v-for="a in members(p.providerId, o.offeringId)"
                :key="a.id"
                class="provider-account-row custom-account-row"
              >
                <span class="account-avatar" aria-hidden="true">
                  <AppIcon name="user" :size="15" />
                </span>
                <div class="account-identity">
                  <strong>{{ a.displayName }}</strong>
                </div>
                <span class="method-chip">{{ authMethodLabel(a.authMethod) }}</span>
                <span class="status-pill" :class="a.enabled ? 'is-enabled' : 'is-disabled'">
                  {{ a.enabled ? "可用" : "已停用" }}
                </span>
                <div class="account-row-actions">
                  <button
                    :id="'model-for-' + a.id"
                    class="accent-action model-entry-action"
                    :aria-label="'配置 ' + p.name + ' 下 ' + a.displayName + ' 的模型'"
                    @click="emit('models', a)"
                  >
                    模型配置 <AppIcon name="arrow-right" :size="13" />
                  </button>
                  <button
                    v-if="p.templateKind === 'new-api' && o.siteBaseUrl"
                    class="outline-action"
                    :disabled="
                      !a.enabled ||
                      a.credentialState !== 'available' ||
                      snapshot?.backend.active === 'unavailable'
                    "
                    @click="openKeys(p, o, a)"
                  >
                    Key 与用量
                  </button>
                  <button
                    class="icon-action-btn"
                    aria-label="编辑账号"
                    title="编辑账号"
                    :disabled="
                      snapshot?.connections.find((c) => c.accountId === a.id)?.actions
                        .editConnection?.state !== 'enabled'
                    "
                    @click="
                      connection = {
                        providerId: p.providerId,
                        offeringId: o.offeringId,
                        accountId: a.id,
                      }
                    "
                  >
                    <AppIcon name="edit" :size="14" />
                  </button>
                  <button class="outline-action" @click="changeBinding(a)">变更绑定</button>
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
                    class="icon-action-btn danger-text"
                    aria-label="删除账号"
                    title="删除账号"
                    @click="deleteAccount(a)"
                  >
                    <AppIcon name="trash" :size="14" />
                  </button>
                </div>
              </div>
              <p v-if="!members(p.providerId, o.offeringId).length" class="offering-empty">
                该接入点尚未绑定账号，点击右上角「添加账号」即可接入。
              </p>
            </section>
          </div>
        </CollapsiblePanel>
      </article>
    </div>

    <section v-if="unbound.length" class="graph-card unbound-card">
      <h3>待绑定账号</h3>
      <p class="setting-hint">以下凭据尚未关联到本地接入点，请先配置供应商或选择接入点。</p>
      <div v-for="a in unbound" :key="a.id" class="unbound-row">
        <span class="unbound-name">
          <AppIcon name="user" :size="15" />
          <strong>{{ a.displayName }}</strong>
        </span>
        <button
          v-if="list.some((p) => p.providerId === a.provider)"
          class="outline-action"
          @click="changeBinding(a)"
        >
          选择接入点
        </button>
        <button
          v-else
          class="outline-action"
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
    <NewApiSiteCatalog v-if="catalog" v-bind="catalog" @close="catalog = null" />
    <NewApiAccountDialog
      v-if="keyDialog"
      v-bind="keyDialog"
      @close="keyDialog = null"
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

    <FormDialog v-if="deletion" :title="'删除 ' + deletion.provider.name" @close="deletion = null">
      <template v-if="deletion.references.length">
        <p class="setting-hint">以下账号仍引用此供应商配置，请先移走或解绑后再删除。</p>
        <ul class="reference-list">
          <li v-for="a in deletion.references" :key="a.accountId">
            <div class="reference-copy">
              <strong>{{ a.displayName }}</strong>
              <small>
                {{
                  deletion.provider.offerings.find((o) => o.offeringId === a.offeringId)?.name ??
                  a.offeringId
                }}
                · {{ a.enabled ? "已启用" : "已停用" }}
              </small>
              <small v-if="impact[a.accountId]?.length" class="reference-impact">
                影响：{{ impact[a.accountId]!.join("、") }}
              </small>
            </div>
            <button
              v-if="snapshot?.accounts.some((x) => x.id === a.accountId)"
              class="outline-action"
              @click="changeBinding(snapshot!.accounts.find((x) => x.id === a.accountId)!)"
            >
              变更绑定
            </button>
            <button v-else class="outline-action" @click="detachRef(deletion.provider, a)">
              解绑账号
            </button>
          </li>
        </ul>
      </template>
      <p v-else>确认删除这份供应商配置？已保存的凭据和共享授权不会被删除。</p>
      <p v-if="error" role="alert" class="form-message">{{ error }}</p>
      <footer>
        <button @click="deletion = null">取消</button>
        <button
          class="primary-action"
          :disabled="busy || !!deletion.references.length"
          @click="remove"
        >
          删除供应商
        </button>
      </footer>
    </FormDialog>

    <FormDialog v-if="binding" :title="'变更绑定 · ' + binding.displayName" @close="binding = null">
      <label class="graph-field">
        接入点
        <select v-model="target">
          <option value="">解绑，保留凭据</option>
          <option
            v-for="o in list.find((p) => p.providerId === binding?.provider)?.offerings ?? []"
            :key="o.offeringId"
            :value="o.offeringId"
          >
            {{ o.name }}
          </option>
        </select>
      </label>
      <p v-if="error" role="alert" class="form-message">{{ error }}</p>
      <footer>
        <button @click="binding = null">取消</button>
        <button
          class="primary-action"
          :disabled="busy || target === binding.offeringId"
          @click="bind"
        >
          保存绑定
        </button>
      </footer>
    </FormDialog>
  </section>
</template>
