<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import type { CredentialSharingStatus, ServiceResult } from "@astra-conductor/polyquota-contract";
import { usePolyQuotaService } from "../services/polyquota-service-vue";

const service = usePolyQuotaService().credentialSharing;
const emit = defineEmits<{ close: [] }>();
const confirmingExport = ref(false);
const status = ref<CredentialSharingStatus | null>(null);
const directory = ref("");
const migrationKey = ref("");
const reentryKey = ref("");
const busy = ref(false);
const message = ref("");
const packageLabels = {
  missing: "未放置本地包",
  ready: "本地包已就绪",
  invalid: "本地包不完整或不兼容",
  unknown: "尚未检查",
};
const installedLabels = {
  "not-installed": "未安装",
  installed: "已安装",
  damaged: "安装损坏",
  incompatible: "不兼容",
  unknown: "无法确认",
};
const exportLabels = {
  none: "尚未导出",
  preparing: "正在准备，可重试",
  pending: "结果待确认，可重试",
  exported: "导出成功，等待建立共享",
  cancelled: "已取消切换，保留原导出记录",
};
const serviceLabels: Record<string, string> = {
  NOT_CHECKED: "尚未检查运行状态",
  NOT_REGISTERED: "共享目录尚未注册",
  STOPPED: "未运行",
  UNAVAILABLE: "暂不可达",
  STARTING: "正在启动",
  READY: "就绪",
  IDLE: "空闲",
  LOCKED: "已锁定",
  DRAINING: "正在停止",
  FAILED: "运行失败",
};
const ownershipLabels: Record<string, string> = {
  NOT_CHECKED: "待检查",
  source: "来源应用",
  broker: "共享服务",
  uninitialized: "尚未初始化",
};
function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function load(): Promise<void> {
  if (!service) return;
  status.value = unwrap(await service.getStatus());
  if (status.value.vaultDirectory) directory.value = status.value.vaultDirectory;
}
function close(): void {
  if (
    migrationKey.value &&
    !window.confirm("迁移密钥尚未确认保存。返回后可恢复交付，是否返回设置？")
  )
    return;
  emit("close");
}
function chooseDirectory(): void {
  void perform(async () => {
    const selected = unwrap(await service!.selectDirectory());
    if (selected) directory.value = selected;
  });
}
async function perform(operation: () => Promise<void>): Promise<void> {
  busy.value = true;
  message.value = "";
  try {
    await operation();
  } catch (error) {
    message.value = error instanceof Error ? error.message : "操作未完成";
  } finally {
    try {
      await load();
    } catch (error) {
      message.value ||= error instanceof Error ? error.message : "状态检查失败";
    }
    busy.value = false;
  }
}
function install(): void {
  void perform(async () => {
    unwrap(await service!.install());
    message.value = "本地安装完成";
  });
}
function uninstall(): void {
  if (
    !window.confirm(
      "卸载将暂停当前用户下所有使用此凭据服务的客户端。共享数据、密钥和绑定会保留，是否继续？",
    )
  )
    return;
  void perform(async () => {
    unwrap(await service!.uninstall());
    message.value = "组件已卸载，共享数据与密钥已保留";
  });
}
function exportCredentials(): void {
  if (!compatibleComponent()) return;
  confirmingExport.value = false;
  migrationKey.value = "";
  void perform(async () => {
    const delivery = unwrap(await service!.exportCredentials(directory.value));
    migrationKey.value = delivery.migrationKey;
    message.value = "导出成功。请保存迁移密钥，再到接收方完成导入。";
  });
}
function acknowledge(): void {
  void perform(async () => {
    unwrap(await service!.acknowledgeDelivery());
    migrationKey.value = "";
    message.value = "已确认保存迁移密钥";
  });
}
function cancel(): void {
  if (
    !window.confirm(
      "取消后本地凭据将恢复独立更新，已成功的导出版本不会被覆盖或重新导出。是否继续？",
    )
  )
    return;
  void perform(async () => {
    unwrap(await service!.cancel());
    migrationKey.value = "";
  });
}
function enableShared(): void {
  if (!compatibleComponent()) return;
  void perform(async () => {
    unwrap(await service!.enableShared());
    message.value = "已启用共享存储";
  });
}
function returnToPrivate(): void {
  if (
    !window.confirm(
      "返回内置后，本应用与共享侧将独立刷新同一供应商凭据。令牌轮换可能使另一侧失效，需要重新授权。将保存可用私有副本并清除本应用记住的共享主密钥，其他客户端继续运行。是否继续？",
    )
  )
    return;
  void perform(async () => {
    unwrap(await service!.returnToPrivate(true));
    message.value = "已返回内置存储，凭据可独立刷新。恢复共享时需重新输入迁移密钥。";
  });
}
function rejoinShared(): void {
  if (!compatibleComponent()) return;
  const key = reentryKey.value;
  reentryKey.value = "";
  void perform(async () => {
    unwrap(await service!.rejoinShared(key));
    message.value = "已恢复本次共享，使用共享侧当前凭据";
  });
}
function compatibleComponent(): boolean {
  if (status.value?.installState === "installed") return true;
  const requirement = status.value
    ? `API ${status.value.requiredApiLevel} 及以上`
    : "当前应用所需的 API";
  message.value = `请先安装支持${requirement}的兼容组件，再导出、启用或恢复共享。`;
  return false;
}
onMounted(() => {
  void perform(async () => {
    await load();
  });
});
onUnmounted(() => {
  migrationKey.value = "";
  reentryKey.value = "";
});
</script>

