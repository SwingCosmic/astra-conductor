<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { HostCapabilities } from "@astra-conductor/polyquota-contract";
import { useHostService } from "../services/host-service-vue";
import {
  notificationPermission,
  requestNotificationPermission,
  type NotificationPermissionState,
} from "../services/browser-notifications";

const host = useHostService();
const capabilities = ref<HostCapabilities | null>(null);
const message = ref("");
const permission = ref<NotificationPermissionState>(notificationPermission());
const requesting = ref(false);
let disposed = false;
const permissionLabel = computed(
  () =>
    ({ granted: "已允许", default: "尚未允许", denied: "已阻止", unsupported: "当前浏览器不支持" })[
      permission.value
    ],
);

async function load(): Promise<void> {
  if (!host) return;
  const result = await host.getCapabilities();
  if (disposed) return;
  if (result.ok) capabilities.value = result.value;
  else message.value = result.error.message;
}

async function allowNotifications(): Promise<void> {
  requesting.value = true;
  message.value = "";
  try {
    permission.value = await requestNotificationPermission();
  } catch {
    message.value = "无法申请通知权限，请检查浏览器设置";
  } finally {
    requesting.value = false;
  }
}

onMounted(() => void load());
onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <section v-if="host" class="settings-card host-status">
    <h2>运行能力</h2>
    <template v-if="capabilities">
      <div class="setting-row">
        <span><strong>桌面功能</strong><small>托盘、任务栏与窗口控制</small></span>
        <span>{{ capabilities.desktop ? "可用" : "当前运行环境不提供" }}</span>
      </div>
      <div class="setting-row">
        <span><strong>凭据存储</strong><small>保存账号与解密已有凭据所需的安全存储</small></span>
        <span>{{ capabilities.credentials ? "可用" : "未配置，账号保存与解密暂不可用" }}</span>
      </div>
      <div class="setting-row">
        <span
          ><strong>用量通知</strong
          ><small>{{
            capabilities.notifications === "host" ? "由桌面应用交付" : "仅在此页面连接时交付"
          }}</small></span
        >
        <span v-if="capabilities.notifications === 'host'">系统通知</span>
        <span v-else>{{ permissionLabel }}</span>
      </div>
      <button
        v-if="capabilities.notifications === 'browser' && permission === 'default'"
        class="secondary-action"
        :disabled="requesting"
        @click="allowNotifications"
      >
        允许浏览器通知
      </button>
      <p
        v-if="capabilities.notifications === 'browser' && permission === 'denied'"
        class="setting-hint"
      >
        可在浏览器站点设置中允许通知。
      </p>
    </template>
    <p v-else class="setting-hint">{{ message || "正在读取运行能力…" }}</p>
    <p v-if="message && capabilities" role="alert">{{ message }}</p>
  </section>
</template>
