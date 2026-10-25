<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AppSidebar, { type PageId } from "./components/AppSidebar.vue";
import type { IpcResult, PolyQuotaSnapshot, PublicAccount, ResetCreditRedemption } from "./models";
import { catalogPresentations } from "./presentation";
import { usePolyQuotaService } from "./services/polyquota-service-vue";
import { useHostService } from "./services/host-service-vue";
import { startBrowserNotifications } from "./services/browser-notifications";
import ProvidersView from "./views/ProvidersView.vue";
import SettingsView from "./views/SettingsView.vue";
import UsageView from "./views/UsageView.vue";

const page = ref<PageId>("usage");
const snapshot = ref<PolyQuotaSnapshot | null>(null);
const accounts = computed(() => snapshot.value?.accounts ?? []);
const usage = computed(() => snapshot.value?.usageByAccountId ?? {});
const providerPresentations = computed(() => catalogPresentations(snapshot.value?.providers));
const busy = ref<string | null>(null);
const message = ref("");
const messageTone = ref<"info" | "success" | "error">("info");
const GLOBAL_MESSAGE_DURATION_MS = 8_000;
let messageTimer: ReturnType<typeof setTimeout> | null = null;
const service = usePolyQuotaService();
const host = useHostService();
let stopNotifications: (() => void) | undefined;
let unsubscribe: (() => void) | null = null;
let snapshotRequest: Promise<void> | null = null;
let highestObservedRevision = 0;
let observedInstance: string | null = null;
let generation = 0;
let disposed = false;

watch(message, (value) => {
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = value
    ? setTimeout(() => {
        message.value = "";
      }, GLOBAL_MESSAGE_DURATION_MS)
    : null;
});

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function reloadSnapshot(targetRevision = snapshot.value?.revision ?? 0): Promise<void> {
  highestObservedRevision = Math.max(highestObservedRevision, targetRevision);
  if (snapshotRequest) return snapshotRequest;
  let succeeded = false;
  snapshotRequest = (async () => {
    for (;;) {
      const requestedGeneration = generation;
      const next = unwrap(await service.getSnapshot());
      if (disposed) return;
      if (requestedGeneration !== generation) continue;
      if (observedInstance && next.instanceId !== observedInstance) return;
      observedInstance ??= next.instanceId;
      if (
        !snapshot.value ||
        next.instanceId !== snapshot.value.instanceId ||
        next.revision >= snapshot.value.revision
      )
        snapshot.value = next;
      if ((snapshot.value?.revision ?? 0) >= highestObservedRevision) break;
    }
    succeeded = true;
  })().finally(() => {
    snapshotRequest = null;
    if (succeeded && !disposed && (snapshot.value?.revision ?? 0) < highestObservedRevision) {
      void reloadSnapshot(highestObservedRevision).catch((error: unknown) => {
        message.value = error instanceof Error ? error.message : "状态更新失败";
      });
    }
  });
  return snapshotRequest;
}

async function run(label: string, operation: () => Promise<void>): Promise<void> {
  busy.value = label;
  message.value = "";
  messageTone.value = "info";
  try {
    await operation();
  } catch (error) {
    messageTone.value = "error";
    message.value = error instanceof Error ? error.message : "操作失败";
  } finally {
    busy.value = null;
  }
}

function connected(account: PublicAccount): void {
  void run("connected", async () => {
    const outcome = unwrap(await service.refreshAccount(account.id)) as {
      status?: string;
      error?: { message: string };
    };
    await reloadSnapshot();
    message.value =
      outcome.status === "failed"
        ? `账号已接入，但首次刷新失败：${outcome.error?.message ?? "未知错误"}`
        : "账号已接入并刷新用量";
  });
}

function refresh(account: PublicAccount): void {
  void run(`refresh:${account.id}`, async () => {
    const outcome = unwrap(await service.refreshAccount(account.id)) as {
      status?: string;
      error?: { message: string };
    };
    if (outcome.status === "failed") throw new Error(outcome.error?.message ?? "刷新失败");
    await reloadSnapshot();
    message.value = "用量已刷新";
  });
}

