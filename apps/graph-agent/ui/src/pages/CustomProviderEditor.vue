<script setup lang="ts">
import { inject, ref } from "vue";
import { ConfigField, FormDialog } from "@astra-conductor/shared-ui";
import { modelEndpointDescriptors, type ModelRouteInput } from "@astra-conductor/contract/common";
import type { CustomProvider, CustomProviderDraft } from "@astra-conductor/contract/graph-agent";
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
const newOffering = () => ({
  offeringId: "o-" + uid(),
  name: "",
  routes: [
    {
      protocolRouteId: "openai-chat",
      baseUrl: "",
      protocolVersion: null,
    } satisfies ModelRouteInput,
  ],
});
const operationId = uid();
const original = props.provider;
const draft = ref<CustomProviderDraft>(
  original
    ? {
        name: original.name,
        icon: original.icon,
        offerings: original.offerings.map((o) => ({
          ...o,
          routes: o.routes.map((r) => ({ ...r })),
        })),
      }
    : { name: "", icon: null, offerings: [newOffering()] },
);
const busy = ref(false),
  error = ref("");
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const input: CustomProviderDraft = {
      name: draft.value.name.trim(),
      icon: draft.value.icon?.trim() || null,
      offerings: draft.value.offerings.map((o) => ({
        offeringId: o.offeringId,
        name: o.name.trim(),
        routes: o.routes.map((r) => ({
          protocolRouteId: r.protocolRouteId,
          baseUrl: r.baseUrl.trim(),
          protocolVersion: r.protocolVersion || null,
        })),
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
    :title="original ? '编辑自定义供应商' : account ? '配置此账号的供应商' : '创建自定义供应商'"
    @close="!busy && emit('close')"
  >
    <form @submit.prevent="save">
      <fieldset class="plain-fields" :disabled="busy">
        <div class="graph-grid">
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
          <div v-for="(route, ri) in offering.routes" :key="ri" class="endpoint-row">
            <ConfigField label="端点种类"
              ><select v-model="route.protocolRouteId" @change="route.protocolVersion = null">
                <option
                  v-for="d in modelEndpointDescriptors"
                  :key="d.id"
                  :value="d.id"
                  :disabled="offering.routes.some((r, i) => i !== ri && r.protocolRouteId === d.id)"
                >
                  {{ d.label }}
                </option>
              </select></ConfigField
            >
            <ConfigField label="API 根地址"
              ><input
                v-model="route.baseUrl"
                type="url"
                required
                placeholder="https://relay.example/v1"
            /></ConfigField>
            <ConfigField v-if="route.protocolRouteId === 'anthropic-messages'" label="协议版本"
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
              @click="
                offering.routes.push({
                  protocolRouteId: modelEndpointDescriptors.find(
                    (d) => !offering.routes.some((r) => r.protocolRouteId === d.id),
                  )!.id,
                  baseUrl: '',
                })
              "
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
        <button type="button" class="outline-action" @click="draft.offerings.push(newOffering())">
          添加接入点
        </button>
      </fieldset>
      <p v-if="error" role="alert" class="form-message">{{ error }}</p>
      <footer>
        <button type="button" :disabled="busy" @click="emit('close')">取消</button
        ><button class="primary-action" :disabled="busy">保存供应商</button>
      </footer>
    </form>
  </FormDialog>
</template>
