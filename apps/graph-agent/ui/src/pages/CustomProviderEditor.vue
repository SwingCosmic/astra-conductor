<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { ConfigField, FormDialog } from "@astra-conductor/shared-ui";
import {
  modelEndpointDescriptors,
  parseFamilyPolicy,
  type ProtocolFamily,
  type ProtocolFamilyPolicy,
  type ModelRouteInput,
} from "@astra-conductor/contract/common";
import type {
  CustomOffering,
  CustomProvider,
  CustomProviderDraft,
  CustomProviderTemplateKind,
} from "@astra-conductor/contract/graph-agent";
import ModelRequestRuleEditor from "./ModelRequestRuleEditor.vue";
import { graphServiceKey } from "../services/graph-agent-service";
const props = defineProps<{
  provider?: CustomProvider;
  account?: { accountId: string; expectedRevision: string };
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const service = inject(graphServiceKey)!;
const uid = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
const newApiRoutes = ["openai-chat", "openai-responses", "anthropic-messages"] as const;
function newOffering(templateKind: CustomProviderTemplateKind = "generic"): CustomOffering {
  const ids = templateKind === "new-api" ? newApiRoutes : (["openai-chat"] as const);
  return {
    offeringId: "o-" + uid(),
    name: templateKind === "new-api" ? "默认接入点" : "",
    ...(templateKind === "new-api" && { siteBaseUrl: "" }),
    routes: ids.map((protocol) => ({ protocol, baseUrl: "", protocolVersion: null })),
  };
}
const operationId = uid();
const original = props.provider;
const draft = ref<CustomProviderDraft>(
  original
    ? {
        templateKind: original.templateKind,
        name: original.name,
        icon: original.icon,
        offerings: original.offerings.map((o) => ({
          ...o,
          routes: o.routes.map((r) => ({ ...r })),
        })),
      }
    : { templateKind: "generic", name: "", icon: null, offerings: [newOffering()] },
);
const busy = ref(false),
  error = ref("");
const families = computed(() => [
  ...new Set(
    draft.value.offerings.flatMap((offering) =>
      offering.routes.flatMap((r) => {
        const family = info(r)?.protocolFamily;
        return family ? [family] : [];
      }),
    ),
  ),
]);
const policies = ref<
  Partial<
    Record<
      ProtocolFamily,
      {
        authentication: string;
        headers: string;
        query: string;
        body: string;
        disabledCatalog: boolean;
      }
    >
  >
>({});
function policy(family: ProtocolFamily) {
  return (policies.value[family] ??= {
    authentication: original?.familyPolicies?.[family]?.authentication ?? "",
    disabledCatalog: original?.familyPolicies?.[family]?.catalog === "none",
    headers: JSON.stringify(original?.familyPolicies?.[family]?.headers ?? {}, null, 2),
    query: JSON.stringify(original?.familyPolicies?.[family]?.query ?? {}, null, 2),
    body: JSON.stringify(original?.familyPolicies?.[family]?.body ?? {}, null, 2),
  });
}
function readPolicies() {
  const result: Partial<Record<ProtocolFamily, ProtocolFamilyPolicy>> = {
    ...original?.familyPolicies,
  };
  for (const family of families.value) {
    const fields = policy(family);
    const parsed = parseFamilyPolicy({
      authentication: fields.authentication || undefined,
      catalog: fields.disabledCatalog ? "none" : undefined,
      headers: JSON.parse(fields.headers || "{}"),
      query: JSON.parse(fields.query || "{}"),
      body: JSON.parse(fields.body || "{}"),
    });
    if (Object.keys(parsed).length) result[family] = parsed;
    else delete result[family];
  }
  return result;
}
function peers(offering: CustomOffering, route: ModelRouteInput) {
  const family = info(route)?.protocolFamily;
  return offering.routes.filter(
    (r) => r === route || (family && info(r)?.protocolFamily === family),
  );
}
function info(route: ModelRouteInput) {
  return modelEndpointDescriptors.find((d) => d.protocol === route.protocol);
}
function setFamilyRoot(offering: CustomOffering, route: ModelRouteInput, value: string) {
  for (const member of peers(offering, route)) {
    member.baseUrl = value;
    member.protocolVersion = route.protocolVersion;
  }
}
function setRequestRule(route: ModelRouteInput, rule: ModelRouteInput["requestRule"]) {
  if (rule === undefined) delete route.requestRule;
  else route.requestRule = rule;
}
function selectEndpoint(offering: CustomOffering, route: ModelRouteInput) {
  delete route.requestRule;
  delete route.chatOutputLimitField;
  const peer = peers(offering, route).find((r) => r !== route);
  route.protocolVersion = peer?.protocolVersion ?? null;
  if (peer) route.baseUrl = peer.baseUrl;
}
function selectTemplate() {
  if (draft.value.templateKind !== "new-api") return;
  for (const offering of draft.value.offerings) {
    offering.siteBaseUrl ??= "";
    if (
      offering.routes.length === 1 &&
      offering.routes[0].protocol === "openai-chat" &&
      !offering.routes[0].baseUrl
    ) {
      offering.routes = newApiRoutes.map((protocol) => ({ protocol, baseUrl: "" }));
    }
    if (!offering.name) offering.name = "默认接入点";
  }
}
function defaultEndpoint(site?: string) {
  const base = site?.trim().replace(/\/+$/, "");
  return base ? base + "/v1" : "";
}
function updateSite(offering: CustomOffering, site: string) {
  const previousEndpoint = defaultEndpoint(offering.siteBaseUrl);
  offering.siteBaseUrl = site;
  for (const route of offering.routes) {
    if (!route.baseUrl || route.baseUrl === previousEndpoint) route.baseUrl = defaultEndpoint(site);
  }
}
function addEndpoint(offering: CustomOffering) {
  const next = modelEndpointDescriptors.find(
    (d) => !offering.routes.some((r) => r.protocol === d.protocol),
  );
  if (next) {
    const route = {
      protocol: next.protocol,
      baseUrl: draft.value.templateKind === "new-api" ? defaultEndpoint(offering.siteBaseUrl) : "",
    };
    offering.routes.push(route);
    selectEndpoint(offering, offering.routes[offering.routes.length - 1]);
  }
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const input: CustomProviderDraft = {
      familyPolicies: readPolicies(),
      templateKind: draft.value.templateKind,
      name: draft.value.name.trim(),
      icon: draft.value.icon?.trim() || null,
      offerings: draft.value.offerings.map((o) => ({
        offeringId: o.offeringId,
        name: o.name.trim(),
        ...(draft.value.templateKind === "new-api" && { siteBaseUrl: o.siteBaseUrl?.trim() }),
        routes: o.routes.map((r) => {
          const { requestRule, ...rest } = r;
          return {
            ...rest,
            protocol: r.protocol,
            baseUrl: r.baseUrl.trim(),
            protocolVersion: r.protocolVersion || null,
            ...(requestRule !== undefined ? { requestRule } : {}),
          };
        }),
      })),
    };
    const result = original
      ? await service.customProviders.edit(original.providerId, {
          ...input,
          expectedRevision: original.revision,
        })
      : props.account
        ? await service.customProviders.configureForAccount({ ...input, ...props.account })
        : await service.customProviders.create({ ...input, operationId });
    if (!result.ok) throw Error(result.error.message);
    emit("saved");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "供应商保存失败";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <FormDialog
    :class="{ 'new-api-editor': draft.templateKind === 'new-api' }"
    :title="original ? '编辑自定义供应商' : account ? '配置此账号的供应商' : '创建自定义供应商'"
    @close="!busy && emit('close')"
  >
    <form @submit.prevent="save">
      <fieldset class="plain-fields" :disabled="busy">
        <div class="graph-grid">
          <ConfigField label="供应商模板">
            <select v-model="draft.templateKind" :disabled="!!original" @change="selectTemplate">
              <option value="generic">通用兼容接口</option>
              <option value="new-api">New API 中转站</option>
            </select>
          </ConfigField>
          <ConfigField label="供应商名称"
            ><input v-model="draft.name" required maxlength="128" autofocus /></ConfigField
          ><ConfigField label="图标（可选）"
            ><input v-model="draft.icon" placeholder="图标地址"
          /></ConfigField>
        </div>
        <fieldset
          v-for="(offering, oi) in draft.offerings"
          :key="offering.offeringId"
          class="offering-form"
        >
          <legend>{{ offering.name || "接入点" }}</legend>
          <ConfigField label="接入点名称"
            ><input v-model="offering.name" required maxlength="128" placeholder="例如：国内接入点"
          /></ConfigField>
          <ConfigField
            v-if="draft.templateKind === 'new-api'"
            label="New API 站点地址"
            source="可包含部署子路径，省略 /api 和 /v1。"
          >
            <input
              :value="offering.siteBaseUrl"
              type="url"
              required
              placeholder="https://relay.example"
              @input="updateSite(offering, ($event.target as HTMLInputElement).value)"
            />
          </ConfigField>
          <div
            v-for="(route, ri) in offering.routes"
            :key="ri"
            class="endpoint-row"
            :class="{ versioned: route.protocol === 'anthropic-messages' }"
          >
            <ConfigField label="端点种类"
              ><select v-model="route.protocol" @change="selectEndpoint(offering, route)">
                <option v-if="!info(route)" :value="route.protocol" disabled>
                  未注册 · {{ route.protocol }}
                </option>
                <option
                  v-for="d in modelEndpointDescriptors"
                  :key="d.protocol"
                  :value="d.protocol"
                  :disabled="offering.routes.some((r, i) => i !== ri && r.protocol === d.protocol)"
                >
                  {{ d.label }}
                </option>
              </select></ConfigField
            >
            <ConfigField
              label="API 根地址"
              :source="info(route) ? info(route)?.protocolFamily + ' 族共用' : '此端点需重新配置'"
              ><input
                :value="route.baseUrl"
                @input="setFamilyRoot(offering, route, ($event.target as HTMLInputElement).value)"
                type="url"
                required
                placeholder="https://relay.example/v1"
            /></ConfigField>
            <p
              v-if="
                peers(offering, route).some(
                  (r) => r.baseUrl !== route.baseUrl || r.protocolVersion !== route.protocolVersion,
                )
              "
              class="form-message"
            >
              同族存量配置有差异，<button
                type="button"
                @click="setFamilyRoot(offering, route, route.baseUrl)"
              >
                整族采用此地址和版本
              </button>
            </p>
            <ModelRequestRuleEditor
              v-if="info(route)?.chatExecutable"
              :key="offering.offeringId + route.protocol"
              :route="route"
              @change="setRequestRule(route, $event)"
            />
            <ConfigField v-if="route.protocol === 'openai-chat'" label="输出上限字段"
              ><select v-model="route.chatOutputLimitField">
                <option value="max_completion_tokens">max_completion_tokens</option>
                <option value="max_tokens">max_tokens</option>
              </select></ConfigField
            >
            <ConfigField v-if="route.protocol === 'anthropic-messages'" label="协议版本"
              ><input v-model="route.protocolVersion" placeholder="2023-06-01"
            /></ConfigField>
            <button
              type="button"
              :disabled="offering.routes.length === 1"
              @click="offering.routes.splice(ri, 1)"
            >
              移除端点
            </button>
          </div>
          <div class="graph-actions">
            <button
              type="button"
              :disabled="offering.routes.length >= modelEndpointDescriptors.length"
              @click="addEndpoint(offering)"
            >
              添加端点
            </button>
            <button
              type="button"
              class="danger-text"
              :disabled="draft.offerings.length === 1"
              @click="draft.offerings.splice(oi, 1)"
            >
              移除接入点
            </button>
          </div>
        </fieldset>
        <button
          type="button"
          class="outline-action"
          @click="draft.offerings.push(newOffering(draft.templateKind))"
        >
          添加接入点
        </button>
        <details v-for="family in families" :key="family">
          <summary>{{ family }} 族认证与公共参数</summary>
          <ConfigField label="认证机制"
            ><select v-model="policy(family).authentication">
              <option value="">协议默认</option>
              <option value="bearer">Bearer</option>
              <option value="x-api-key">x-api-key</option>
              <option value="x-goog-api-key">x-goog-api-key</option>
            </select></ConfigField
          >
          <label
            ><input
              type="checkbox"
              v-model="policy(family).disabledCatalog"
            />该站点未提供此族的模型列表</label
          >
          <ConfigField label="公共请求头（JSON）" source="填写非秘密参数，例如 x-tenant。">
            <textarea v-model="policy(family).headers" rows="2" />
          </ConfigField>
          <ConfigField label="公共查询参数（JSON）">
            <textarea v-model="policy(family).query" rows="2" />
          </ConfigField>
          <ConfigField label="公共请求体扩展（JSON）" source="应用于该协议族的试聊请求。">
            <textarea v-model="policy(family).body" rows="2" />
          </ConfigField>
        </details>
      </fieldset>
      <p v-if="error" role="alert" class="form-message">{{ error }}</p>
      <footer>
        <button type="button" :disabled="busy" @click="emit('close')">取消</button
        ><button class="primary-action" :disabled="busy">保存供应商</button>
      </footer>
    </form>
  </FormDialog>
</template>
<style scoped>
.new-api-editor {
  width: min(780px, calc(100% - 24px));
}
@media (min-width: 800px) {
  .new-api-editor .endpoint-row {
    grid-template-columns: minmax(190px, 1fr) minmax(220px, 2fr) auto;
  }
  .new-api-editor .endpoint-row.versioned {
    grid-template-columns: minmax(190px, 1fr) minmax(220px, 1.6fr) minmax(104px, 0.6fr) auto;
  }
}
</style>
