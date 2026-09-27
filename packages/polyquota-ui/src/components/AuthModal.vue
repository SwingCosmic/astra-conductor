<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { AuthMethod, AuthStartResult, IpcResult, PublicAccount } from "../models";
import type { ProviderPresentation } from "../presentation";
import { usePolyQuotaService } from "../services/polyquota-service-vue";

const props = defineProps<{ provider: ProviderPresentation }>();
const emit = defineEmits<{ close: []; connected: [account: PublicAccount] }>();
const selected = ref<AuthMethod>(props.provider.authMethods[0]!.id);
const pending = ref<Extract<AuthStartResult, { status: "pending" }> | null>(null);
const busy = ref(false);
const message = ref("");
const apiKey = ref("");
const service = usePolyQuotaService();

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function finish(sessionId: string): Promise<void> {
  try {
    const account = unwrap(await service.finishAuth(sessionId));
    pending.value = null;
    emit("connected", account);
  } catch (error) {
    message.value = error instanceof Error ? error.message : "授权失败";
    pending.value = null;
  } finally {
    busy.value = false;
  }
}

async function begin(): Promise<void> {
  busy.value = true;
  message.value = "";
  try {
    const result = unwrap(
      await service.startAuth(props.provider.provider, selected.value, {
        ...(props.provider.region ? { region: props.provider.region } : {}),
        ...(selected.value === "api-key" ? { apiKey: apiKey.value } : {}),
      }),
    );
    if (result.status === "completed") {
      emit("connected", result.account);
      busy.value = false;
      return;
    }
    pending.value = result;
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
  if (pending.value) void service.cancelAuth(pending.value.sessionId);
  pending.value = null;
}

function close(): void {
  cancelPending();
  emit("close");
}

function select(method: AuthMethod): void {
  if (method === selected.value) return;
  cancelPending();
  selected.value = method;
  message.value = "";
}

onBeforeUnmount(cancelPending);
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
            <p>{{ pending ? "正在等待浏览器回调…" : "浏览器将打开服务商授权页面。" }}</p>
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
            <p>应用会打开服务商的设备验证页面。</p>
          </div>
        </div>
        <template v-if="pending?.interaction === 'device-code'">
          <div class="device-code">{{ pending.userCode }}</div>
          <p class="verification-uri">{{ pending.verificationUri }}</p>
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
        <strong>检测本地 {{ provider.provider === "glm" ? "ZCode" : "Codex CLI" }} 凭据文件</strong>
        <code>{{
          provider.provider === "glm" ? "~/.zcode/v2/credentials.json" : "~/.codex/auth.json"
        }}</code>
        <p>只读取现有凭据并保存应用自己的加密副本，不修改 CLI 文件。</p>
      </div>

      <div v-else-if="selected === 'api-key'" class="api-key-panel">
        <label for="provider-api-key">Coding Plan API Key</label>
        <input
          id="provider-api-key"
          v-model="apiKey"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="输入服务商签发的 API Key"
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
          :disabled="busy || Boolean(pending) || (selected === 'api-key' && !apiKey.trim())"
          @click="begin"
        >
          {{
            selected === "api-key"
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
