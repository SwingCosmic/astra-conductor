<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import FormDialog from "../components/FormDialog.vue";
import ConfigField from "../components/ConfigField.vue";
import {
  modelEndpointDescriptor,
  type CommandContext,
  type EndpointProtocol,
  type ModelRouteInput,
  type OfferingRouteConfig,
  type ProtocolFamily,
} from "@astra-conductor/contract/common";
import { useProviderService } from "../ports/services";

const props = defineProps<{
  context: CommandContext;
  accountId?: string;
  providerId?: string;
  offeringId?: string;
  offeringLabel?: string;
  routeConfig?: OfferingRouteConfig;
}>();

const defaultLegacyProtocols: readonly EndpointProtocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
];
const familyLabels: Record<ProtocolFamily, string> = {
  openai: "OpenAI 协议族",
  anthropic: "Anthropic 协议族",
  gemini: "Gemini 协议族",
  "grok-video": "Grok Video 协议族",
  cohere: "Cohere 协议族",
};
const familyExamples: Record<ProtocolFamily, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  "grok-video": "https://api.x.ai/v1",
  cohere: "https://api.cohere.com/v2",
};

const configuredOffering = computed(
  () => !!props.offeringId && props.offeringId !== "compatible-api-key",
);
const providerIdentity = () =>
  configuredOffering.value ? { providerId: props.providerId, offeringId: props.offeringId } : {};
const editableRoutes = computed(() =>
  props.routeConfig ? props.routeConfig.mode === "editable" : !configuredOffering.value,
);
const groupByFamily = computed(() => Boolean(props.routeConfig?.groupByFamily));
const allowedProtocols = computed<readonly EndpointProtocol[]>(() =>
  props.routeConfig?.allowedProtocols.length
    ? props.routeConfig.allowedProtocols
    : defaultLegacyProtocols,
);

interface ProtocolItem {
  protocol: EndpointProtocol;
  label: string;
  example: string;
}
interface ProtocolFamilyGroup {
  family: ProtocolFamily;
  label: string;
  example: string;
  protocols: { protocol: EndpointProtocol; label: string }[];
}

const protocolItems = computed<ProtocolItem[]>(() =>
  allowedProtocols.value.map((protocol) => {
    const descriptor = modelEndpointDescriptor(protocol);
    const defaultRoute = props.routeConfig?.defaults.find((item) => item.protocol === protocol);
    return {
      protocol,
      label: descriptor.label,
      example: defaultRoute?.baseUrl ?? familyExamples[descriptor.protocolFamily],
    };
  }),
);

const familyGroups = computed<ProtocolFamilyGroup[]>(() => {
  const groups = new Map<ProtocolFamily, { protocol: EndpointProtocol; label: string }[]>();
  for (const protocol of allowedProtocols.value) {
    const descriptor = modelEndpointDescriptor(protocol);
    const list = groups.get(descriptor.protocolFamily) ?? [];
    list.push({ protocol, label: descriptor.label });
    groups.set(descriptor.protocolFamily, list);
  }
  return [...groups.entries()].map(([family, protocols]) => {
    const defaultRoute = props.routeConfig?.defaults.find((item) =>
      protocols.some((entry) => entry.protocol === item.protocol),
    );
    return {
      family,
      label: protocols.length > 1 ? familyLabels[family] : protocols[0]!.label,
      example: defaultRoute?.baseUrl ?? familyExamples[family],
      protocols,
    };
  });
});

const emit = defineEmits<{ close: []; saved: [] }>();
const service = useProviderService();
const context = { ...props.context };
const name = ref("");
const apiKey = ref("");
const accountIdentifier = ref("");
const urls = ref<Partial<Record<EndpointProtocol, string>>>({});
const familyUrls = ref<Partial<Record<ProtocolFamily, string>>>({});
const enabledProtocols = ref<Partial<Record<EndpointProtocol, boolean>>>({});
const versions = ref<Partial<Record<EndpointProtocol, string>>>({});
const preservedRoutes = ref<
  Partial<Record<EndpointProtocol, Pick<ModelRouteInput, "requestRule" | "chatOutputLimitField">>>
>({});
const revision = ref("");
const reloadNeeded = ref(false);
// Non-localhost HTTP Web hosts also support getRandomValues.
const operationId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
  n.toString(16).padStart(2, "0"),
).join("");
const busy = ref(false);
const error = ref("");
let disposed = false;

function resetRouteInputs(): void {
  const nextUrls: Partial<Record<EndpointProtocol, string>> = {};
  const nextEnabled: Partial<Record<EndpointProtocol, boolean>> = {};
  for (const protocol of allowedProtocols.value) {
    nextUrls[protocol] = "";
    nextEnabled[protocol] = false;
  }
  const nextFamilyUrls: Partial<Record<ProtocolFamily, string>> = {};
  for (const group of familyGroups.value) nextFamilyUrls[group.family] = "";
  urls.value = nextUrls;
  familyUrls.value = nextFamilyUrls;
  enabledProtocols.value = nextEnabled;
  versions.value = {};
  preservedRoutes.value = {};
}

function applyDefaults(): void {
  resetRouteInputs();
  if (!editableRoutes.value) return;
  const defaults = props.routeConfig?.defaults ?? [];
  const allowedSet = new Set(allowedProtocols.value);
  for (const group of familyGroups.value) {
    const familyDefaults = defaults.filter(
      (item) =>
        allowedSet.has(item.protocol) &&
        modelEndpointDescriptor(item.protocol).protocolFamily === group.family,
    );
    if (familyDefaults.length) {
      familyUrls.value[group.family] = familyDefaults[0]!.baseUrl;
      for (const entry of group.protocols) {
        const match = familyDefaults.find((item) => item.protocol === entry.protocol);
        enabledProtocols.value[entry.protocol] = Boolean(match);
        if (match) {
          urls.value[entry.protocol] = match.baseUrl;
          if (match.protocolVersion) versions.value[entry.protocol] = match.protocolVersion;
        }
      }
    } else {
      for (const entry of group.protocols) {
        enabledProtocols.value[entry.protocol] = true;
      }
    }
  }
}

