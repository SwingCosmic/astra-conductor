<script setup lang="ts">
import { ref } from "vue";
import { parseModelRouteInput, type ModelRouteInput } from "@astra-conductor/contract/common";
const props = defineProps<{ route: ModelRouteInput }>();
const emit = defineEmits<{ change: [rule: ModelRouteInput["requestRule"]] }>();
const raw = ref(props.route.requestRule ? JSON.stringify(props.route.requestRule, null, 2) : "");
const error = ref("");
function update(input: HTMLTextAreaElement) {
  error.value = "";
  try {
    const rule = raw.value.trim()
      ? parseModelRouteInput({
          protocol: props.route.protocol,
          baseUrl: "https://example.invalid",
          requestRule: JSON.parse(raw.value),
        }).requestRule
      : undefined;
    emit("change", rule);
  } catch (cause) {
    error.value =
      cause instanceof SyntaxError
        ? "请求规则需要有效的 JSON 对象"
        : cause instanceof Error
          ? cause.message
          : "请求规则无效";
  }
  input.setCustomValidity(error.value);
}
</script>
<template>
  <details>
    <summary>模型别名与请求规则</summary>
    <label class="graph-field"
      >当前端点的聊天规则（JSON）
      <textarea
        v-model="raw"
        rows="6"
        spellcheck="false"
        placeholder='{"operation":"chat","aliases":{"work":"vendor/model"},"targets":["vendor/model"]}'
        @input="update($event.target as HTMLTextAreaElement)"
      />
    </label>
    <p class="setting-hint">
      可用 models 限定本地型号，targets 登记允许的上游型号。defaults 设置参数默认值，byModel
      按精确型号覆盖。modelTemplate 可用 {model}、{effort} 和 {windowLabel}，consume
      声明已写入名称的参数，headers、body 可追加扩展字段。
    </p>
    <p v-if="error" class="form-message" role="alert">{{ error }}</p>
  </details>
</template>
