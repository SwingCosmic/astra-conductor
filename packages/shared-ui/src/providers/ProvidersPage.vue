<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from "vue";
import AuthDialog from "./AuthDialog.vue";
import ConnectionDialog from "./ConnectionDialog.vue";
import ProviderMark from "../components/ProviderMark.vue";
import ChevronIcon from "../components/ChevronIcon.vue";
import type { PublicAccount } from "@astra-conductor/contract/common";
import { authMethodLabel, type ProviderPresentation } from "../presentation";

import type {
  ActionAvailability,
  CommandContext,
  OfferingRouteConfig,
  ProviderManagementSnapshot,
  ServiceResult,
} from "@astra-conductor/contract/common";
import { useProviderService } from "../ports/services";
import { catalogPresentations } from "../presentation";
const props = defineProps<{ hideCompatibleTemplate?: boolean; focusAccount?: PublicAccount }>();
const emit = defineEmits<{ connected: [account: PublicAccount] }>();
const service = useProviderService();
const snapshot = ref<ProviderManagementSnapshot | null>(null);
const accounts = computed(() => snapshot.value?.accounts ?? []);
const presentations = computed(() =>
  catalogPresentations(snapshot.value?.providers).filter(
    (row) => !(props.hideCompatibleTemplate && row.id === "compatible-api-key"),
  ),
);
const busy = ref(false);
const message = ref("");
function context(): CommandContext | undefined {
  const current = snapshot.value;
  return current
    ? { instanceId: current.instanceId, contextId: current.backend.contextId }
    : undefined;
}
function action(name: string, account?: PublicAccount): ActionAvailability {
  return (
    (account
      ? snapshot.value?.connections.find((connection) => connection.accountId === account.id)
          ?.actions[name]
      : undefined) ??
    snapshot.value?.actions[name] ?? { state: "disabled", reason: "服务尚未声明此操作能力" }
  );
}
function actionReason(name: string, account?: PublicAccount): string | undefined {
  const value = action(name, account);
  return value.state === "disabled" ? value.reason : undefined;
}
let unsubscribe: (() => void) | undefined;
let disposed = false;
let generation = 0;
let observedInstance: string | null = null;
let desiredRevision = 0;
let focusRestored = false;
let loading: Promise<void> | null = null;
function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function reload(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    for (;;) {
      const started = generation;
      const next = unwrap(await service.getSnapshot());
      if (disposed) return;
      if (started !== generation) continue;
      if (observedInstance && next.instanceId !== observedInstance) return;
      observedInstance ??= next.instanceId;
      if (!snapshot.value || next.revision >= snapshot.value.revision) {
        if (snapshot.value && snapshot.value.backend.contextId !== next.backend.contextId) {
          modalProvider.value = null;
          connectionDialog.value = null;
        }
        snapshot.value = next;
        if (props.focusAccount && !focusRestored) {
          focusRestored = true;
          expanded.value = new Set([...expanded.value, props.focusAccount.offeringId]);
          await nextTick();
          document.getElementById("model-for-" + props.focusAccount.id)?.focus();
        }
      }
      if (next.revision >= desiredRevision) return;
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}
async function run(operation: () => Promise<void>): Promise<void> {
  if (busy.value || disposed) return;
  busy.value = true;
  message.value = "";
  try {
    await operation();
    if (!disposed) await reload();
  } catch (error) {
    if (!disposed) message.value = error instanceof Error ? error.message : "操作失败";
  } finally {
    if (!disposed) busy.value = false;
  }
}
function toggle(account: PublicAccount): void {
  void run(async () => {
    unwrap(await service.setAccountEnabled(account.id, !account.enabled, context()));
  });
}
function remove(account: PublicAccount): void {
  const baseline = context();
  const expectedRecordRevision = snapshot.value?.connections.find(
    (connection) => connection.accountId === account.id,
  )?.recordRevision;
  if (!baseline || !expectedRecordRevision) return;
  if (!window.confirm(`删除 ${account.displayName}？本端账号与关联凭据将一并删除。`)) return;
  void run(async () => {
    unwrap(await service.deleteAccount(account.id, { ...baseline, expectedRecordRevision }));
  });
}
function refreshCredentials(account: PublicAccount): void {
  void run(async () => {
    const result = unwrap(await service.refreshCredentials(account.id, context()));
    if (result.status === "failed") throw new Error(result.error?.message ?? "令牌刷新失败");
    message.value = result.status === "unchanged" ? "令牌仍然有效" : "令牌已刷新";
  });
}
function connected(account: PublicAccount): void {
  modalProvider.value = null;
  emit("connected", account);
  void run(async () => {});
}
onMounted(() => {
  unsubscribe = service.subscribe((event) => {
    if (observedInstance !== event.instanceId) {
      observedInstance = event.instanceId;
      generation += 1;
      desiredRevision = 0;
      snapshot.value = null;
      modalProvider.value = null;
      connectionDialog.value = null;
    }
    if (!event.resync && event.revision <= (snapshot.value?.revision ?? -1)) return;
    desiredRevision = Math.max(desiredRevision, event.revision);
    void reload().catch((error: unknown) => {
      if (!disposed) message.value = error instanceof Error ? error.message : "状态更新失败";
    });
  });
  void run(async () => {});
});
onBeforeUnmount(() => {
  disposed = true;
  generation += 1;
  unsubscribe?.();
});
const modalProvider = ref<ProviderPresentation | null>(null);
const connectionDialog = ref<{
  context: CommandContext;
  accountId?: string;
  offeringId?: string;
  providerId?: string;
  offeringLabel?: string;
  routeConfig?: OfferingRouteConfig;
} | null>(null);
const expanded = ref(new Set<string>(["codex"]));

function addAction(provider: ProviderPresentation) {
  return provider.connectionKind || provider.id === "compatible-api-key"
    ? "createConnection"
    : "startAuth";
}
function openConnection(provider: ProviderPresentation, accountId?: string) {
  const baseline = context();
  if (baseline)
    connectionDialog.value = {
      context: baseline,
      accountId,
      offeringId: provider.id,
      providerId: provider.provider,
      offeringLabel: provider.name,
      routeConfig: provider.routeConfig,
    };
}
function addAccount(provider: ProviderPresentation) {
  if (addAction(provider) === "createConnection") openConnection(provider);
  else modalProvider.value = provider;
}
function connectionSaved() {
  connectionDialog.value = null;
  void run(async () => {});
}

function providerAccounts(provider: ProviderPresentation): PublicAccount[] {
  return accounts.value.filter(
    (account) => account.provider === provider.provider && account.offeringId === provider.id,
  );
}

function accountMethodLabel(provider: ProviderPresentation, account: PublicAccount): string {
  return (
    provider.authMethods.find((method) => method.id === account.authMethod)?.label ??
    authMethodLabel(account.authMethod)
  );
}

function toggleExpanded(provider: ProviderPresentation): void {
  const next = new Set(expanded.value);
  if (next.has(provider.id)) next.delete(provider.id);
  else next.add(provider.id);
  expanded.value = next;
}

function hasRefreshableToken(account: PublicAccount): boolean {
  return action("refreshCredentials", account).state !== "hidden";
}

function tokenExpiryLabel(value: string | null): string {
  if (!value) return "未提供";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function isTokenExpired(value: string | null): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

const connectedCount = computed(
  () =>
    new Set(accounts.value.map((account) => JSON.stringify([account.provider, account.offeringId])))
      .size,
);
</script>

<template>
  <section class="content-page providers-page">
    <header class="content-header">
      <div>
        <h1>服务商接入</h1>
        <p>管理服务商与账号接入方式 · 已接入 {{ connectedCount }} 个服务</p>
      </div>
    </header>
    <p v-if="message" class="form-message" role="status">{{ message }}</p>
    <button v-if="!snapshot && !busy" class="outline-action" @click="run(async () => {})">
      重新连接服务
    </button>
    <p v-if="actionReason('startAuth')" class="setting-hint" role="status">
      {{ actionReason("startAuth") }}
    </p>
    <slot name="custom-providers" :snapshot="snapshot" :reload="reload" />
    <div class="provider-list">
      <article v-for="provider in presentations" :key="provider.id" class="provider-row">
        <div class="provider-summary">
          <ProviderMark :name="provider.name" :icon="provider.icon" />
          <div class="provider-heading">
            <div class="provider-name-row">
              <h2>{{ provider.name }}</h2>
              <p class="provider-status">
                <span
                  class="status-dot"
                  :class="{ connected: providerAccounts(provider).length }"
                />{{
                  providerAccounts(provider).length
                    ? `已接入 · ${providerAccounts(provider).length} 个账号`
                    : "尚未接入"
                }}
              </p>
            </div>
            <p class="provider-description">{{ provider.description }}</p>
          </div>
          <div class="method-chips">
            <span v-for="method in provider.authMethods" :key="method.id">{{ method.label }}</span>
          </div>
          <button
            v-if="action(addAction(provider)).state !== 'hidden'"
            class="primary-action"
            :disabled="busy || action(addAction(provider)).state !== 'enabled'"
            :title="actionReason(addAction(provider))"
            @click="addAccount(provider)"
          >
            添加账号
          </button>
          <button
            class="icon-button"
            :disabled="!providerAccounts(provider).length"
            :aria-label="expanded.has(provider.id) ? '收起账号' : '展开账号'"
            :aria-expanded="expanded.has(provider.id)"
            @click="toggleExpanded(provider)"
          >
            <ChevronIcon :collapsed="!expanded.has(provider.id)" />
          </button>
        </div>
        <div
          v-if="expanded.has(provider.id) && providerAccounts(provider).length"
          class="provider-accounts"
        >
          <div
            v-for="account in providerAccounts(provider)"
            :key="account.id"
            class="provider-account-row"
          >
            <span class="account-avatar">♙</span>
            <div class="account-identity">
              <strong>{{
                provider.id === "compatible-api-key"
                  ? account.displayName
                  : account.maskedIdentifier
              }}</strong>
              <span
                v-if="account.tokenExpiresAt"
                class="token-expiry"
                :class="{ expired: isTokenExpired(account.tokenExpiresAt) }"
              >
                令牌到期：{{ tokenExpiryLabel(account.tokenExpiresAt)
                }}{{ isTokenExpired(account.tokenExpiresAt) ? "（已过期）" : "" }}
              </span>
            </div>
            <span class="method-chip">{{ accountMethodLabel(provider, account) }}</span
            ><span class="account-state"
              ><i :class="{ off: !account.enabled }" />{{
                account.enabled ? "已启用" : "已停用"
              }}</span
            ><button
              v-if="
                (provider.connectionKind || provider.id === 'compatible-api-key') &&
                action('editConnection', account).state !== 'hidden'
              "
              :disabled="busy || action('editConnection', account).state !== 'enabled'"
              :title="actionReason('editConnection', account)"
              @click="openConnection(provider, account.id)"
            >
              编辑连接</button
            ><button
              v-if="hasRefreshableToken(account)"
              :disabled="busy || action('refreshCredentials', account).state !== 'enabled'"
              :title="actionReason('refreshCredentials', account)"
              @click="refreshCredentials(account)"
            >
              刷新令牌</button
            ><button
              v-if="action('setAccountEnabled', account).state !== 'hidden'"
              :disabled="busy || action('setAccountEnabled', account).state !== 'enabled'"
              :title="actionReason('setAccountEnabled', account)"
              @click="toggle(account)"
            >
              {{ account.enabled ? "停用" : "启用" }}</button
            ><button
              v-if="action('deleteAccount', account).state !== 'hidden'"
              class="danger-text"
              :disabled="busy || action('deleteAccount', account).state !== 'enabled'"
              :title="actionReason('deleteAccount', account)"
              @click="remove(account)"
            >
              删除
            </button>
            <slot
              name="account-actions"
              :account="account"
              :provider="provider"
              :connection="snapshot?.connections.find((row) => row.accountId === account.id)"
            />
          </div>
        </div>
      </article>
    </div>
    <AuthDialog
      v-if="modalProvider"
      :provider="modalProvider"
      :context="context()"
      @close="modalProvider = null"
      @connected="connected"
    />
    <ConnectionDialog
      v-if="connectionDialog"
      v-bind="connectionDialog"
      @close="connectionDialog = null"
      @saved="connectionSaved"
    />
  </section>
</template>
