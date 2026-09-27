<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import AppSidebar, { type PageId } from "./components/AppSidebar.vue";
import type { IpcResult, PublicAccount, PublicUsage } from "./models";
import { usePolyQuotaService } from "./services/polyquota-service-vue";
import ProvidersView from "./views/ProvidersView.vue";
import SettingsView from "./views/SettingsView.vue";
import UsageView from "./views/UsageView.vue";

const page = ref<PageId>("usage");
const accounts = ref<PublicAccount[]>([]);
const usage = ref<Record<string, PublicUsage | null>>({});
const busy = ref<string | null>(null);
const message = ref("");
const GLOBAL_MESSAGE_DURATION_MS = 5_000;
let messageTimer: ReturnType<typeof setTimeout> | null = null;
const service = usePolyQuotaService();

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

async function load(): Promise<void> {
  accounts.value = unwrap(await service.listAccounts());
  usage.value = Object.fromEntries(
    await Promise.all(
      accounts.value.map(async (account) => [
        account.id,
        unwrap(await service.getUsage(account.id)),
      ]),
    ),
  );
}

async function run(label: string, operation: () => Promise<void>): Promise<void> {
  busy.value = label;
  message.value = "";
  try {
    await operation();
  } catch (error) {
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
    await load();
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
    await load();
    message.value = "用量已刷新";
  });
}

function refreshAll(): void {
  void run("refresh-all", async () => {
    for (const account of accounts.value.filter((item) => item.enabled)) {
      const outcome = unwrap(await service.refreshAccount(account.id)) as { status?: string };
      if (outcome.status === "failed") throw new Error(`${account.maskedIdentifier} 刷新失败`);
    }
    await load();
    message.value = "全部用量已刷新";
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
    await load();
    message.value = outcome.status === "unchanged" ? "令牌仍然有效" : "令牌已刷新";
  });
}

function toggle(account: PublicAccount): void {
  void run(`toggle:${account.id}`, async () => {
    unwrap(await service.setAccountEnabled(account.id, !account.enabled));
    await load();
  });
}

function remove(account: PublicAccount): void {
  if (!window.confirm(`删除 ${account.displayName}？本地加密凭据和用量快照也会一并删除。`)) return;
  void run(`delete:${account.id}`, async () => {
    unwrap(await service.deleteAccount(account.id));
    await load();
  });
}

onMounted(() => void run("load", load));
onBeforeUnmount(() => {
  if (messageTimer) clearTimeout(messageTimer);
});
</script>

<template>
  <div class="app-shell">
    <AppSidebar :page="page" @navigate="page = $event" />
    <main class="main-panel">
      <p v-if="message" class="global-message" role="status">{{ message }}</p>
      <UsageView
        v-if="page === 'usage'"
        :accounts="accounts"
        :usage="usage"
        :busy="busy !== null"
        @refresh="refresh"
        @refresh-all="refreshAll"
        @toggle="toggle"
      />
      <ProvidersView
        v-else-if="page === 'providers'"
        :accounts="accounts"
        :busy="busy !== null"
        @connected="connected"
        @refresh-credentials="refreshCredentials"
        @toggle="toggle"
        @remove="remove"
      />
      <SettingsView v-else />
    </main>
  </div>
</template>
