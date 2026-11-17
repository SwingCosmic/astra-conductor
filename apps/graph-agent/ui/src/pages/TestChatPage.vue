<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type {
  ChatCharge,
  ChatResultRequest,
  TestChatUsage,
} from "@astra-conductor/contract/graph-agent";
import { OmniChat, type ChatMessage } from "@lovekicher/omnichat";
import "@lovekicher/omnichat/dist/omnichat.css";
import { disabledReason, routeLabel, sameRoute, useModelView } from "./model-view";

const emit = defineEmits<{ configure: [] }>();
const { service, snapshot, loadError, reload } = useModelView();
const choice = computed(() => snapshot.value?.savedSelection);
const catalog = computed(() =>
  snapshot.value?.catalogs.find((item) => sameRoute(item, choice.value?.selection)),
);
const blocked = computed(
  () =>
    !!loadError.value ||
    !snapshot.value ||
    !catalog.value ||
    choice.value?.availability.state !== "enabled",
);
const messages = shallowRef<ChatMessage[]>([]);
const draft = ref("");
const state = ref("");
const charge = shallowRef<ChatCharge | null>(null),
  usage = shallowRef<TestChatUsage | null>(null),
  currentCall = shallowRef<ChatResultRequest | null>(null);
const chargeLabels = {
  estimated: "估算",
  actual: "实际扣款",
  partial: "部分估算",
  unknown: "费用未知",
  included: "套餐内",
  blocked: "额度不足",
};
let receiptGeneration = 0;
let keepAlive: ReturnType<typeof setInterval> | undefined;
function releaseResult() {
  receiptGeneration++;
  clearInterval(keepAlive);
  keepAlive = undefined;
  const c = currentCall.value;
  currentCall.value = null;
  charge.value = null;
  usage.value = null;
  if (c) void service.closeChatResult(c).catch(() => {});
}
async function readCharge() {
  const c = currentCall.value;
  if (!c) return;
  const run = ++receiptGeneration;
  try {
    const r = await service.getChatCharge(c);
    if (run === receiptGeneration && currentCall.value === c && r.ok) charge.value = r.value;
  } catch {
    /* A subsequent event or reconnect re-reads the projection. */
  }
}
let stopReceipts: undefined | (() => void);
onMounted(() => {
  window.addEventListener("pagehide", releaseResult);
  stopReceipts = service.subscribe((e) => {
    if (e.resync || e.reasons.includes("charge")) void readCharge();
  });
});
const error = ref("");
const controller = shallowRef<AbortController | null>(null);
const textarea = ref<HTMLTextAreaElement>();
const currentUser = { id: "user", name: "你" };
const users = [currentUser, { id: "assistant", name: "AI 助手" }];
const identity = computed(() =>
  JSON.stringify([
    snapshot.value?.stamp.instanceId,
    snapshot.value?.backend.contextId,
    choice.value?.selection,
    catalog.value?.bindingRevision,
    choice.value?.availability.state,
  ]),
);

