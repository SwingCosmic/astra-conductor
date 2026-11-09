<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type {
  CredentialImportPreview,
  CredentialManagementStatus,
  ServiceResult,
} from "@astra-conductor/contract/common";
import { useCredentialService } from "../ports/services";

withDefaults(defineProps<{ showBack?: boolean }>(), { showBack: true });
const service = useCredentialService();
const emit = defineEmits<{ close: [] }>();
const status = ref<CredentialManagementStatus | null>(null);
const form = ref<"export" | "import" | null>(null);
const directory = ref("");
const inputKey = ref("");
const delivery = ref("");
const preview = ref<CredentialImportPreview | null>(null);
const busy = ref(false);
const message = ref("");
const failed = ref(false);
const state = computed(() => status.value?.migrationState);
const desktop = computed(() => state.value != null);
const revalidating = ref(false);
const lastFailure = ref("");
const installed = computed(() => status.value?.installState === "installed");
const ready = computed(() => state.value === "export-ready" || state.value === "import-ready");
const activeLabel = computed(
  () =>
    ({ private: "内置存储", shared: "共享存储", unavailable: "暂不可用" })[
      status.value?.activeBackend ?? "unavailable"
    ],
);
const title = computed(() => {
  switch (state.value) {
    case "private":
      return status.value?.keyCleanupPending
        ? "当前使用内置 · 旧共享密钥待清理"
        : "初始 · 内置存储";
    case "export-ready":
      return "导出完成，等待迁移";
    case "import-ready":
      return "导入成功，等待迁移";
    case "shared":
      return status.value?.activeBackend === "shared"
        ? "迁移完成 · 当前使用共享存储"
        : "迁移完成 · 已选共享，当前不可用";
    case "private-ready":
      return "内置写入成功，等待切换";
    default:
      return status.value?.activeBackend === "shared"
        ? "共享凭据已连接"
        : "尚未接入共享 · 凭据不可用";
  }
});
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
let disposed = false;
let request = 0;
let generation = 0;
let unsubscribe: (() => void) | undefined;
function enabled(name: string) {
  const action = status.value?.capabilities?.[name];
  return !action || action.state === "enabled";
}
function value<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function clearDraft() {
  revalidating.value = false;
  form.value = null;
  preview.value = null;
  inputKey.value = "";
  directory.value = "";
  message.value = "";
  failed.value = false;
}
async function load() {
  const n = ++request;
  const next = value(await service.getStatus());
  if (disposed || n !== request) return;
  const prior = status.value;
  if (
    prior &&
    (prior.instanceId !== next.instanceId ||
      (prior.vaultDirectory &&
        next.vaultDirectory &&
        prior.vaultDirectory !== next.vaultDirectory) ||
      (prior.storageVersion && prior.storageVersion !== next.storageVersion))
  ) {
    generation++;
    clearDraft();
    delivery.value = "";
  }
  status.value = next;
  if (
    next.deliveryAcknowledged ||
    (next.migrationState !== "export-ready" && next.migrationState !== "shared")
  )
    delivery.value = "";
  if (next.operation?.kind === "import") {
    revalidating.value = next.migrationState !== "private";
    if (next.importPreview !== undefined) preview.value = next.importPreview;
  }
  if (next.migrationState !== "private" && !revalidating.value) {
    form.value = null;
    inputKey.value = "";
    preview.value = null;
  } else if (next.operation?.kind === "export" || next.operation?.kind === "import") {
    form.value = next.operation.kind;
    if (next.operation.vaultDirectory) directory.value = next.operation.vaultDirectory;
  }
}
async function run(operation?: () => Promise<void>, name = "") {
  if (busy.value || disposed) return;
  busy.value = true;
  failed.value = false;
  message.value = "";
  const current = generation;
  try {
    await operation?.();
  } catch (error) {
    if (!disposed && current === generation) {
      failed.value = true;
      lastFailure.value = name;
      message.value = error instanceof Error ? error.message : "操作未完成";
    }
  } finally {
    try {
      await load();
    } catch (error) {
      if (!disposed) message.value ||= error instanceof Error ? error.message : "状态检查失败";
    }
    if (!disposed) busy.value = false;
  }
}
function start(kind: "export" | "import") {
  clearDraft();
  form.value = kind;
  directory.value = status.value?.operation?.vaultDirectory ?? "";
}
function selectDirectory() {
  const current = generation;
  void run(async () => {
    const chosen = value(await service.selectDirectory());
    if (chosen && !disposed && current === generation) {
      directory.value = chosen;
      preview.value = null;
    }
  });
}
function cancel() {
  void run(async () => {
    if (form.value === "import") value(await service.cancelPreview());
    else if (status.value?.operation?.kind === "export") value(await service.cancelExport());
    clearDraft();
  });
}
function publish(recover = false) {
  const current = generation;
  const target = directory.value;
  void run(async () => {
    const result = recover
      ? value(await service.resumeExport())
      : value(await service.exportCredentials(target));
    await load();
    if (
      !disposed &&
      generation === current &&
      result &&
      !status.value?.deliveryAcknowledged &&
      (state.value === "export-ready" || state.value === "shared") &&
      status.value?.storageVersion === result.storageVersion
    )
      delivery.value = result.migrationKey;
  });
}
function verify() {
  const secret = inputKey.value;
  const target = directory.value;
  const current = generation;
  inputKey.value = "";
  preview.value = null;
  void run(async () => {
    const next = value(
      await service.verifyImport({ vaultDirectory: target, migrationKey: secret }),
    );
    if (!disposed && current === generation && directory.value === target) preview.value = next;
  });
}
function confirmImport() {
  const selected = preview.value;
  if (!selected) return;
  void run(async () => {
    const result = await service.confirmImport(selected.previewId);
    if (!result.ok && ["preview-expired", "import-preview-expired"].includes(result.error.code))
      preview.value = null;
    value(result);
    clearDraft();
  });
}
function action(fn: () => Promise<ServiceResult<void>>, name = "") {
  void run(async () => {
    value(await fn());
  }, name);
}
function preparePrivate() {
  const localCopy = status.value?.activeBackend === "unavailable" ? status.value.snapshotAt : null;
  const source =
    status.value?.activeBackend === "shared"
      ? "当前获准的共享记录"
      : "上次已验证的快照（" + (status.value?.snapshotAt ?? "暂无") + "）";
  if (
    window.confirm(
      "将从" +
        source +
        "写入本端内置库。切回后两份凭据各自刷新，轮换令牌可能需要重新授权。继续准备？",
    )
  )
    action(
      () => (localCopy ? service.returnToPrivate(true, localCopy) : service.returnToPrivate(true)),
      "prepare",
    );
}
function relocate() {
  void run(async () => {
    const selected = value(await service.selectDirectory());
    if (selected) value(await service.relocate(selected));
  });
}
function install() {
  action(() => service.install());
}
function uninstall() {
  if (window.confirm("卸载会暂停本机使用该组件的客户端。确认卸载？"))
    action(() => service.uninstall());
}
function close() {
  if (delivery.value && !window.confirm("迁移密钥尚未确认保存。离开后可恢复交付，是否继续？"))
    return;
  emit("close");
}
onMounted(() => {
  unsubscribe = service.subscribe(() => {
    void load().catch(() => undefined);
  });
  void run();
});
onUnmounted(() => {
  disposed = true;
  generation++;
  unsubscribe?.();
  inputKey.value = "";
  delivery.value = "";
  preview.value = null;
});
</script>

