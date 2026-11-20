<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { authMethodLabel, catalogPresentations, ProviderMark } from "@astra-conductor/shared-ui";
import type {
  ProviderManagementSnapshot,
  PublicAccount,
  ModelCatalogView,
  CustomProvider,
  ChangeModelPackRequest,
} from "@astra-conductor/contract/graph-agent";
import { modelEndpointDescriptors } from "@astra-conductor/contract/common";
import { useModelView, sameRoute } from "./model-view";
import { typeLabels } from "./catalog-labels";
import CatalogPanel from "./CatalogPanel.vue";
const props = defineProps<{ initialAccount?: PublicAccount }>();
const emit = defineEmits<{ providers: []; chat: [] }>();
const { service, snapshot, loadError, reload } = useModelView();
const management = ref<ProviderManagementSnapshot | null>(null),
  custom = ref<CustomProvider[]>([]);
const owner = ref(props.initialAccount?.provider ?? ""),
  offering = ref(props.initialAccount?.offeringId ?? "");
const account = ref(props.initialAccount?.id ?? ""),
  protocol = ref(""),
  source = ref(""),
  initialModel = ref("");
const panel = ref<InstanceType<typeof CatalogPanel>>();
const controlsError = ref(""),
  packBusy = ref(false),
  packFile = ref<HTMLInputElement>();
const sources = new Map<string, string>();
let disposed = false,
  iteration = 0;
async function directories() {
  const seq = ++iteration;
  try {
    const [p, c] = await Promise.all([
      service.providers.getSnapshot(),
      service.customProviders.list(),
    ]);
    if (disposed || seq !== iteration) return;
    if (p.ok) management.value = p.value;
    else throw Error(p.error.message);
    if (c.ok) custom.value = c.value;
    else throw Error(c.error.message);
  } catch (e) {
    if (!disposed) controlsError.value = e instanceof Error ? e.message : "读取供应商失败";
  }
}
let stop: undefined | (() => void);
onMounted(() => {
  void directories();
  stop = service.providers.subscribe((event) => {
    const previous = management.value;
    if (
      previous &&
      (event.instanceId !== previous.instanceId ||
        (event.contextId && event.contextId !== previous.backend.contextId))
    ) {
      management.value = null;
      controlsError.value = "";
    }
    void directories();
  });
});
onBeforeUnmount(() => {
  disposed = true;
  stop?.();
});
const catalogs = computed(() => snapshot.value?.catalogs ?? []);
const builtinRows = computed(() => catalogPresentations(management.value?.providers));
const providers = computed(() => {
  const map = new Map<string, { id: string; name: string; icon?: string | null }>();
  for (const p of management.value?.providers ?? []) {
    if (p.provider === "compatible-api-key") continue;
    map.set(p.provider, {
      id: p.provider,
      name: p.displayName,
      icon: builtinRows.value.find((r) => r.provider === p.provider)?.icon,
    });
  }
  for (const p of custom.value)
    map.set(p.providerId, { id: p.providerId, name: p.name, icon: p.icon });
  return [...map.values()];
});
const picked = computed(() => providers.value.find((p) => p.id === owner.value));
const customOwner = computed(() => custom.value.find((p) => p.providerId === owner.value));
const offerings = computed(
  () =>
    customOwner.value?.offerings.map((o) => ({ id: o.offeringId, name: o.name })) ??
    builtinRows.value
      .filter((r) => r.provider === owner.value)
      .map((r) => ({ id: r.id, name: r.name })),
);
const rows = computed(() =>
  catalogs.value.filter((c) => c.providerId === owner.value && c.offeringId === offering.value),
);
const accountOptions = computed(() => [
  ...new Map(rows.value.filter((c) => c.accountId).map((c) => [c.accountId, c])).values(),
]);
const publicScope = computed(() => account.value === "*");
const scopeRows = computed(() =>
  rows.value.filter((c) => publicScope.value || c.accountId === account.value),
);
const typeFilter = ref("");
const routeTypes = computed(
  () =>
    new Set(
      scopeRows.value
        .map((c) => modelEndpointDescriptors.find((d) => d.protocol === c.protocol)?.modelType)
        .filter((v) => !!v),
    ),
);
const protocols = computed(() => [
  ...new Set(
    scopeRows.value
      .filter(
        (c) =>
          !typeFilter.value ||
          modelEndpointDescriptors.find((d) => d.protocol === c.protocol)?.modelType ===
            typeFilter.value,
      )
      .map((c) => c.protocol),
  ),
]);
async function changeType(event: Event) {
  const el = event.target as HTMLSelectElement;
  const value = el.value;
  el.value = typeFilter.value;
  if (!(await mayLeave())) return;
  typeFilter.value = value;
  if (!protocols.value.some((p) => p === protocol.value)) protocol.value = "";
  setSingle();
}
const samples = computed(() => scopeRows.value.filter((c) => c.protocol === protocol.value));
const catalog = computed(
  () =>
    samples.value.find((c) => c.accountId === source.value && c.refresh.state === "enabled") ??
    samples.value.find((c) => c.refresh.state === "enabled") ??
    samples.value[0],
);
const routeName = (id: string) =>
  modelEndpointDescriptors.find((d) => d.protocol === id)?.label ?? id;