// Adapted from OmniChat's AIChatExample and AiComposer. Each submit replaces the displayed pair.
function cancel() {
  controller.value?.abort();
  controller.value = null;
}
watch(
  identity,
  () => {
    cancel();
    releaseResult();
    draft.value = "";
    messages.value = [];
    error.value = "";
    state.value = "";
  },
  { flush: "sync" },
);
function resize() {
  if (!textarea.value) return;
  textarea.value.style.height = "auto";
  textarea.value.style.height = `${Math.min(200, Math.max(64, textarea.value.scrollHeight))}px`;
}
watch(draft, resize, { flush: "post" });
function keydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void send();
}
function message(role: "user" | "assistant", text: string): ChatMessage {
  return {
    // Each submission replaces the pair, so role is a unique key even on HTTP LAN hosts.
    id: role,
    createUser: role,
    role,
    timestamp: Date.now(),
    content: [{ type: "text", data: { text } }],
  };
}
async function send() {
  const view = snapshot.value,
    route = catalog.value,
    prompt = draft.value.trim();
  if (!view || !route || blocked.value || controller.value || !prompt) return;
  const request = new AbortController();
  releaseResult();
  controller.value = request;
  error.value = "";
  state.value = "正在等待模型回复…";
  messages.value = [message("user", prompt)];
  draft.value = "";
  try {
    const result = await service.testChat(
      {
        instanceId: view.stamp.instanceId,
        contextId: view.backend.contextId,
        expectedSettingsRevision: view.settingsRevision,
        expectedBindingRevision: route.bindingRevision,
        prompt,
      },
      request.signal,
    );
    if (request.signal.aborted) {
      if (result.ok)
        void service
          .closeChatResult({
            instanceId: view.stamp.instanceId,
            contextId: view.backend.contextId,
            callId: result.value.callId,
          })
          .catch(() => {});
      return;
    }
    if (!result.ok) {
      error.value = result.error.message;
      state.value = "";
      void reload();
      return;
    }
    currentCall.value = {
      instanceId: view.stamp.instanceId,
      contextId: view.backend.contextId,
      callId: result.value.callId,
    };
    keepAlive = setInterval(() => void readCharge(), 60_000);
    charge.value = result.value.charge;
    usage.value = result.value.usage ?? null;
    void readCharge();
    messages.value = [...messages.value, message("assistant", result.value.text)];
    state.value = "";
  } catch {
    if (!request.signal.aborted) {
      error.value = "无法读取模型回复";
      state.value = "";
    }
  } finally {
    if (controller.value === request) controller.value = null;
  }
}
function stop() {
  cancel();
  state.value = "已停止等待回复";
}
onBeforeUnmount(() => {
  cancel();
  window.removeEventListener("pagehide", releaseResult);
  stopReceipts?.();
  releaseResult();
});
</script>
<template>
  <section class="content-page graph-chat">
    <header class="content-header">
      <div>
        <h1>测试对话</h1>
        <p>每次只发送一个问题，页面仅保留本次问答。</p>
      </div>
      <button class="outline-action" @click="emit('configure')">模型配置</button>
    </header>
    <p v-if="loadError" class="form-message" role="alert">
      {{ loadError }} <button class="outline-action" @click="reload">重新读取</button>
    </p>
    <div class="graph-chat-panel">
      <header class="graph-card-header">
        <div>
          <h2>{{ choice?.selection.modelId ?? "未选择模型" }}</h2>
          <span v-if="catalog" class="setting-hint">{{ routeLabel(catalog) }}</span>
        </div>
        <span v-if="state" class="setting-hint" role="status">{{ state }}</span>
      </header>
      <p v-if="charge" class="setting-hint" role="status">
        <strong>本轮费用 · {{ chargeLabels[charge.status] }}</strong> {{ charge.amount ?? "" }}
        {{ charge.currency ?? "" }}
        <span v-if="usage">
          · 输入 {{ usage.inputTokens ?? "未知" }} / 输出
          {{ usage.outputTokens ?? "未知" }} tokens</span
        >
      </p>
      <p v-if="error" class="form-message" role="alert">{{ error }}</p>
      <div v-if="!messages.length" class="chat-empty">
        <h3>{{ choice ? "开始测试对话" : "选择测试模型" }}</h3>
        <p v-if="blocked" class="setting-hint">
          {{ disabledReason(choice?.availability) ?? "请先在模型配置中保存一个可调用的模型。" }}
        </p>
        <button v-if="blocked" class="outline-action" @click="emit('configure')">
          前往模型配置
        </button>
      </div>
      <OmniChat
        :model-value="messages"
        :current-user="currentUser"
        :users="users"
        :options="{ allowEditMessage: false, allowRecallMessage: false }"
      >
        <template #message-text="{ message: segment }"
          ><span class="chat-text">{{ segment.data.text }}</span></template
        >
        <template #input>
          <form class="ai-composer-wrap" @submit.prevent="send">
            <div class="ai-composer">
              <textarea
                ref="textarea"
                v-model="draft"
                aria-label="消息草稿"
                placeholder="输入问题…"
                rows="2"
                maxlength="16384"
                @keydown="keydown"
              />
              <div class="ai-composer-toolbar">
                <small>Enter 发送 · Shift + Enter 换行</small>
                <button
                  v-if="controller"
                  class="ai-send-button"
                  type="button"
                  aria-label="停止回复"
                  title="停止回复"
                  @click="stop"
                >
                  ■
                </button>
                <button
                  v-else
                  class="ai-send-button"
                  :disabled="blocked || !draft.trim()"
                  aria-label="发送消息"
                  title="发送消息"
                >
                  ↑
                </button>
              </div>
            </div>
          </form>
        </template>
      </OmniChat>
    </div>
  </section>
</template>
<style scoped>
.graph-chat {
  max-width: 1050px;
}
.graph-chat-panel {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: white;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 450px;
  height: calc(100dvh - 160px);
}
.graph-chat-panel > header {
  padding: 14px 20px;
  margin: 0;
  border-bottom: 1px solid var(--border);
}
.graph-chat-panel > .form-message {
  margin: 12px 20px 0;
}
.chat-empty {
  flex: 1;
  display: grid;
  place-content: center;
  justify-items: center;
  padding: 20px;
  text-align: center;
}
.chat-empty h3 {
  margin: 0;
  font-size: 18px;
}
.graph-chat :deep(.omnichat) {
  flex: 1;
  min-height: 0;
  height: auto;
  --omnichat-bg-color: #fff;
  --omnichat-self-bg: var(--brand-selected);
  --omnichat-self-text: var(--text-primary);
  --omnichat-border-width: 0;
  --omnichat-avatar-size: 28px;
  --omnichat-gap: 20px;
}
.chat-empty + :deep(.omnichat) {
  flex: none;
}
.chat-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.ai-composer-wrap {
  padding: 10px 20px 16px;
}
.ai-composer {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 3px 16px #242b4010;
}
.ai-composer:focus-within {
  border-color: var(--brand-accent);
}
.ai-composer textarea {
  width: 100%;
  display: block;
  min-height: 64px;
  max-height: 200px;
  resize: none;
  padding: 4px;
  border: 0;
  outline: 0;
  font: inherit;
  line-height: 1.6;
}
.ai-composer-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--text-muted);
}
.ai-send-button {
  border: 0;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--brand-accent);
  color: white;
  font-weight: 600;
  font-size: 20px;
  cursor: pointer;
}
.ai-send-button:disabled {
  background: #bac1cd;
}
</style>
