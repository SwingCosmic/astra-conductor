<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { AuthStartResult, IpcResult, PublicAccount, StartAuthRequest } from "../models";
import type { ProviderPresentation } from "../presentation";
import { usePolyQuotaService } from "../services/polyquota-service-vue";

const props = defineProps<{ provider: ProviderPresentation }>();
const emit = defineEmits<{ close: []; connected: [account: PublicAccount] }>();
const selected = ref<string>(props.provider.authMethods[0]!.id);
const pending = ref<Extract<AuthStartResult, { status: "pending" }> | null>(null);
const busy = ref(false);
const message = ref("");
const apiKey = ref("");
const selectedMethod = computed(() =>
  props.provider.authMethods.find((method) => method.id === selected.value),
);
const secretForm = computed(() => selectedMethod.value?.interaction === "secret-form");
const cliImportSourceLabel = computed(
  () => props.provider.authMethods.find((method) => method.id === "cli-import")?.label ?? "CLI",
);
const service = usePolyQuotaService();
const sessionKey = `polyquota.auth.${props.provider.id}`;
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let dismissed = false;

async function restoreSession(): Promise<void> {
  const sessionId = sessionStorage.getItem(sessionKey);
  if (!sessionId || disposed) return;
  try {
    const result = await service.getAuthSession(sessionId);
    if (disposed || sessionStorage.getItem(sessionKey) !== sessionId) return;
    if (!result.ok && result.error.code === "not-found") {
      sessionStorage.removeItem(sessionKey);
      pending.value = null;
      busy.value = false;
      message.value = result.error.message;
      return;
    }
    const state = unwrap(result);
    selected.value = state.method;
    if (state.status === "completed" && state.account) {
      pending.value = null;
      sessionStorage.removeItem(sessionKey);
      busy.value = false;
      emit("connected", state.account);
      return;
    }
    if (["failed", "cancelled", "expired"].includes(state.status)) {
      message.value = state.error?.message ?? "授权已结束";
      pending.value = null;
      sessionStorage.removeItem(sessionKey);
      busy.value = false;
      return;
    }
    pending.value =
      state.interaction === "device-code"
        ? {
            status: "pending",
            sessionId,
            interaction: "device-code",
            userCode: state.userCode ?? "",
            verificationUri: state.verificationUri ?? "",
          }
        : {
            status: "pending",
            sessionId,
            interaction: "browser-callback",
            authorizationUrl: state.authorizationUrl,
          };
  } catch (error) {
    message.value = error instanceof Error ? error.message : "无法查询授权状态";
  }
  if (!disposed) timer = setTimeout(() => void restoreSession(), 1500);
}

onMounted(() => {
  if (sessionStorage.getItem(sessionKey)) void restoreSession();
});

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function finish(sessionId: string): Promise<void> {
  try {
    const account = unwrap(await service.finishAuth(sessionId));
    if (disposed || sessionStorage.getItem(sessionKey) !== sessionId) return;
    pending.value = null;
    sessionStorage.removeItem(sessionKey);
    clearTimeout(timer);
    emit("connected", account);
  } catch (error) {
    if (disposed || sessionStorage.getItem(sessionKey) !== sessionId) return;
    message.value = error instanceof Error ? error.message : "授权失败";
    if (!sessionStorage.getItem(sessionKey)) pending.value = null;
  } finally {
    busy.value = false;
  }
}

async function begin(): Promise<void> {
  busy.value = true;
  message.value = "";
  try {
    // 接入点与认证方式由目录声明；主进程对 offeringId 交叉验证，secret-form
    // 输入由供应商实现再次校验，UI 不维护按供应商的白名单分支。
    const request: StartAuthRequest = {
      offeringId: props.provider.id,
      method: selected.value,
      ...(secretForm.value ? { apiKey: apiKey.value } : {}),
    };
    const result = unwrap(await service.startAuth(request));
    if (dismissed) {
      if (result.status === "pending") await service.cancelAuth(result.sessionId);
      return;
    }
    if (disposed) {
      if (result.status === "pending") sessionStorage.setItem(sessionKey, result.sessionId);
      return;
    }
    if (result.status === "completed") {
      emit("connected", result.account);
      busy.value = false;
      return;
    }
    pending.value = result;
    sessionStorage.setItem(sessionKey, result.sessionId);
    clearTimeout(timer);
    timer = setTimeout(() => void restoreSession(), 1500);
    if (result.interaction === "browser-callback") void finish(result.sessionId);
    else busy.value = false;
  } catch (error) {
    message.value = error instanceof Error ? error.message : "无法启动授权";
    busy.value = false;
  }
}

