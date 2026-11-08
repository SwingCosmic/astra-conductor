<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type {
  ActionAvailability,
  CredentialImportPreview,
  CredentialManagementStatus,
  CredentialExportDelivery,
  ServiceResult,
} from "@astra-conductor/contract/common";
import { useCredentialService } from "../ports/services";

const service = useCredentialService();
const emit = defineEmits<{ close: [] }>();
const confirmingExport = ref(false);
const confirmingRestart = ref(false);
const restartDirectory = ref("");
const status = ref<CredentialManagementStatus | null>(null);
const directory = ref("");
const migrationKey = ref("");
const reentryKey = ref("");
const busy = ref(false);
const message = ref("");
const importKey = ref("");
const preview = ref<(CredentialImportPreview & { vaultDirectory: string }) | null>(null);
const importAvailable = computed(
  () =>
    status.value?.installState === "installed" && capability("verifyImport").state === "enabled",
);
const receiver = computed(() => status.value?.role === "receiver" || status.value?.role === "both");
const source = computed(() => status.value?.role !== "receiver");
const pendingImport = computed(
  () => status.value?.importState === "import-ready" || status.value?.importState === "preparing",
);
function selectedBackendLabel(): string {
  return status.value?.selectedBackend === "shared" ? "共享存储" : "内置存储";
}
function activeBackendLabel(): string {
  return status.value?.activeBackend === "shared"
    ? "共享存储"
    : status.value?.activeBackend === "private"
      ? "内置存储"
      : status.value?.selectedBackend === "shared"
        ? "共享存储暂不可用"
        : "内置存储暂不可用";
}
function sharedConnectionMessage(): string {
  if (status.value?.activeBackend === "shared" && status.value.connected !== false)
    return "共享凭据已连接";
  if (pendingImport.value)
    return status.value?.activeBackend === "private"
      ? "导入已就绪，等待来源应用启用共享；当前继续使用内置存储。"
      : "导入已就绪，等待来源应用启用共享。";
  return "已检查共享连接，当前仍不可用，请查看当前状态与最近错误。";
}
let disposed = false;
let generation = 0;
let statusRequest = 0;
let directoryEdited = false;
let unsubscribe: (() => void) | undefined;
function capability(name: string): ActionAvailability {
  return status.value?.capabilities?.[name] ?? { state: "enabled" };
}
function capabilityReason(name: string): string | undefined {
  const action = capability(name);
  return action.state === "disabled" ? action.reason : undefined;
}
function verifyImport(): void {
  if (!importAvailable.value || busy.value) return;
  const key = importKey.value;
  const vaultDirectory = directory.value;
  importKey.value = "";
  preview.value = null;
  const requestGeneration = generation;
  void perform(async () => {
    const next = unwrap(await service.verifyImport({ vaultDirectory, migrationKey: key }));
    if (!disposed && requestGeneration === generation) {
      preview.value = { ...next, vaultDirectory };
      message.value = "目录验证成功，仍需确认下方导入预览；当前绑定尚未更改。";
    }
  });
}
function confirmImport(): void {
  const selected = preview.value;
  if (
    !selected ||
    capability("confirmImport").state !== "enabled" ||
    status.value?.installState !== "installed"
  )
    return;
  const started = generation;
  void perform(async () => {
    const result = await service.confirmImport(selected.previewId);
    if (!result.ok) {
      if (
        !disposed &&
        started === generation &&
        (result.error.code === "import-preview-expired" || result.error.code === "preview-expired")
      )
        preview.value = null;
      throw new Error(result.error.message);
    }
    if (disposed || started !== generation) return;
    preview.value = null;
    directoryEdited = false;
    await load();
    if (!disposed) message.value = sharedConnectionMessage();
  });
}
function cancelPreview(): void {
  preview.value = null;
  importKey.value = "";
  void perform(async () => {
    unwrap(await service.cancelPreview());
  });
}
function retry(): void {
  const started = generation;
  void perform(async () => {
    unwrap(await service.retry());
    if (disposed || started !== generation) return;
    await load();
    if (!disposed) message.value = sharedConnectionMessage();
  });
}
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
  if (!service || disposed) return;
  const started = generation;
  const request = ++statusRequest;
  const next = unwrap(await service.getStatus());
  if (disposed || started !== generation || request !== statusRequest) return;
  const instanceChanged = Boolean(
    status.value?.instanceId && status.value.instanceId !== next.instanceId,
  );
  if (instanceChanged || (status.value?.contextId && status.value.contextId !== next.contextId)) {
    generation += 1;
    confirmingExport.value = false;
    confirmingRestart.value = false;
    restartDirectory.value = "";
    if (instanceChanged || (next.role !== "receiver" && next.role !== "both")) {
      directoryEdited = false;
      directory.value = next.vaultDirectory ?? "";
    }
    preview.value = null;
    migrationKey.value = "";
    importKey.value = "";
    reentryKey.value = "";
    message.value = "";
  }
  status.value = next;
  if (receiver.value) {
    if (!directoryEdited) directory.value = next.vaultDirectory ?? "";
  } else if (next.vaultDirectory) directory.value = next.vaultDirectory;
}
function close(): void {
  if (
    migrationKey.value &&
    !window.confirm("迁移密钥尚未确认保存。返回后可恢复交付，是否返回设置？")
  )
    return;
  migrationKey.value = "";
  importKey.value = "";
  reentryKey.value = "";
  preview.value = null;
  confirmingRestart.value = false;
  restartDirectory.value = "";
  emit("close");
}
function chooseDirectory(): void {
  const started = generation;
  void perform(async () => {
    const selected = unwrap(await service!.selectDirectory());
    if (!disposed && started === generation && selected) {
      directory.value = selected;
      if (receiver.value) directoryEdited = true;
    }
  });
}
function editImportDirectory(): void {
  directoryEdited = true;
}
async function perform(operation: () => Promise<void>): Promise<void> {
  if (disposed || busy.value) return;
  const started = generation;
  busy.value = true;
  message.value = "";
  try {
    await operation();
  } catch (error) {
    if (!disposed && started === generation)
      message.value = error instanceof Error ? error.message : "操作未完成";
  } finally {
    try {
      await load();
    } catch (error) {
      if (!disposed && started === generation)
        message.value ||= error instanceof Error ? error.message : "状态检查失败";
    }
    if (!disposed) busy.value = false;
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
  const started = generation;
  const instanceId = status.value?.instanceId;
  confirmingExport.value = false;
  migrationKey.value = "";
  void perform(async () => {
    const delivery = unwrap(await service!.exportCredentials(directory.value));
    if (!(await canDeliver(delivery, started, instanceId))) return;
    migrationKey.value = delivery.migrationKey;
    message.value = "导出成功。请保存迁移密钥，再到接收方完成导入。";
  });
}
async function canDeliver(
  delivery: CredentialExportDelivery,
  started: number,
  instanceId: string | undefined,
): Promise<boolean> {
  await load();
  if (disposed || status.value?.instanceId !== instanceId) return false;
  if (status.value?.selectedBackend !== "private" || status.value.activeBackend !== "private")
    return false;
  if (status.value?.storageVersion)
    return (
      status.value.storageVersion === delivery.storageVersion &&
      status.value.exportState === "exported"
    );
  return started === generation;
}
function resumeExport(): void {
  if (!compatibleComponent() || capability("resumeExport").state !== "enabled") return;
  const started = generation;
  const instanceId = status.value?.instanceId;
  migrationKey.value = "";
  void perform(async () => {
    const delivery = unwrap(await service.resumeExport());
    if (delivery) {
      if (!(await canDeliver(delivery, started, instanceId))) return;
      migrationKey.value = delivery.migrationKey;
    } else {
      await load();
      if (
        disposed ||
        status.value?.instanceId !== instanceId ||
        status.value?.exportState !== "exported" ||
        status.value.selectedBackend !== "private"
      )
        return;
    }
    message.value = delivery
      ? "已恢复原导出，请保存迁移密钥后继续共享切换。"
      : "已恢复原导出记录，迁移密钥已经确认交付，可继续共享切换。";
  });
}
function chooseRestartDirectory(): void {
  const started = generation;
  void perform(async () => {
    const selected = unwrap(await service.selectDirectory());
    if (!disposed && started === generation && selected) {
      restartDirectory.value = selected;
      confirmingRestart.value = true;
    }
  });
}
function restartExport(): void {
  if (!compatibleComponent() || capability("restartExport").state !== "enabled") return;
  const selected = restartDirectory.value;
  if (!selected) return;
  const started = generation;
  const instanceId = status.value?.instanceId;
  confirmingRestart.value = false;
  migrationKey.value = "";
  void perform(async () => {
    const delivery = unwrap(await service.restartExport(selected));
    if (!(await canDeliver(delivery, started, instanceId))) return;
    migrationKey.value = delivery.migrationKey;
    restartDirectory.value = "";
    message.value = "已从当前内置凭据重新导出，请保存本次迁移密钥并重新导入。";
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
    unwrap(await service!.cancelExport());
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
  restartDirectory.value = "";
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
  unsubscribe = service.subscribe(() => {
    void load().catch((error: unknown) => {
      if (!disposed) message.value = error instanceof Error ? error.message : "状态检查失败";
    });
  });
  void perform(async () => {
    await load();
  });
});
onUnmounted(() => {
  disposed = true;
  generation += 1;
  unsubscribe?.();
  importKey.value = "";
  preview.value = null;
  migrationKey.value = "";
  reentryKey.value = "";
});
</script>

<template>
  <section class="content-page credential-storage-manager" aria-label="凭据存储管理">
    <header class="content-header">
      <div>
        <h1>凭据存储管理</h1>
        <p>管理独立组件、账号凭据与共享存储</p>
      </div>
      <div class="sharing-actions">
        <button class="outline-action" :disabled="busy" @click="perform(load)">重新检查</button>
        <button class="outline-action" :disabled="busy" @click="close">返回设置</button>
      </div>
    </header>
    <p v-if="!service" class="setting-hint">当前连接未提供凭据共享功能。</p>
    <p v-if="busy" role="status">正在处理…</p>
    <p v-if="message" class="setting-hint" role="status">{{ message }}</p>
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
          {{
            receiver
              ? "输入来源应用导出的共享目录并验证导入；组件安装成功不代表共享已经接管。"
              : "选择目录并导出时自动登记和启动服务，组件安装成功不代表服务正在运行。"
          }}
        </p>
        <p v-else class="path-value">共享目录：{{ status.vaultDirectory }}</p>
      </section>
      <section v-if="receiver" class="settings-card" aria-label="接收共享凭据">
        <h2>接收共享凭据</h2>
        <p class="setting-hint" role="status">
          {{
            preview
              ? "导入预览待确认，当前绑定尚未更改"
              : status.activeBackend === "shared" && status.connected !== false
                ? "共享已连接"
                : status.importState === "import-ready"
                  ? "导入就绪，等待共享接管"
                  : status.importState === "preparing"
                    ? "正在准备导入"
                    : "尚未导入共享凭据"
          }}
        </p>
        <div class="setting-row">
          <span><strong>已确认绑定目录</strong><small>确认新导入后才会更新此绑定</small></span>
          <code class="path-value" aria-label="已确认绑定目录">{{
            status.vaultDirectory ?? "尚未确认绑定"
          }}</code>
        </div>
        <div class="setting-row">
          <span
            ><strong>所选凭据存储</strong
            ><small>{{
              status.privateAvailable === false
                ? "当前宿主未提供可用的本端私有存储"
                : "支持本端私有存储与共享凭据"
            }}</small></span
          >
          <span>{{ selectedBackendLabel() }}</span>
        </div>
        <div class="setting-row">
          <span><strong>实际凭据后端</strong><small>供应商操作使用此处显示的后端</small></span>
          <span>{{ activeBackendLabel() }}</span>
        </div>
        <p v-if="pendingImport" class="setting-hint" role="status">
          当前已确认绑定的共享凭据仍处于预备状态，尚未用于供应商操作。来源应用启用共享后再重试连接。
          <template v-if="status.activeBackend === 'private'">
            当前继续使用内置存储，可在服务商页管理本端账号；这些账号与待接管的共享记录独立。
          </template>
        </p>
        <p
          v-if="status.selectedBackend === 'shared' && status.activeBackend === 'unavailable'"
          class="setting-hint"
          role="status"
        >
          已选择共享存储，但当前连接不可用。导入记录不代表已经恢复连接，也不会自动改用内置存储。
        </p>
        <p v-if="capabilityReason('verifyImport')" class="setting-hint" role="status">
          {{ capabilityReason("verifyImport") }}
        </p>
        <form class="key-delivery" @submit.prevent="verifyImport">
          <label
            >服务端共享目录<input
              v-model="directory"
              :disabled="busy || !importAvailable"
              autocomplete="off"
              aria-label="导入目录"
              @input="editImportDirectory"
          /></label>
          <button
            v-if="status.directorySelectionAvailable"
            type="button"
            class="outline-action"
            :disabled="busy"
            @click="chooseDirectory"
          >
            选择文件夹
          </button>
          <label
            >迁移密钥<input
              v-model="importKey"
              type="password"
              :disabled="busy || !importAvailable"
              autocomplete="off"
              spellcheck="false"
              aria-label="导入迁移密钥"
          /></label>
          <p class="setting-hint">目录位于运行应用服务的机器。验证后仅显示脱敏账号预览。</p>
          <button
            class="primary-action"
            :disabled="busy || !directory || !importKey || !importAvailable"
          >
            验证导入
          </button>
        </form>
        <section v-if="preview" class="key-delivery" aria-label="导入预览">
          <h3>确认导入 {{ preview.recordCount }} 条凭据</h3>
          <p>
            待确认预览目录：<code class="path-value" aria-label="待确认预览目录">{{
              preview.vaultDirectory
            }}</code>
          </p>
          <p class="setting-hint">验证已通过，仍需确认导入。确认成功前继续保留当前绑定。</p>
          <p v-for="account in preview.accounts" :key="account.id">
            {{ account.provider }} · {{ account.maskedIdentifier }}
          </p>
          <div class="sharing-actions">
            <button
              class="primary-action"
              :disabled="
                busy ||
                status.installState !== 'installed' ||
                capability('confirmImport').state !== 'enabled'
              "
              @click="confirmImport"
            >
              确认导入</button
            ><button class="outline-action" :disabled="busy" @click="cancelPreview">
              取消预览
            </button>
          </div>
        </section>
        <div
          v-if="(status.importState && status.importState !== 'none') || status.rememberedKey"
          class="sharing-actions"
        >
          <button
            class="outline-action"
            :disabled="busy || capability('retry').state !== 'enabled'"
            :title="capabilityReason('retry')"
            @click="retry"
          >
            重试共享连接
          </button>
        </div>
        <h3 v-if="status.accounts?.length">
          {{ pendingImport ? "当前绑定待接管的共享凭据" : "当前绑定共享凭据记录" }}
        </h3>
        <p v-for="account in status.accounts ?? []" :key="account.id" class="path-value">
          {{ account.provider }} · {{ account.maskedIdentifier }}
        </p>
        <p v-if="status.lastError" class="setting-hint" role="status">
          最近错误：{{ status.lastError }}
        </p>
      </section>
      <section
        v-if="source"
        class="settings-card credential-sharing-settings"
        aria-label="导出与存储切换"
      >
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
        <div v-if="status.exportState === 'cancelled'" class="sharing-actions">
          <button
            class="outline-action"
            :disabled="
              busy ||
              status.installState !== 'installed' ||
              capability('resumeExport').state !== 'enabled'
            "
            :title="capabilityReason('resumeExport')"
            @click="resumeExport"
          >
            恢复原导出
          </button>
          <button
            class="primary-action"
            :disabled="
              busy ||
              !status.directorySelectionAvailable ||
              status.installState !== 'installed' ||
              capability('restartExport').state !== 'enabled'
            "
            :title="capabilityReason('restartExport')"
            @click="chooseRestartDirectory"
          >
            选择新目录重新导出
          </button>
        </div>
        <p
          v-if="status.exportState === 'cancelled' && capabilityReason('resumeExport')"
          class="setting-hint"
          role="status"
        >
          {{ capabilityReason("resumeExport") }}
        </p>
        <p
          v-if="status.exportState === 'cancelled' && capabilityReason('restartExport')"
          class="setting-hint"
          role="status"
        >
          {{ capabilityReason("restartExport") }}
        </p>
        <section v-if="confirmingRestart" class="key-delivery" aria-label="确认重新导出">
          <h3>确认从当前内置凭据重新导出</h3>
          <p>
            新导出目录：<code>{{ restartDirectory }}</code>
          </p>
          <p>
            本次将从当前私有凭据生成新的导出。原导出目录、文件和密钥均保留，接收方需要使用本次新目录与迁移密钥重新导入。
          </p>
          <div class="sharing-actions">
            <button
              class="primary-action"
              :disabled="busy || capability('restartExport').state !== 'enabled'"
              @click="restartExport"
            >
              确认重新导出
            </button>
            <button class="outline-action" :disabled="busy" @click="confirmingRestart = false">
              暂不重新导出
            </button>
          </div>
        </section>
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