function refreshAll(): void {
  void run("refresh-all", async () => {
    const batch = unwrap(await service.refreshAll());
    await reloadSnapshot();
    const failures = batch.outcomes.filter((outcome) => outcome.status === "failed").length;
    message.value = failures ? `刷新完成，${failures} 个账号失败` : "全部用量已刷新";
  });
}

function refreshCredentials(account: PublicAccount): void {
  void run(`credentials:${account.id}`, async () => {
    const outcome = unwrap(await service.refreshCredentials(account.id)) as {
      status?: string;
      error?: { message: string };
    };
    if (outcome.status === "failed") {
      throw new Error(outcome.error?.message ?? "令牌刷新失败");
    }
    await reloadSnapshot();
    message.value = outcome.status === "unchanged" ? "令牌仍然有效" : "令牌已刷新";
  });
}

function useResetCredit(account: PublicAccount, redemption: ResetCreditRedemption): void {
  void run(`redeem:${account.id}`, async () => {
    const outcome = unwrap(await service.redeemResetCredit(account.id, redemption));
    await reloadSnapshot();
    messageTone.value = "success";
    const remaining =
      outcome.remainingResetCredits === null ? "" : `，剩余 ${outcome.remainingResetCredits} 次`;
    message.value =
      outcome.refreshStatus === "updated"
        ? `重置额度使用成功${remaining}`
        : `重置额度使用成功${remaining}；服务商最新用量暂未刷新`;
  });
}

function toggle(account: PublicAccount): void {
  void run(`toggle:${account.id}`, async () => {
    unwrap(await service.setAccountEnabled(account.id, !account.enabled));
    await reloadSnapshot();
  });
}

function remove(account: PublicAccount): void {
  if (!window.confirm(`删除 ${account.displayName}？本地加密凭据和用量快照也会一并删除。`)) return;
  void run(`delete:${account.id}`, async () => {
    unwrap(await service.deleteAccount(account.id));
    await reloadSnapshot();
  });
}

function connect(): void {
  void run("load", async () => {
    if (!unsubscribe) {
      if (host) {
        const capabilities = unwrap(await host.getCapabilities());
        if (disposed) return;
        if (capabilities.notifications === "browser")
          stopNotifications = startBrowserNotifications(host);
      }
      unsubscribe = service.subscribe((event) => {
        if (observedInstance !== event.instanceId) {
          observedInstance = event.instanceId;
          highestObservedRevision = 0;
          generation += 1;
          snapshot.value = null;
        }
        if (!event.resync && event.revision <= (snapshot.value?.revision ?? -1)) return;
        void reloadSnapshot(event.revision).catch((error: unknown) => {
          message.value = error instanceof Error ? error.message : "状态更新失败";
        });
      });
    }
    await service.waitForEvents?.();
    if (!disposed) await reloadSnapshot();
  });
}
onMounted(connect);
onBeforeUnmount(() => {
  disposed = true;
  unsubscribe?.();
  stopNotifications?.();
  if (messageTimer) clearTimeout(messageTimer);
});
</script>

<template>
  <div class="app-shell">
    <AppSidebar :page="page" @navigate="page = $event" />
    <main class="main-panel">
      <p
        v-if="message"
        class="global-message"
        :class="`message-${messageTone}`"
        :role="messageTone === 'error' ? 'alert' : 'status'"
        aria-live="assertive"
      >
        {{ message }}
      </p>
      <button
        v-if="!snapshot && busy === null"
        class="secondary-action reconnect-action"
        @click="connect"
      >
        重新连接服务
      </button>
      <UsageView
        v-if="page === 'usage'"
        :accounts="accounts"
        :usage="usage"
        :busy="busy !== null"
        :providers="snapshot?.providers ?? []"
        :remaining="snapshot?.compositeRemaining"
        @refresh="refresh"
        @refresh-all="refreshAll"
        @redeem="useResetCredit"
        @toggle="toggle"
      />
      <ProvidersView
        v-else-if="page === 'providers'"
        :accounts="accounts"
        :presentations="providerPresentations"
        :busy="busy !== null"
        @connected="connected"
        @refresh-credentials="refreshCredentials"
        @toggle="toggle"
        @remove="remove"
      />
      <SettingsView
        v-else-if="snapshot"
        :settings="snapshot.settings"
        :scheduler="snapshot.scheduler"
      />
    </main>
  </div>
</template>
