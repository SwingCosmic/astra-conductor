<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { IpcResult, Settings } from "../models";

const settings = ref<Settings>({ pollingEnabled: true, pollingIntervalMinutes: 15 });
const proxy = ref("正在读取…");
const busy = ref(false);
const message = ref("");

function api() {
  if (!window.llmUsage) throw new Error("桌面接口不可用，请从 Electron 应用启动");
  return window.llmUsage;
}
function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function load(): Promise<void> {
  settings.value = unwrap(await api().getSettings());
  proxy.value = unwrap(await api().getProxy());
}
async function save(): Promise<void> {
  busy.value = true;
  message.value = "";
  try {
    settings.value = unwrap(await api().saveSettings(settings.value));
    message.value = "设置已保存";
  } catch (error) {
    message.value = error instanceof Error ? error.message : "保存失败";
  } finally {
    busy.value = false;
  }
}
onMounted(() => void load());
</script>

<template>
  <section class="content-page settings-page">
    <header class="content-header">
      <div>
        <h1>应用设置</h1>
        <p>管理自动刷新、通知与网络参数</p>
      </div>
    </header>
    <section class="settings-card">
      <h2>自动刷新</h2>
      <label class="setting-row"
        ><span><strong>自动刷新用量数据</strong><small>仅刷新已启用账号</small></span
        ><input v-model="settings.pollingEnabled" type="checkbox" /></label
      ><label class="setting-row"
        ><span><strong>刷新间隔</strong><small>允许 5 到 1440 分钟</small></span
        ><input
          v-model.number="settings.pollingIntervalMinutes"
          type="number"
          min="5"
          max="1440" /></label
      ><button class="primary-action" :disabled="busy" @click="save">保存设置</button
      ><span v-if="message" class="save-message">{{ message }}</span>
    </section>
    <section class="settings-card">
      <h2>网络与代理</h2>
      <div class="setting-row">
        <span><strong>当前代理</strong><small>由桌面主进程按系统和环境变量解析</small></span
        ><code>{{ proxy }}</code>
      </div>
    </section>
  </section>
</template>
