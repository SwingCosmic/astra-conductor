<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type {
  ChatCharge,
  ChatResultRequest,
  TestChatUsage,
} from "@astra-conductor/contract/graph-agent";
import {
  OmniChat,
  type ChatMessage,
  type InputContext,
  type MessageOperations,
  type MessageSegment,
} from "@lovekicher/omnichat";
import "@lovekicher/omnichat/dist/omnichat.css";
import { AppIcon } from "@astra-conductor/shared-ui";
import { disabledReason, routeLabel, sameRoute, useModelView } from "./model-view";
import { chargeStatusLabels } from "./catalog-labels";
import ActivityPanel from "./ActivityPanel.vue";
import { appendDelta, finishContent, type ActivityState } from "./chat-content";
import { readNativeReply } from "../services/native-chat-reply";

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
const chargeLabels = chargeStatusLabels;
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
  window.addEventListener("pagehide", leave);
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
    snapshot.value?.settingsRevision,
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
function keydown(event: KeyboardEvent, context: InputContext) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void submit(context);
}
const expanded = ref<Record<string, boolean>>({});
let generation = 0;
function finish(state: ActivityState) {
  messages.value = messages.value.map((m) =>
    m.role === "assistant" ? { ...m, content: finishContent(m.content, state) } : m,
  );
}
async function submit(context: InputContext) {
  const prompt = draft.value.trim();
  if (blocked.value || controller.value || !prompt) return;
  const guard = identity.value;
  releaseResult();
  expanded.value = {};
  messages.value = [];
  error.value = "";
  await nextTick();
  if (guard !== identity.value || blocked.value || controller.value) return;
  context.currentText = prompt;
  await context.sendMessage();
}
const operations: MessageOperations = {
  async sendMessage(input) {
    const view = snapshot.value,
      route = catalog.value,
      saved = choice.value;
    const text = input.content.find((s) => s.type === "text")?.data.text;
    if (!view || !route || !saved || blocked.value || controller.value || !text) return null;
    const run = ++generation;
    const user: ChatMessage = {
      ...input,
      createUser: currentUser.id,
      id: "user-" + run,
      role: "user",
      timestamp: Date.now(),
    };
    const request = new AbortController();
    controller.value = request;
    state.value = "正在等待模型回复…";
    draft.value = "";
    const protocol = saved.selection.protocol;
    const baseline = {
      instanceId: view.stamp.instanceId,
      contextId: view.backend.contextId,
      expectedBindingRevision: route.bindingRevision,
      expectedSettingsRevision: view.settingsRevision,
    };
    const entry = route.entries.find((e) => e.selection.modelId === saved.selection.modelId);
    const display = {
      thinkingEnabled:
        saved.parameters.thinkingEnabled !== false && entry?.fields.reasoningMode.value !== "none",
      returnFullReasoning: saved.parameters.returnFullReasoning === true,
      mode: entry?.fields.reasoningOutputMode?.value ?? ("unknown" as const),
    };
    async function receive() {
      try {
        if (
          protocol !== "openai-chat" &&
          protocol !== "openai-responses" &&
          protocol !== "anthropic-messages"
        )
          throw Error("该端点不支持测试对话");
        const preview = await service.previewRequest({
          ...baseline,
          selection: saved!.selection,
          operation: "chat",
          parameters: saved!.parameters,
        });
        if (request.signal.aborted || generation !== run) return;
        if (!preview.ok) throw Error(preview.error.message);
        const body = { ...preview.value.body };
        if (!entry?.fields.unsupportedParameters.value?.includes("stream")) body.stream ??= true;
        const native =
          protocol === "openai-responses"
            ? { ...body, input: [{ role: "user", content: [{ type: "input_text", text: text! }] }] }
            : {
                ...body,
                messages: [{ role: "user", content: text! }],
                ...(protocol === "openai-chat" &&
                  body.stream &&
                  !entry?.fields.unsupportedParameters.value?.includes("stream_options") && {
                    stream_options: {
                      include_usage: true,
                      ...((preview.value.body.stream_options as Record<string, boolean>) ?? {}),
                    },
                  }),
              };
        const response = await service.nativeChat(
          { ...baseline, protocol, body: native },
          request.signal,
        );
        const callId = response.headers.get("X-GraphAgent-Call-Id");
        const call = callId
          ? { instanceId: baseline.instanceId, contextId: baseline.contextId, callId }
          : null;
        if (request.signal.aborted || generation !== run) {
          if (call) void service.closeChatResult(call).catch(() => {});
          await response.body?.cancel();
          return;
        }
        if (call) {
          currentCall.value = call;
          keepAlive = setInterval(() => void readCharge(), 60_000);
        }
        let content: MessageSegment[] = [];
        const reply: ChatMessage = {
          id: "assistant-" + run,
          createUser: "assistant",
          role: "assistant",
          timestamp: Date.now(),
          content,
        };
        const result = await readNativeReply(
          protocol,
          response,
          display,
          (change) => {
            if (request.signal.aborted || generation !== run) return;
            content = appendDelta(content, change);
            messages.value = [user, { ...reply, content }];
            state.value = "正在回复…";
          },
          request.signal,
        );
        if (request.signal.aborted || generation !== run) return;
        finish("completed");
        state.value = result.notice;
        usage.value = result.usage;
      } catch (reason) {
        if (!request.signal.aborted && generation === run) {
          finish("failed");
          state.value = "";
          error.value = reason instanceof Error ? reason.message : "无法读取模型回复";
          void reload();
        }
      } finally {
        if (controller.value === request) {
          controller.value = null;
          void readCharge();
        }
      }
    }
    void receive();
    return user;
  },
};
function stop() {
  cancel();
  finish("cancelled");
  state.value = "已停止等待回复";
  releaseResult();
}
function leave() {
  cancel();
  releaseResult();
}
onBeforeUnmount(() => {
  leave();
  window.removeEventListener("pagehide", leave);
  stopReceipts?.();
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
      <p v-if="charge" class="chat-charge-bar setting-hint" role="status">
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
        :key="identity"
        v-model="messages"
        :current-user="currentUser"
        :users="users"
        :operations="operations"
        :send-disabled="blocked || !!controller"
        :options="{ allowEditMessage: false, allowRecallMessage: false }"
      >
        <template #message-text="{ message: segment }"
          ><span class="chat-text">{{ segment.data.text }}</span></template
        >
        <template #message-ai-activity="{ message: segment }">
          <ActivityPanel
            :activity="segment.data"
            :expanded="!!expanded[segment.id!]"
            @toggle="expanded[segment.id!] = !expanded[segment.id!]"
          />
        </template>
        <template #input="{ context }">
          <form class="ai-composer-wrap" @submit.prevent="submit(context)">
            <div class="ai-composer">
              <textarea
                ref="textarea"
                v-model="draft"
                aria-label="消息草稿"
                placeholder="输入问题…"
                rows="2"
                maxlength="16384"
                @keydown="keydown($event, context)"
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
                  <AppIcon name="stop" :size="15" />
                </button>
                <button
                  v-else
                  class="ai-send-button"
                  :disabled="blocked || !draft.trim()"
                  aria-label="发送消息"
                  title="发送消息"
                >
                  <AppIcon name="arrow-up" :size="18" :stroke-width="2.1" />
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
  border-radius: var(--radius-lg, 10px);
  background: var(--surface, white);
  box-shadow: var(--shadow-card);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 450px;
  height: calc(100dvh - 150px);
}
.graph-chat-panel > header {
  padding: 12px 18px;
  margin: 0;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-subtle);
}
.chat-charge-bar {
  margin: 0;
  padding: 7px 18px;
  background: var(--surface-subtle);
  border-bottom: 1px solid var(--border-subtle);
  font-variant-numeric: tabular-nums;
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
.graph-chat :deep(.omnichat-message__bubble) {
  pointer-events: none;
}
.graph-chat :deep(.omnichat-message__content > *) {
  position: relative;
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
  border-radius: var(--radius-lg, 10px);
  box-shadow: var(--shadow-card);
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--brand-accent);
  color: white;
  cursor: pointer;
}
.ai-send-button:disabled {
  background: #bac1cd;
}
</style>