const sampleKey = () => JSON.stringify([owner.value, offering.value, protocol.value]);
function setSingle() {
  if (!offering.value && offerings.value.length === 1) offering.value = offerings.value[0]!.id;
  if (!protocol.value && protocols.value.length === 1) protocol.value = protocols.value[0]!;
  source.value = sources.get(sampleKey()) ?? "";
}
watch([offerings, protocols], setSingle, { immediate: true });
async function mayLeave() {
  return (await panel.value?.mayLeave()) ?? true;
}
defineExpose({ mayLeave });
async function change(
  kind: "owner" | "offering" | "account" | "protocol" | "source",
  value: string,
  event?: Event,
) {
  const control = event?.target as HTMLSelectElement | undefined;
  if (control) control.value = { owner, offering, account, protocol, source }[kind].value;
  if (!(await mayLeave())) return;
  controlsError.value = "";
  initialModel.value = "";
  if (["owner", "offering", "account"].includes(kind)) typeFilter.value = "";
  if (kind === "owner") {
    owner.value = value;
    offering.value = "";
    account.value = "";
    protocol.value = "";
  }
  if (kind === "offering") {
    offering.value = value;
    account.value = "";
    protocol.value = "";
  }
  if (kind === "account") {
    account.value = value;
    protocol.value = "";
  }
  if (kind === "protocol") protocol.value = value;
  if (kind === "source") {
    source.value = value;
    sources.set(sampleKey(), value);
  }
  setSingle();
}
async function enterSample(accountId: string, modelId: string) {
  if (!(await mayLeave())) return;
  account.value = accountId;
  initialModel.value = modelId;
}
async function openSaved() {
  const sel = snapshot.value?.savedSelection?.selection,
    r = catalogs.value.find((c) => sameRoute(c, sel));
  if (!r || !sel || !(await mayLeave())) return;
  typeFilter.value = "";
  owner.value = r.providerId;
  offering.value = r.offeringId;
  account.value = r.accountId;
  protocol.value = r.protocol;
  initialModel.value = sel.modelId;
}
const val = (e: Event) => (e.target as HTMLSelectElement).value;
function acctLabel(row: ModelCatalogView) {
  const a = management.value?.accounts.find((v) => v.id === row.accountId);
  return [
    row.accountDisplayName,
    a && authMethodLabel(a.authMethod),
    a?.maskedIdentifier !== row.accountDisplayName ? a?.maskedIdentifier : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
const refreshKey = computed(() =>
  catalog.value && snapshot.value
    ? JSON.stringify([
        snapshot.value.stamp.instanceId,
        snapshot.value.backend.contextId,
        account.value,
        catalog.value.accountId,
        catalog.value.protocolFamily,
        catalog.value.familyBindingRevision,
        catalog.value.refresh.state,
      ])
    : "",
);
watch(refreshKey, async (key) => {
  const r = catalog.value,
    s = snapshot.value;
  if (!key || !r?.protocolFamily || !r.familyBindingRevision || !s || r.refresh.state !== "enabled")
    return;
  if (r.catalog.state === "not-loaded" || (r.catalog.state === "ready" && r.catalog.stale)) {
    const result = await service.refreshCatalog({
      instanceId: s.stamp.instanceId,
      contextId: s.backend.contextId,
      accountId: r.accountId,
      protocolFamily: r.protocolFamily,
      expectedFamilyBindingRevision: r.familyBindingRevision,
    });
    if (!disposed && key === refreshKey.value) {
      if (!result.ok) controlsError.value = result.error.message;
      void reload();
    }
  }
});
async function pack(action: ChangeModelPackRequest["action"], file?: File) {
  const s = snapshot.value;
  if (!s || packBusy.value || !(await mayLeave())) return;
  packBusy.value = true;
  controlsError.value = "";
  try {
    const r = await service.changeModelPack({
      instanceId: s.stamp.instanceId,
      contextId: s.backend.contextId,
      expectedSettingsRevision: s.settingsRevision,
      action,
      ...(file ? { pack: JSON.parse(await file.text()) } : {}),
    });
    if (!r.ok) throw Error(r.error.message);
    await reload();
  } catch (e) {
    controlsError.value = e instanceof Error ? e.message : "预置操作失败";
  } finally {
    packBusy.value = false;
    if (packFile.value) packFile.value.value = "";
  }
}
</script>
<template>
  <section class="content-page model-page">
    <header class="content-header">
      <div><h1>模型配置</h1></div>
      <div class="graph-actions">
        <button v-if="snapshot?.savedSelection" class="outline-action" @click="openSaved">
          打开当前测试模型</button
        ><button class="outline-action" @click="emit('providers')">管理供应商</button>
      </div>
    </header>
    <p v-if="loadError || controlsError" role="alert" class="form-message">
      {{ loadError || controlsError }}
      <button
        @click="
          controlsError = '';
          reload();
          directories();
        "
      >
        重新读取
      </button>
    </p>
    <section class="graph-card">
      <h2>供应商</h2>
      <div class="provider-choice-list">
        <button
          v-for="p in providers"
          :key="p.id"
          class="provider-choice"
          :aria-pressed="owner === p.id"
          @click="change('owner', p.id)"
        >
          <ProviderMark :name="p.name" :icon="p.icon" />{{ p.name }}
        </button>
      </div>
      <p v-if="!providers.length" class="setting-hint">等待读取供应商目录。</p>
      <div v-if="picked" class="graph-grid scope-picker">
        <label class="graph-field"
          >接入点<select :value="offering" @change="change('offering', val($event), $event)">
            <option value="">选择接入点</option>
            <option v-for="o in offerings" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select></label
        >
        <label class="graph-field"
          >账号范围<select
            :value="account"
            :disabled="!offering"
            @change="change('account', val($event), $event)"
          >
            <option value="">选择账号</option>
            <option v-if="!customOwner" value="*">本接入点全部账号 · 供应商默认</option>
            <option v-for="r in accountOptions" :key="r.accountId" :value="r.accountId">
              {{ acctLabel(r) }}
            </option>
          </select></label
        >
        <label v-if="account && routeTypes.size > 1" class="graph-field"
          >模型类型<select :value="typeFilter" @change="changeType">
            <option value="">全部类型</option>
            <option v-for="type in routeTypes" :key="type" :value="type">
              {{ typeLabels[type] }}
            </option>
          </select></label
        >
        <label class="graph-field"
          >协议端点<select
            :value="protocol"
            :disabled="!account"
            @change="change('protocol', val($event), $event)"
          >
            <option value="">选择协议</option>
            <option v-for="p in protocols" :key="p" :value="p">{{ routeName(p) }}</option>
          </select></label
        >
        <label v-if="publicScope && protocol" class="graph-field"
          >目录取样账号<select
            :value="catalog?.accountId ?? ''"
            @change="change('source', val($event), $event)"
          >
            <option v-if="!samples.some((r) => r.refresh.state === 'enabled')" value="">
              暂无可用账号
            </option>
            <option
              v-for="r in samples.filter((r) => r.accountId && r.refresh.state === 'enabled')"
              :key="r.accountId"
              :value="r.accountId"
            >
              {{ acctLabel(r) }}
            </option>
          </select></label
        >
      </div>
      <p v-if="publicScope" class="setting-hint">此配置应用于本接入点的所有账号，账号覆盖优先。</p>
    </section>
    <CatalogPanel
      v-if="snapshot && catalog"
      ref="panel"
      :key="refreshKey"
      :snapshot="snapshot"
      :catalog="catalog"
      :scope="publicScope ? 'offering' : 'account'"
      :initial-model="initialModel"
      @reload="reload"
      @chat="emit('chat')"
      @pick-account="enterSample"
    />
    <p v-else-if="picked && offering && snapshot && !rows.length" class="setting-hint">
      暂无可用模型连接。
    </p>
    <details v-if="snapshot" class="graph-card">
      <summary>预置数据 · {{ snapshot.pack.active }}</summary>
      <div class="graph-actions">
        <input
          ref="packFile"
          type="file"
          accept=".json,application/json"
          class="file-picker"
          aria-label="本地预置包"
          @change="
            ($event.target as HTMLInputElement).files?.[0] &&
            pack('import', ($event.target as HTMLInputElement).files![0])
          "
        /><button :disabled="packBusy" @click="packFile?.click()">导入本地包</button
        ><button
          :disabled="packBusy || !snapshot.pack.updateConfigured"
          :title="snapshot.pack.updateConfigured ? '' : '尚未配置更新源'"
          @click="pack('update')"
        >
          检查并启用更新</button
        ><button :disabled="packBusy || !snapshot.pack.previous" @click="pack('rollback')">
          回滚{{ snapshot.pack.previous ? "至 " + snapshot.pack.previous : "" }}
        </button>
      </div>
    </details>
  </section>
</template>