function completeDevice(): void {
  if (!pending.value || pending.value.interaction !== "device-code") return;
  busy.value = true;
  void finish(pending.value.sessionId);
}

function cancelPending(): void {
  clearTimeout(timer);
  sessionStorage.removeItem(sessionKey);
  if (pending.value) void service.cancelAuth(pending.value.sessionId);
  pending.value = null;
}

function close(): void {
  dismissed = true;
  cancelPending();
  emit("close");
}

function select(method: string): void {
  if (method === selected.value) return;
  cancelPending();
  selected.value = method;
  message.value = "";
}

onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>

<template>
  <div class="modal-backdrop" @click.self="close">
    <section
      class="auth-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="`添加 ${provider.name}`"
    >
      <header>
        <div>
          <h2>添加 {{ provider.name }}</h2>
          <p>选择接入方式并按步骤完成验证</p>
        </div>
        <button class="icon-button" aria-label="关闭" @click="close">×</button>
      </header>
      <div class="auth-tabs" role="tablist">
        <button
          v-for="method in provider.authMethods"
          :key="method.id"
          :class="{ active: selected === method.id }"
          :disabled="busy"
          @click="select(method.id)"
        >
          {{ method.label }}
        </button>
      </div>
      <div v-if="selected === 'browser-oauth'" class="auth-steps">
        <div class="auth-step active">
          <span>1</span>
          <div>
            <strong>启动临时回调服务</strong>
            <p>仅在本次授权期间监听本机回调。</p>
          </div>
        </div>
        <div class="auth-step" :class="{ active: pending?.interaction === 'browser-callback' }">
          <span>2</span>
          <div>
            <strong>在浏览器完成授权</strong>
            <p>{{ pending ? "正在等待浏览器回调…" : "启动后使用授权链接前往服务商页面。" }}</p>
            <a
              v-if="pending?.interaction === 'browser-callback' && pending.authorizationUrl"
              :href="pending.authorizationUrl"
              target="_blank"
              rel="noreferrer"
              >打开授权页面</a
            >
          </div>
        </div>
        <div class="auth-step">
          <span>3</span>
          <div>
            <strong>验证并保存账号</strong>
            <p>回调通过后保存加密凭据和账号信息。</p>
          </div>
        </div>
      </div>

      <div v-else-if="selected === 'device-code'" class="auth-steps">
        <div class="auth-step active">
          <span>1</span>
          <div>
            <strong>获取设备码</strong>
            <p>获取设备码后，使用验证链接完成授权。</p>
          </div>
        </div>
        <template v-if="pending?.interaction === 'device-code'">
          <div class="device-code">{{ pending.userCode }}</div>
          <a
            class="verification-uri"
            :href="pending.verificationUri"
            target="_blank"
            rel="noreferrer"
            >打开设备验证页面</a
          >
        </template>
        <div class="auth-step">
          <span>2</span>
          <div>
            <strong>验证并保存账号</strong>
            <p>在浏览器确认后，回到这里继续。</p>
          </div>
        </div>
      </div>

      <div v-else-if="selected === 'cli-import'" class="cli-import-panel">
        <strong>检测本地 {{ cliImportSourceLabel }} 凭据文件</strong>
        <code v-if="provider.cliImportPath">{{ provider.cliImportPath }}</code>
        <p>只读取现有凭据并保存应用自己的加密副本，不修改 CLI 文件。</p>
      </div>

      <div v-else-if="secretForm" class="api-key-panel">
        <label for="provider-api-key">{{ provider.name }} API Key</label>
        <input
          id="provider-api-key"
          v-model="apiKey"
          type="password"
          autocomplete="off"
          spellcheck="false"
          :placeholder="`输入 ${provider.name} API Key`"
          :disabled="busy"
        />
        <p>应用会先验证配额接口，再通过系统安全存储保存加密副本。</p>
        <a v-if="provider.websiteUrl" :href="provider.websiteUrl" target="_blank" rel="noreferrer"
          >前往服务商管理页面</a
        >
      </div>

      <p v-if="message" class="form-message" role="alert">{{ message }}</p>
      <footer>
        <button @click="close">取消</button>
        <button
          v-if="selected === 'device-code' && pending?.interaction === 'device-code'"
          class="primary-action"
          :disabled="busy"
          @click="completeDevice"
        >
          我已完成授权
        </button>
        <button
          v-else
          class="primary-action"
          :disabled="busy || Boolean(pending) || (secretForm && !apiKey.trim())"
          @click="begin"
        >
          {{
            secretForm
              ? "验证并添加"
              : selected === "cli-import"
                ? "检测并导入"
                : selected === "device-code"
                  ? "获取设备码"
                  : "打开浏览器授权"
          }}
        </button>
      </footer>
    </section>
  </div>
</template>