if (!props.accountId) applyDefaults();

const anthropicDefaultVersion = computed(
  () =>
    props.routeConfig?.defaults.find((item) => item.protocol === "anthropic-messages")
      ?.protocolVersion ?? "2023-06-01",
);

const showAnthropicVersion = computed(() => {
  if (!editableRoutes.value || !allowedProtocols.value.includes("anthropic-messages")) return false;
  if (groupByFamily.value) {
    const group = familyGroups.value.find((item) => item.family === "anthropic");
    if (!group || !(familyUrls.value.anthropic ?? "").trim()) return false;
    return group.protocols.length === 1 || Boolean(enabledProtocols.value["anthropic-messages"]);
  }
  return Boolean((urls.value["anthropic-messages"] ?? "").trim());
});

function buildRoutes(): ModelRouteInput[] {
  if (!editableRoutes.value) return [];
  const routes: ModelRouteInput[] = [];
  if (groupByFamily.value) {
    for (const group of familyGroups.value) {
      const baseUrl = (familyUrls.value[group.family] ?? "").trim();
      if (!baseUrl) continue;
      const multi = group.protocols.length > 1;
      for (const entry of group.protocols) {
        if (multi && !enabledProtocols.value[entry.protocol]) continue;
        const preserved = preservedRoutes.value[entry.protocol];
        routes.push({
          protocol: entry.protocol,
          baseUrl,
          protocolVersion: versions.value[entry.protocol]?.trim() || null,
          ...(preserved?.requestRule !== undefined ? { requestRule: preserved.requestRule } : {}),
          ...(preserved?.chatOutputLimitField !== undefined
            ? { chatOutputLimitField: preserved.chatOutputLimitField }
            : {}),
        });
      }
    }
    return routes;
  }
  for (const protocol of allowedProtocols.value) {
    const baseUrl = (urls.value[protocol] ?? "").trim();
    if (!baseUrl) continue;
    const preserved = preservedRoutes.value[protocol];
    routes.push({
      protocol,
      baseUrl,
      protocolVersion: versions.value[protocol]?.trim() || null,
      ...(preserved?.requestRule !== undefined ? { requestRule: preserved.requestRule } : {}),
      ...(preserved?.chatOutputLimitField !== undefined
        ? { chatOutputLimitField: preserved.chatOutputLimitField }
        : {}),
    });
  }
  return routes;
}

const valid = computed(
  () =>
    Boolean(name.value.trim()) &&
    Boolean(props.accountId ? revision.value : apiKey.value.trim()) &&
    (!editableRoutes.value || buildRoutes().length > 0),
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
    resetRouteInputs();
    const allowedSet = new Set(allowedProtocols.value);
    const populatedFamilies = new Set<ProtocolFamily>();
    for (const route of connection.routes) {
      if (!allowedSet.has(route.protocol)) continue;
      const family = modelEndpointDescriptor(route.protocol).protocolFamily;
      urls.value[route.protocol] = route.baseUrl;
      familyUrls.value[family] = route.baseUrl;
      enabledProtocols.value[route.protocol] = true;
      versions.value[route.protocol] = route.protocolVersion ?? "";
      populatedFamilies.add(family);
      if (route.requestRule !== undefined || route.chatOutputLimitField !== undefined) {
        preservedRoutes.value[route.protocol] = {
          ...(route.requestRule !== undefined ? { requestRule: route.requestRule } : {}),
          ...(route.chatOutputLimitField !== undefined
            ? { chatOutputLimitField: route.chatOutputLimitField }
            : {}),
        };
      }
    }
    for (const group of familyGroups.value) {
      if (populatedFamilies.has(group.family)) continue;
      for (const entry of group.protocols) {
        enabledProtocols.value[entry.protocol] = true;
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
  const routes = buildRoutes();
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
      <fieldset v-if="editableRoutes" class="api-key-panel" :disabled="busy">
        <legend>协议基础地址</legend>
        <p>至少填写一种协议的 API 根地址。密钥将发送到填写的地址。</p>
        <template v-if="groupByFamily">
          <template v-for="group in familyGroups" :key="group.family">
            <label :for="`route-family-${group.family}`">{{ group.label }}</label>
            <input
              :id="`route-family-${group.family}`"
              v-model="familyUrls[group.family]"
              type="url"
              :placeholder="group.example"
              spellcheck="false"
            />
            <div v-if="group.protocols.length > 1 && familyUrls[group.family]?.trim()">
              <label v-for="entry in group.protocols" :key="entry.protocol">
                <input v-model="enabledProtocols[entry.protocol]" type="checkbox" />
                {{ entry.label }}
              </label>
            </div>
          </template>
        </template>
        <template v-else>
          <template v-for="item in protocolItems" :key="item.protocol">
            <label :for="`route-${item.protocol}`">{{ item.label }}</label>
            <input
              :id="`route-${item.protocol}`"
              v-model="urls[item.protocol]"
              type="url"
              :placeholder="item.example"
              spellcheck="false"
            />
          </template>
        </template>
        <template v-if="showAnthropicVersion">
          <label for="anthropic-version">Anthropic 协议版本</label>
          <input
            id="anthropic-version"
            v-model="versions['anthropic-messages']"
            :placeholder="anthropicDefaultVersion"
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