<template>
  <section class="content-page credential-storage-manager" aria-label="凭据存储管理">
    <header class="content-header">
      <div>
        <h1>凭据存储管理</h1>
        <p>管理独立组件、导出凭据与存储切换</p>
      </div>
      <div class="sharing-actions">
        <button class="outline-action" :disabled="busy" @click="perform(load)">重新检查</button>
        <button class="outline-action" :disabled="busy" @click="close">返回设置</button>
      </div>
    </header>
    <p v-if="!service" class="setting-hint">当前连接未提供凭据共享功能。</p>
    <template v-if="status">
      <section class="settings-card" aria-label="凭据服务组件">
        <h2>凭据服务组件</h2>
        <p v-if="status.installState === 'incompatible'" class="setting-hint" role="status">
          当前凭据共享服务不满足应用的通信或接口要求，请先安装支持 API
          {{ status.requiredApiLevel }}
          及以上的兼容组件，再导出、启用或恢复共享。返回内置存储仍可使用已有私有副本。
        </p>
        <div class="setting-row">
          <span
            ><strong>下载状态</strong
            ><small>自动下载尚未接入，当前使用手动放置的本地包</small></span
          ><span>未启用自动下载</span>
        </div>
        <div class="setting-row">
          <span><strong>本地安装包</strong><small>完整自包含包，包含 component.json</small></span
          ><span>{{ packageLabels[status.localPackageState] }}</span>
        </div>
        <code class="path-value">{{ status.localPackageDirectory }}</code>
        <div class="setting-row">
          <span
            ><strong>组件安装</strong
            ><small v-if="status.installedVersion">版本 {{ status.installedVersion }}</small></span
          ><span>{{ installedLabels[status.installState] }}</span>
        </div>
        <p v-if="status.installationDirectory" class="path-value">
          {{ status.installationDirectory }}
        </p>
        <div class="setting-row">
          <span
            ><strong>API 能力</strong
            ><small>当前组件 API {{ status.installedApiLevel ?? "未声明" }}</small></span
          >
          <span>所需 API {{ status.requiredApiLevel }}</span>
        </div>
        <div class="sharing-actions">
          <button
            class="outline-action"
            :disabled="busy || status.localPackageState !== 'ready'"
            @click="install"
          >
            {{
              status.installState === "installed"
                ? "从本地包重新安装"
                : status.installState === "incompatible"
                  ? "安装兼容本地包"
                  : "安装本地包"
            }}
          </button>
          <button
            v-if="status.installState === 'installed'"
            class="outline-action"
            :disabled="busy || status.localPackageState !== 'ready'"
            @click="uninstall"
          >
            卸载组件
          </button>
        </div>
      </section>
      <section class="settings-card" aria-label="凭据服务运行状态">
        <h2>服务运行</h2>
        <div class="setting-row">
          <span><strong>运行状态</strong><small>独立服务按需启动，空闲后可自动停止</small></span
          ><span>{{
            !status.vaultDirectory
              ? "尚未配置共享目录"
              : (serviceLabels[status.serviceState] ?? "运行状态无法确认")
          }}</span>
        </div>
        <p v-if="!status.vaultDirectory" class="setting-hint">
          选择目录并导出时自动登记和启动服务，组件安装成功不代表服务正在运行。
        </p>
        <p v-else class="path-value">共享目录：{{ status.vaultDirectory }}</p>
      </section>
      <section class="settings-card credential-sharing-settings" aria-label="导出与存储切换">
        <h2>导出与存储切换</h2>
        <div class="setting-row">
          <span
            ><strong>当前凭据存储</strong
            ><small>{{
              status.frozen
                ? "凭据更新已暂停，本地历史仍可查看"
                : status.activeBackend === "shared"
                  ? "按需读取共享凭据，刷新由服务协调许可"
                  : "由本应用独立维护凭据"
            }}</small></span
          ><span>{{
            status.activeBackend === "shared"
              ? "共享存储"
              : status.activeBackend === "unavailable"
                ? "共享存储暂不可用"
                : "内置存储"
          }}</span>
        </div>
        <div v-if="status.exportState !== 'cancelled'" class="setting-row">
          <span
            ><strong>共享凭据更新权</strong
            ><small>{{
              status.sharingState === "private" || status.sharingState === "returning"
                ? "共享库由服务协调；本应用独立更新私有副本"
                : status.sharingState === "active"
                  ? "共享服务协调已连接客户端的凭据更新"
                  : "导出后由来源应用保留，接收方导入后再统一交接"
            }}</small></span
          ><span>{{ ownershipLabels[status.brokerOwnership] ?? "无法确认" }}</span>
        </div>
        <p
          v-if="status.exportState !== 'cancelled' && status.sharingState === 'none'"
          class="setting-hint"
        >
          先导出并保存迁移密钥，再由接收方导入。接收方准备好后，点击启用共享统一交接更新权。
        </p>
        <div class="sharing-directory">
          <strong>{{ status.exportState === "cancelled" ? "原导出目录" : "导出目录" }}</strong>
          <code class="path-value" aria-label="共享目录">{{ directory || "尚未选择文件夹" }}</code>
          <button
            v-if="status.exportState === 'none'"
            class="outline-action"
            :disabled="busy || !status.directorySelectionAvailable"
            @click="chooseDirectory"
          >
            选择文件夹
          </button>
        </div>
        <p v-if="status.exportState === 'none'" class="setting-hint">
          请选择空文件夹。文件夹现有权限保持不变，服务会检查读写能力并加密导出数据。停服后可完整备份和还原。
        </p>
        <p
          v-if="!status.directorySelectionAvailable && status.exportState === 'none'"
          class="setting-hint"
        >
          请在桌面应用中使用系统目录选择器。
        </p>
        <div class="setting-row">
          <span
            ><strong>{{
              status.sharingState === "active"
                ? "已建立共享"
                : status.sharingState === "handoff-pending"
                  ? "共享交接结果待确认"
                  : status.sharingState === "private" || status.sharingState === "returning"
                    ? "已返回内置存储"
                    : exportLabels[status.exportState]
            }}</strong
            ><small>主密钥{{ status.rememberedKey ? "已安全记住" : "尚未记住" }}</small></span
          ><span v-if="status.recordCount">{{ status.recordCount }} 条凭据</span>
        </div>
        <p v-if="!status.available" class="setting-hint">
          当前宿主的系统凭据保护不可用，暂不能导出。
        </p>
        <div
          v-if="!status.deliveryAcknowledged && status.exportState !== 'cancelled'"
          class="sharing-actions"
        >
          <button
            class="primary-action"
            :disabled="
              busy || !status.available || status.installState !== 'installed' || !directory
            "
            @click="status.exportState === 'none' ? (confirmingExport = true) : exportCredentials()"
          >
            {{ status.exportState === "none" ? "准备导出" : "恢复导出与密钥交付" }}
          </button>
        </div>
        <section v-if="confirmingExport" class="key-delivery" aria-label="确认导出">
          <h3>确认导出凭据</h3>
          <p>
            导出到 <code>{{ directory }}</code
            >。导出期间将暂停凭据更新，直到完成共享交接或取消切换。
          </p>
          <p>导出成功后需保存迁移密钥，并在接收方完成导入。</p>
          <div class="sharing-actions">
            <button
              class="primary-action"
              :disabled="busy || status.installState !== 'installed'"
              @click="exportCredentials"
            >
              确认导出</button
            ><button class="outline-action" :disabled="busy" @click="confirmingExport = false">
              暂不导出
            </button>
          </div>
        </section>
        <div v-if="migrationKey" class="key-delivery">
          <label
            >迁移密钥（请妥善保存）<textarea
              :value="migrationKey"
              readonly
              aria-label="迁移密钥"
              spellcheck="false"
            />
          </label>
          <p class="setting-hint">确认保存后关闭密钥交付恢复入口，普通状态查询不会返回密钥。</p>
          <button class="primary-action" :disabled="busy" @click="acknowledge">
            我已保存迁移密钥
          </button>
        </div>
        <p
          v-else-if="
            status.exportState === 'exported' &&
            status.deliveryAcknowledged &&
            status.sharingState === 'none'
          "
          class="setting-hint"
        >
          迁移密钥已确认交付。等待接收方导入与后续统一启用共享。
        </p>
        <p v-if="status.exportState === 'cancelled'" class="setting-hint">
          已恢复使用内置存储独立更新凭据。原导出文件保留，不再用于本次共享切换。
        </p>
        <div
          v-if="status.exportState === 'exported' && status.deliveryAcknowledged"
          class="sharing-actions"
        >
          <button
            v-if="
              status.sharingState === 'none' ||
              status.sharingState === 'handoff-pending' ||
              status.activeBackend === 'unavailable'
            "
            class="primary-action"
            :disabled="busy || status.installState !== 'installed'"
            @click="enableShared"
          >
            {{ status.selectedBackend === "shared" ? "重试共享连接" : "启用共享" }}
          </button>
          <button
            v-if="status.selectedBackend === 'shared' || status.sharingState === 'returning'"
            class="outline-action"
            :disabled="busy"
            @click="returnToPrivate"
          >
            {{ status.sharingState === "returning" ? "重试本地清理" : "返回内置存储" }}
          </button>
        </div>
        <p v-if="status.snapshotAt" class="setting-hint">
          私有副本保存时间：{{
            new Date(status.snapshotAt).toLocaleString()
          }}。服务不可达时可使用此副本，可能落后于共享侧。
        </p>
        <p v-if="status.keyCleanupPending || status.sessionCleanupPending" class="setting-hint">
          已切换本地后端，部分解绑或密钥清理待重试；其他共享客户端不受影响。
        </p>
        <form
          v-if="status.sharingState === 'private' || status.sharingState === 'returning'"
          class="key-delivery"
          @submit.prevent="rejoinShared"
        >
          <label
            >恢复本次共享<input
              v-model="reentryKey"
              type="password"
              :disabled="busy || status.installState !== 'installed'"
              autocomplete="off"
              spellcheck="false"
              aria-label="重新输入迁移密钥"
              placeholder="重新输入迁移密钥"
          /></label>
          <p class="setting-hint">恢复后读取共享侧当前凭据，内置副本的更新不会覆盖共享数据。</p>
          <button
            class="primary-action"
            :disabled="busy || !reentryKey || status.installState !== 'installed'"
          >
            验证并恢复共享
          </button>
        </form>
        <button
          v-if="status.frozen && status.selectedBackend === 'private'"
          class="outline-action"
          :disabled="busy"
          @click="cancel"
        >
          取消共享切换
        </button>
        <p v-if="status.lastError" class="setting-hint">最近错误：{{ status.lastError }}</p>
      </section>
    </template>
    <p v-if="busy" role="status">正在处理…</p>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.setting-hint {
  color: #718096;
  font-size: 13px;
  line-height: 1.7;
}
.path-value {
  color: #52627b;
  font-size: 12px;
  line-height: 1.6;
}
code.path-value {
  padding: 10px 12px;
  background: #f4f7fb;
  border-radius: 7px;
}
.sharing-directory {
  font-size: 13px;
  font-weight: 600;
}
.sharing-directory input,
.key-delivery input,
.key-delivery textarea {
  padding: 10px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  background: white;
  color: #182b49;
  font: inherit;
  font-weight: 400;
}
.sharing-directory input:disabled {
  background: #f8fafc;
  color: #64748b;
}
.key-delivery {
  padding: 14px;
  background: #f4f7fb;
  border-radius: 8px;
}

.path-value {
  display: block;
  overflow-wrap: anywhere;
  margin: 10px 0;
}
.sharing-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin: 14px 0;
}
.sharing-directory {
  display: grid;
  gap: 8px;
  margin: 14px 0;
}
.sharing-directory input {
  width: 100%;
  box-sizing: border-box;
}
.key-delivery {
  margin-top: 18px;
}
.key-delivery label {
  display: grid;
  gap: 8px;
}
.key-delivery input,
.key-delivery textarea {
  width: 100%;
  box-sizing: border-box;
  font-family: monospace;
  resize: none;
}
h3 {
  font-size: 15px;
  margin-top: 24px;
}
</style>
