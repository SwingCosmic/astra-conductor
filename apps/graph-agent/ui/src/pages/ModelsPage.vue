<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  AppIcon,
  authMethodLabel,
  catalogPresentations,
  CollapsiblePanel,
  RichSelect,
  type RichSelectOption,
} from "@astra-conductor/shared-ui";
import type {
  ProviderManagementSnapshot,
  PublicAccount,
  ModelCatalogView,
  CustomProvider,
  ChangeModelPackRequest,
} from "@astra-conductor/contract/graph-agent";
import { modelEndpointDescriptors } from "@astra-conductor/contract/common";
import { useModelView, sameRoute } from "./model-view";
import { authTagTone, typeLabels } from "./catalog-labels";
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

const providerSelectOptions = computed<RichSelectOption[]>(() =>
  providers.value.map((p) => ({
    value: p.id,
    label: p.name,
    icon: p.icon,
    showMark: true,
  })),
);

const picked = computed(() => providers.value.find((p) => p.id === owner.value));
const customOwner = computed(() => custom.value.find((p) => p.providerId === owner.value));

const offerings = computed(
  () =>
    customOwner.value?.offerings.map((o) => ({ id: o.offeringId, name: o.name })) ??
    builtinRows.value
      .filter((r) => r.provider === owner.value)
      .map((r) => ({ id: r.id, name: r.name })),
);

const offeringSelectOptions = computed<RichSelectOption[]>(() =>
  offerings.value.map((o) => ({
    value: o.id,
    label: o.name,
    iconName: "server",
  })),
);

const rows = computed(() =>
  catalogs.value.filter((c) => c.providerId === owner.value && c.offeringId === offering.value),
);

const accountOptions = computed(() => [
  ...new Map(rows.value.filter((c) => c.accountId).map((c) => [c.accountId, c])).values(),
]);

const accountSelectOptions = computed<RichSelectOption[]>(() => {
  const list: RichSelectOption[] = [];
  if (picked.value && offering.value && !customOwner.value) {
    list.push({
      value: "*",
      label: "全部账号",
      iconName: "users",
      tag: "供应商默认",
      tagTone: "neutral",
    });
  }
  for (const row of accountOptions.value) {
    const info = management.value?.accounts.find((v) => v.id === row.accountId);
    const methodLabel = info ? authMethodLabel(info.authMethod) : undefined;
    list.push({
      value: row.accountId,
      label: row.accountDisplayName,
      subtitle:
        info?.maskedIdentifier && info.maskedIdentifier !== row.accountDisplayName
          ? info.maskedIdentifier
          : undefined,
      iconName: "user",
      tag: methodLabel,
      tagTone: authTagTone(info?.authMethod),
    });
  }
  return list;
});

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
  applyDefaults();
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

const breadcrumb = computed(() => {
  const offeringName = offerings.value.find((o) => o.id === offering.value)?.name;
  const parts = [
    picked.value?.name,
    offerings.value.length > 1 || (offeringName && offeringName !== picked.value?.name)
      ? offeringName
      : null,
    publicScope.value ? "全部账号（供应商默认）" : catalog.value?.accountDisplayName,
    catalog.value ? routeName(catalog.value.protocol) : null,
  ].filter(Boolean);
  return parts.join(" / ");
});

