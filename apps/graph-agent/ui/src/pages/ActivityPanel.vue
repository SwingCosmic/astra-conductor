<script setup lang="ts">
import type { Activity } from "./chat-content";
defineProps<{ activity: Activity; expanded: boolean }>();
defineEmits<{ toggle: [] }>();
const labels = { running: "进行中", completed: "已完成", failed: "失败", cancelled: "已中止" };
</script>
<template>
  <div class="ai-activity" :class="'ai-activity--' + activity.state" :data-kind="activity.kind">
    <button class="ai-activity__summary" :aria-expanded="expanded" @click="$emit('toggle')">
      <span>思考过程</span>
      <small>{{ labels[activity.state] }}</small>
      <span aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
    </button>
    <div v-if="expanded" class="ai-activity__thought">
      {{ activity.text || "接口报告了思考活动，但未提供可展示的文字。" }}
    </div>
  </div>
</template>
<style scoped>
.ai-activity {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.ai-activity__summary {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  padding: 0.6rem 0.8rem;
  border: 0;
  font: inherit;
  cursor: pointer;
  color: var(--text-primary);
  background: var(--brand-selected);
}
.ai-activity__summary small {
  margin-left: auto;
}
.ai-activity__thought {
  padding: 0.7rem 0.9rem;
  color: var(--text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
</style>