<template>
  <section class="content-page credential-storage-manager" aria-label="凭据存储管理">
    <header class="content-header">
      <h1>凭据存储管理</h1>
      <div class="sharing-actions">
        <button class="outline-action" :disabled="busy" @click="run()">重新检查</button>
        <button v-if="showBack" class="outline-action" :disabled="busy" @click="close">
          返回设置
        </button>
      </div>
    </header>
    <template v-if="status">
      <section class="settings-card" aria-label="本端迁移状态">
        <h2>{{ title }}</h2>
        <div class="setting-row">
          <strong>实际凭据后端</strong><span>{{ activeLabel }}</span>
        </div>
        <div class="setting-row">
          <strong>所选凭据存储</strong
          ><span>{{ status.selectedBackend === "shared" ? "共享存储" : "内置存储" }}</span>
        </div>
        <div v-if="status.vaultDirectory" class="setting-row">
          <strong>共享目录</strong><code class="path-value">{{ status.vaultDirectory }}</code>
        </div>
        <div v-if="status.storageVersion" class="setting-row">
          <strong>共享版本</strong
          ><span>{{ status.storageVersion }} · {{ status.recordCount }} 条记录</span>
        </div>
        <div v-if="desktop" class="setting-row">
          <strong>共享主密钥</strong><span>{{ status.rememberedKey ? "已记住" : "未记住" }}</span>
        </div>
        <div v-if="status.snapshotAt" class="setting-row">
          <strong>已验证快照</strong><span>{{ status.snapshotAt }}</span>
        </div>
        <p v-if="status.sessionCleanupPending">旧会话待清理</p>
        <p v-if="!desktop && status.activeBackend !== 'shared'">
          请在服务端配置共享目录与已授权的客户端身份，然后重试连接。
        </p>
        <p v-if="status.operation?.step" role="status">{{ status.operation.step }}</p>
        <div v-if="desktop && state === 'private' && !form" class="sharing-actions">
          <button
            class="primary-action"
            :disabled="busy || !installed || !enabled('exportCredentials')"
            @click="start('export')"
          >
            导出凭据
          </button>
          <button
            class="outline-action"
            :disabled="busy || !installed || !enabled('verifyImport')"
            @click="start('import')"
          >
            导入凭据
          </button>
        </div>
        <form
          v-if="(state === 'private' || revalidating) && form"
          class="key-delivery"
          @submit.prevent="form === 'export' ? publish() : verify()"
        >
          <h3>{{ form === "export" ? "导出凭据" : "导入凭据" }}</h3>
          <label
            >共享目录<input
              v-model.trim="directory"
              :aria-label="form === 'export' ? '导出目录' : '导入目录'"
              :disabled="busy || !!status.operation?.vaultDirectory"
              @input="preview = null"
          /></label>
          <button
            v-if="status.directorySelectionAvailable"
            type="button"
            class="outline-action"
            :disabled="busy || !!status.operation?.vaultDirectory"
            @click="selectDirectory"
          >
            选择目录
          </button>
          <p v-if="form === 'export'" class="setting-hint">
            导出的凭据与内置副本分别更新。两边刷新同一轮换令牌可能需要重新授权。
          </p>
          <label v-else
            >迁移密钥<input
              v-model="inputKey"
              type="password"
              autocomplete="off"
              aria-label="导入迁移密钥"
              :disabled="busy"
          /></label>
          <div class="sharing-actions">
            <button
              class="primary-action"
              :disabled="busy || !installed || !directory || (form === 'import' && !inputKey)"
            >
              {{
                form === "export"
                  ? failed || status.operation
                    ? "重试导出"
                    : "确认导出"
                  : failed
                    ? "重试导入"
                    : "验证导入"
              }}
            </button>
            <button type="button" class="outline-action" :disabled="busy" @click="cancel">
              取消
            </button>
          </div>
        </form>
        <section v-if="preview" class="key-delivery" aria-label="导入预览">
          <h3>导入预览</h3>
          <p>{{ preview.storageVersion }} · {{ preview.recordCount }} 条记录</p>
          <ul>
            <li v-for="item in preview.accounts" :key="item.id">
              {{ item.provider }} · {{ item.maskedIdentifier }}
            </li>
          </ul>
          <template v-if="preview.conflicts?.length"
            ><p>以下账号在本端有独立副本。确认后保留内置副本，迁移时使用共享当前值。</p>
            <ul>
              <li v-for="item in preview.conflicts" :key="item.id">{{ item.maskedIdentifier }}</li>
            </ul></template
          >
          <button
            class="primary-action"
            :disabled="busy || !enabled('confirmImport')"
            @click="confirmImport"
          >
            确认导入
          </button>
        </section>
        <section v-if="status.migrationReview && ready" class="key-delivery" aria-label="迁移变更">
          <h3>核对迁移变更</h3>
          <p>凭据已发生变化。迁移将使用共享库当前值，保留本端私有副本。</p>
          <ul>
            <li v-for="item in status.migrationReview.accounts" :key="item.id">
              {{ item.provider }} · {{ item.maskedIdentifier }}
            </li>
          </ul>
        </section>
        <div class="sharing-actions">
          <button
            v-if="ready"
            class="primary-action"
            :disabled="busy || !installed || !enabled('enableShared')"
            @click="action(() => service.enableShared(status?.migrationReview?.id), 'migrate')"
          >
            {{
              status.migrationReview
                ? "使用共享当前值并迁移"
                : status.operation?.kind === "enable-shared" ||
                    (failed && lastFailure === "migrate")
                  ? "重试迁移"
                  : "迁移到共享存储"
            }}
          </button>
          <button
            v-if="desktop && (state === 'shared' || state === 'private-ready')"
            class="outline-action"
            :disabled="busy || !enabled('returnToPrivate')"
            @click="preparePrivate"
          >
            {{
              failed && lastFailure === "prepare"
                ? "重试准备"
                : state === "private-ready"
                  ? "更新内置快照"
                  : "准备返回内置存储"
            }}
          </button>
          <button
            v-if="state === 'private-ready'"
            class="primary-action"
            :disabled="busy"
            @click="action(() => service.switchToPrivate(), 'switch')"
          >
            {{ failed && lastFailure === "switch" ? "重试切换" : "切换到内置存储" }}
          </button>
          <button
            v-if="status.activeBackend === 'unavailable' && status.selectedBackend === 'shared'"
            class="outline-action"
            :disabled="busy || !enabled('retry')"
            @click="action(() => service.retry())"
          >
            重试连接
          </button>
          <button
            v-if="desktop && state !== 'private' && !status.rememberedKey && !revalidating"
            class="outline-action"
            :disabled="busy || !installed"
            @click="
              start('import');
              revalidating = true;
              directory = status.vaultDirectory ?? '';
            "
          >
            重新验证密钥
          </button>
          <button
            v-if="status.keyCleanupPending || status.sessionCleanupPending"
            class="outline-action"
            :disabled="busy"
            @click="action(() => service.retry())"
          >
            重试清理
          </button>
          <button
            v-if="
              desktop &&
              status.vaultDirectory &&
              state !== 'private' &&
              status.directorySelectionAvailable
            "
            class="outline-action"
            :disabled="busy"
            @click="relocate"
          >
            变更共享目录
          </button>
        </div>
        <section
          v-if="
            delivery ||
            ((state === 'export-ready' || state === 'shared') &&
              !status.deliveryAcknowledged &&
              status.capabilities?.recoverDelivery?.state === 'enabled')
          "
          aria-label="迁移密钥交付"
          class="key-delivery"
        >
          <h3>迁移密钥交付</h3>
          <template v-if="delivery"
            ><label
              >迁移密钥<textarea readonly :value="delivery" aria-label="本次迁移密钥" />
            </label>
            <button
              class="outline-action"
              :disabled="busy"
              @click="
                action(async () => {
                  const r = await service.acknowledgeDelivery();
                  if (r.ok) delivery = '';
                  return r;
                })
              "
            >
              我已保存
            </button></template
          >
          <button
            v-else
            class="outline-action"
            :disabled="busy || !installed"
            @click="publish(true)"
          >
            恢复密钥交付
          </button>
        </section>
        <section v-if="status.accounts?.length">
          <h3>共享库账号</h3>
          <ul>
            <li v-for="item in status.accounts" :key="item.id">
              {{ item.provider }} · {{ item.maskedIdentifier }} · 修订 {{ item.revision }}
            </li>
          </ul>
        </section>
        <p v-if="busy || message || status.lastError" role="status">
          {{ busy ? "正在处理…" : message || status.lastError }}
        </p>
      </section>
      <section class="settings-card" aria-label="凭据服务组件">
        <h2>凭据服务组件</h2>
        <p v-if="status.installState === 'incompatible'" class="setting-hint" role="status">
          当前组件需要升级。请安装支持 API
          {{ status.requiredApiLevel }}
          及以上的兼容组件。
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
            :disabled="busy || !desktop || status.localPackageState !== 'ready'"
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
            v-if="status.installState === 'installed' && desktop"
            class="outline-action"
            :disabled="busy || !desktop || status.localPackageState !== 'ready'"
            @click="uninstall"
          >
            卸载组件
          </button>
        </div>
      </section>
      <p class="setting-hint">服务运行状态 · {{ status.serviceState }}</p>
    </template>
    <p v-else role="status">{{ message || "正在读取凭据状态…" }}</p>
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
