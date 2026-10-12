<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import type { IpcResult, PublicRefreshSchedulerState, Settings } from "../models";
import { systemProxyLabel } from "../presentation";
import { usePolyQuotaService } from "../services/polyquota-service-vue";

const props = defineProps<{ settings: Settings; scheduler: PublicRefreshSchedulerState }>();
const draft = ref<Settings>({ ...props.settings });
const proxy = ref("正在读取…");
const busy = ref(false);
const message = ref("");
const service = usePolyQuotaService();

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function load(): Promise<void> {
  proxy.value = systemProxyLabel(unwrap(await service.getSystemStatus()));
}
async function save(): Promise<void> {
  busy.value = true;
  message.value = "";
  try {
    unwrap(await service.saveSettings(draft.value));
    message.value = "设置已保存";
  } catch (error) {
    message.value = error instanceof Error ? error.message : "保存失败";
  } finally {
    busy.value = false;
  }
}
watch(
  () => props.settings,
  (value) => {
    draft.value = { ...value };
  },
);
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
        ><input v-model="draft.pollingEnabled" type="checkbox" /></label
      ><label class="setting-row"
        ><span><strong>刷新间隔</strong><small>允许 5 到 1440 分钟</small></span
        ><input
          v-model.number="draft.pollingIntervalMinutes"
          type="number"
          min="5"
          max="1440" /></label
      ><label class="setting-row"
        ><span
          ><strong>任务栏显示额度进度</strong
          ><small>关闭后仍保留托盘换色与用量概览双环</small></span
        ><input v-model="draft.taskbarProgressEnabled" type="checkbox"
      /></label>
      <button class="primary-action" :disabled="busy" @click="save">保存设置</button>
      <span v-if="message" class="save-message">{{ message }}</span>
      <p class="setting-hint">
        当前状态：{{ scheduler.status
        }}{{
          scheduler.nextRunAt ? ` · 下次 ${new Date(scheduler.nextRunAt).toLocaleString()}` : ""
        }}
      </p>
    </section>
    <section class="settings-card">
      <h2>网络与代理</h2>
      <div class="setting-row">
        <span
          ><strong>当前代理</strong><small>由桌面主进程读取环境变量与系统代理配置得出</small></span
        ><code>{{ proxy }}</code>
      </div>
    </section>
  </section>
</template>
