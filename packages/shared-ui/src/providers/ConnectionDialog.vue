<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import FormDialog from "../components/FormDialog.vue";
import ConfigField from "../components/ConfigField.vue";
import type { CommandContext } from "@astra-conductor/contract/common";
import { useProviderService } from "../ports/services";

const props = defineProps<{
  context: CommandContext;
  accountId?: string;
  providerId?: string;
  offeringId?: string;
  offeringLabel?: string;
}>();
const configuredOffering = computed(
  () => !!props.offeringId && props.offeringId !== "compatible-api-key",
);
const providerIdentity = () =>
  configuredOffering.value ? { providerId: props.providerId, offeringId: props.offeringId } : {};
const emit = defineEmits<{ close: []; saved: [] }>();
const service = useProviderService();
const context = { ...props.context };
const name = ref("");
const apiKey = ref("");
const accountIdentifier = ref("");
const protocols = [
  { id: "openai-chat", label: "OpenAI Chat Completions", example: "https://api.openai.com/v1" },
  { id: "openai-responses", label: "OpenAI Responses", example: "https://api.openai.com/v1" },
  {
    id: "anthropic-messages",
    label: "Anthropic Messages",
    example: "https://api.anthropic.com/v1",
  },
] as const;
type Protocol = (typeof protocols)[number]["id"];
const urls = ref<Record<Protocol, string>>({
  "openai-chat": "",
  "openai-responses": "",
  "anthropic-messages": "",
});
const versions = ref<Partial<Record<Protocol, string>>>({});
const revision = ref("");
const reloadNeeded = ref(false);
// Non-localhost HTTP Web hosts also support getRandomValues.
const operationId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
  n.toString(16).padStart(2, "0"),
).join("");
const busy = ref(false);
const error = ref("");
let disposed = false;
const valid = computed(
  () =>
    name.value.trim() &&
    (props.accountId ? revision.value : apiKey.value.trim()) &&
    (configuredOffering.value || protocols.some(({ id }) => urls.value[id].trim())),
);

async function load() {
  if (!props.accountId) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await service.getConnection(props.accountId);
    if (disposed) return;
    if (!result.ok) throw new Error(result.error.message);
    const connection = result.value;
    if (connection.contextId !== context.contextId || connection.instanceId !== context.instanceId)
      throw new Error("凭据后端已切换，请重新打开连接。");
    revision.value = connection.recordRevision;
    name.value = connection.displayName;
    for (const { id } of protocols) urls.value[id] = "";
    versions.value = {};
    for (const route of connection.routes) {
      const item = protocols.find((p) => p.id === route.protocolRouteId);
      if (item) {
        urls.value[item.id] = route.baseUrl;
        versions.value[item.id] = route.protocolVersion ?? "";
      }
    }
    reloadNeeded.value = false;
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : "读取连接失败";
  } finally {
    if (!disposed) busy.value = false;
  }
}

async function save() {
  if (!valid.value || busy.value || reloadNeeded.value) return;
  busy.value = true;
  error.value = "";
  const routes = configuredOffering.value
    ? []
    : protocols
        .filter(({ id }) => urls.value[id].trim())
        .map(({ id }) => ({
          protocolRouteId: id,
          baseUrl: urls.value[id].trim(),
          protocolVersion: versions.value[id]?.trim() || null,
        }));
  const key = apiKey.value.trim();
  apiKey.value = "";
  const displayName = name.value.trim();
  try {
    const result = props.accountId
      ? await service.editConnection(
          props.accountId,
          {
            ...providerIdentity(),
            displayName,
            routes,
            expectedRecordRevision: revision.value,
            ...(key ? { apiKey: key } : {}),
          },
          context,
        )
      : await service.createConnection(
          {
            ...providerIdentity(),
            displayName,
            ...(accountIdentifier.value.trim()
              ? { accountIdentifier: accountIdentifier.value.trim() }
              : {}),
            routes,
            apiKey: key,
            operationId,
          },
          context,
        );
    if (disposed) return;
    if (!result.ok) {
      reloadNeeded.value =
        result.error.code === "conflict" || result.error.code === "stale-binding";
      throw new Error(result.error.message);
    }
    emit("saved");
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : "保存连接失败";
  } finally {
    if (!disposed) busy.value = false;
  }
}
onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  disposed = true;
  apiKey.value = "";
});
</script>

<template>
  <FormDialog :title="accountId ? '编辑 API 连接' : '添加 API 连接'" @close="emit('close')">
    <p v-if="offeringLabel" class="setting-hint">{{ offeringLabel }}</p>
    <form @submit.prevent="save">
      <fieldset class="api-key-panel" :disabled="busy">
        <ConfigField label="账号名称"
          ><input id="connection-name" v-model="name" required autocomplete="off"
        /></ConfigField>
        <ConfigField v-if="configuredOffering && !accountId" label="账号标识（可选）"
          ><input v-model="accountIdentifier" placeholder="登录名或邮箱" autocomplete="off"
        /></ConfigField>
        <label for="connection-key">{{ accountId ? "更换 API Key" : "API Key" }}</label>
        <input
          id="connection-key"
          v-model="apiKey"
          type="password"
          :required="!accountId"
          autocomplete="new-password"
          spellcheck="false"
          :placeholder="accountId ? '留空以保留已保存的密钥' : ''"
        />
      </fieldset>
      <fieldset v-if="!configuredOffering" class="api-key-panel" :disabled="busy">
        <legend>协议基础地址</legend>
        <p>至少填写一种协议的 API 根地址。密钥将发送到填写的地址。</p>
        <template v-for="protocol in protocols" :key="protocol.id">
          <label :for="`route-${protocol.id}`">{{ protocol.label }}</label>
          <input
            :id="`route-${protocol.id}`"
            v-model="urls[protocol.id]"
            type="url"
            :placeholder="protocol.example"
            spellcheck="false"
          />
        </template>
        <template v-if="urls['anthropic-messages']">
          <label for="anthropic-version">Anthropic 协议版本</label>
          <input
            id="anthropic-version"
            v-model="versions['anthropic-messages']"
            placeholder="2023-06-01"
          />
        </template>
      </fieldset>
      <p v-if="error" class="form-message" role="alert">{{ error }}</p>
      <button
        v-if="accountId && (reloadNeeded || !revision) && !busy"
        class="outline-action"
        type="button"
        @click="load"
      >
        重新载入连接
      </button>
      <footer>
        <button type="button" @click="emit('close')">取消</button>
        <button class="primary-action" type="submit" :disabled="busy || reloadNeeded || !valid">
          保存连接
        </button>
      </footer>
    </form>
  </FormDialog>
</template>

<style scoped>
fieldset {
  border: 0;
  margin: 15px 0 0;
  min-width: 0;
}
legend {
  padding: 0 0 6px;
  font-weight: 650;
}
</style>