function applyDefaults() {
  if (owner.value && !offering.value && offerings.value.length > 0) {
    offering.value = offerings.value[0]!.id;
  }
  if (owner.value && offering.value && !account.value) {
    if (!customOwner.value) {
      account.value = "*";
    } else if (accountOptions.value.length > 0) {
      account.value = accountOptions.value[0]!.accountId;
    }
  }
  if (account.value && !protocol.value && protocols.value.length === 1) {
    protocol.value = protocols.value[0]!;
  }
  source.value = sources.get(sampleKey()) ?? "";
}
watch([offerings, accountOptions, protocols], applyDefaults, { immediate: true });

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
  applyDefaults();
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
      <div>
        <h1>模型配置</h1>
      </div>
      <div class="header-actions">
        <button v-if="snapshot?.savedSelection" class="outline-action" @click="openSaved">
          打开当前测试模型
        </button>
        <button class="outline-action" @click="emit('providers')">管理供应商</button>
      </div>
    </header>

    <p v-if="loadError || controlsError" role="alert" class="form-message">
      {{ loadError || controlsError }}
      <button
        class="outline-action"
        @click="
          controlsError = '';
          reload();
          directories();
        "
      >
        重新读取
      </button>
    </p>

    <section class="graph-card scope-card">
      <div class="scope-picker">
        <RichSelect
          label="供应商"
          :model-value="owner"
          :options="providerSelectOptions"
          placeholder="选择供应商"
          search-placeholder="搜索供应商"
          empty-text="没有匹配的供应商"
          searchable
          @select="change('owner', $event)"
        />

        <RichSelect
          v-if="picked && offerings.length > 1"
          label="接入点"
          :model-value="offering"
          :options="offeringSelectOptions"
          placeholder="选择接入点"
          @select="change('offering', $event)"
        />

        <RichSelect
          label="账号"
          :model-value="account"
          :options="accountSelectOptions"
          :disabled="!picked || !offering"
          :disabled-placeholder="!picked ? '请先选择供应商' : '请先选择接入点'"
          placeholder="选择账号"
          empty-text="当前接入点暂无可用账号"
          @select="change('account', $event)"
        />

        <label v-if="account && routeTypes.size > 1" class="graph-field">
          模型类型
          <select :value="typeFilter" @change="changeType">
            <option value="">全部类型</option>
            <option v-for="type in routeTypes" :key="type" :value="type">
              {{ typeLabels[type] }}
            </option>
          </select>
        </label>

        <label v-if="account" class="graph-field">
          协议端点
          <select
            :value="protocol"
            :disabled="!account || !protocols.length"
            @change="change('protocol', val($event), $event)"
          >
            <option value="">选择协议</option>
            <option v-for="p in protocols" :key="p" :value="p">{{ routeName(p) }}</option>
          </select>
        </label>
      </div>

      <div v-if="publicScope" class="scope-notice">
        <span class="scope-notice-copy">
          <AppIcon name="info" :size="15" />
          此配置应用于本接入点的所有账号，账号覆盖优先。
        </span>
        <label v-if="protocol" class="scope-sample-picker">
          <span>目录取样账号</span>
          <select :value="catalog?.accountId ?? ''" @change="change('source', val($event), $event)">
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
          </select>
        </label>
      </div>
    </section>

    <CatalogPanel
      v-if="snapshot && catalog"
      ref="panel"
      :key="refreshKey"
      :snapshot="snapshot"
      :catalog="catalog"
      :scope="publicScope ? 'offering' : 'account'"
      :breadcrumb="breadcrumb"
      :initial-model="initialModel"
      @reload="reload"
      @chat="emit('chat')"
      @pick-account="enterSample"
    />

    <div v-else class="scope-empty-state">
      <p v-if="!picked">选择供应商和账号后查看模型</p>
      <p v-else-if="!offering">选择接入点后查看模型</p>
      <p v-else-if="snapshot && !rows.length && customOwner">
        当前接入点尚未绑定账号，请前往供应商页添加账号。
      </p>
      <p v-else-if="!account">选择账号后查看模型</p>
      <p v-else-if="snapshot && !protocols.length">暂无可用模型连接。</p>
      <p v-else>选择协议端点后查看模型</p>
    </div>

    <CollapsiblePanel
      v-if="snapshot"
      class="pack-bar"
      variant="subtle"
      title="预置模型数据"
      :summary="'当前修订 ' + snapshot.pack.active"
    >
      <div class="graph-actions pack-bar-body">
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
        />
        <button class="outline-action" :disabled="packBusy" @click="packFile?.click()">
          导入本地包
        </button>
        <button
          class="outline-action"
          :disabled="packBusy || !snapshot.pack.updateConfigured"
          :title="snapshot.pack.updateConfigured ? '' : '尚未配置更新源'"
          @click="pack('update')"
        >
          检查并启用更新
        </button>
        <button
          class="outline-action"
          :disabled="packBusy || !snapshot.pack.previous"
          @click="pack('rollback')"
        >
          回滚{{ snapshot.pack.previous ? "至 " + snapshot.pack.previous : "" }}
        </button>
      </div>
    </CollapsiblePanel>
  </section>
</template>
