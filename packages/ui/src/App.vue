<script setup lang="ts">
import { onMounted, ref } from "vue";
import QuotaCard from "./components/QuotaCard.vue";
import type {
  DeviceAuthorization,
  IpcResult,
  PublicAccount,
  PublicUsage,
  Settings,
} from "./models";

const accounts = ref<PublicAccount[]>([]);
const usage = ref<Record<string, PublicUsage | null>>({});
const busy = ref<string | null>(null);
const message = ref("");
const device = ref<DeviceAuthorization | null>(null);
const proxy = ref("正在读取…");
const settings = ref<Settings>({ pollingEnabled: true, pollingIntervalMinutes: 15 });

function api() {
  if (!window.llmUsage) throw new Error("桌面接口不可用，请从 Electron 应用启动");
  return window.llmUsage;
}
function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function load(): Promise<void> {
  accounts.value = unwrap(await api().listAccounts());
  usage.value = Object.fromEntries(
    await Promise.all(
      accounts.value.map(async (account) => [account.id, unwrap(await api().getUsage(account.id))]),
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
function importCli(): void {
  void run("cli", async () => {
    unwrap(await api().importCodexCli());
    await load();
    message.value = "已只读导入 Codex CLI 凭据";
  });
}
function browserLogin(): void {
  void run("browser", async () => {
    unwrap(await api().loginCodexBrowser());
    await load();
    message.value = "浏览器授权完成";
  });
}
function startDevice(): void {
  void run("device-start", async () => {
    device.value = unwrap(await api().startCodexDevice());
    message.value = "浏览器已打开，请输入设备码；完成后回到这里继续";
  });
}
function finishDevice(): void {
  if (!device.value) return;
  void run("device-finish", async () => {
    unwrap(await api().finishCodexDevice(device.value!.sessionId));
    device.value = null;
    await load();
    message.value = "设备授权完成";
  });
}
function refresh(accountId: string): void {
  void run(`refresh:${accountId}`, async () => {
    const outcome = unwrap(await api().refreshAccount(accountId)) as {
      status?: string;
      error?: { message: string };
    };
    if (outcome.status === "failed") throw new Error(outcome.error?.message ?? "刷新失败");
    await load();
    message.value = "用量已刷新";
  });
}
function toggle(account: PublicAccount): void {
  void run(`toggle:${account.id}`, async () => {
    unwrap(await api().setAccountEnabled(account.id, !account.enabled));
    await load();
  });
}
function remove(account: PublicAccount): void {
  if (!window.confirm(`删除 ${account.displayName}？本地加密凭据和用量快照也会一并删除。`)) return;
  void run(`delete:${account.id}`, async () => {
    unwrap(await api().deleteAccount(account.id));
    await load();
  });
}
function saveSettings(): void {
  void run("settings", async () => {
    settings.value = unwrap(await api().saveSettings(settings.value));
    message.value = "设置已保存，轮询间隔将在下次启动后生效";
  });
}
onMounted(() => {
  void run("load", async () => {
    await load();
    settings.value = unwrap(await api().getSettings());
    proxy.value = unwrap(await api().getProxy());
  });
});
</script>

<template>
  <main class="page">
    <header class="page-header">
      <div>
        <h1>订阅用量</h1>
        <p>Codex 凭据只在主进程中读取，并通过系统安全存储加密。</p>
      </div>
      <div class="auth-actions">
        <button :disabled="busy !== null" @click="importCli">导入 Codex CLI</button>
        <button :disabled="busy !== null" @click="browserLogin">浏览器 OAuth</button>
        <button :disabled="busy !== null" @click="startDevice">设备码</button>
      </div>
    </header>
    <section v-if="device" class="notice device-panel">
      <span
        >设备码：<strong>{{ device.userCode }}</strong></span
      ><button :disabled="busy !== null" @click="finishDevice">我已完成授权</button>
    </section>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <section v-if="accounts.length" class="card-grid" aria-label="账号">
      <QuotaCard
        v-for="account in accounts"
        :key="account.id"
        :account="account"
        :usage="usage[account.id] ?? null"
        :busy="busy !== null"
        @refresh="refresh(account.id)"
        @toggle="toggle(account)"
        @remove="remove(account)"
      />
    </section>
    <section v-else class="empty">
      <h2>还没有账号</h2>
      <p>推荐先只读导入本机 Codex CLI 凭据，验证成功后再尝试其他授权方式。</p>
    </section>
    <section class="settings">
      <h2>设置</h2>
      <label
        ><input v-model="settings.pollingEnabled" type="checkbox" /> 启用后台轮询和低额度通知</label
      >
      <label
        >轮询间隔（分钟）<input
          v-model.number="settings.pollingIntervalMinutes"
          type="number"
          min="5"
          max="1440"
      /></label>
      <button :disabled="busy !== null" @click="saveSettings">保存设置</button>
      <p>当前代理：{{ proxy }}</p>
    </section>
  </main>
</template>
