<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId } from "vue";
defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const heading = useId();
let previousFocus: HTMLElement | null = null;
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  if (previousFocus?.isConnected) previousFocus.focus();
});
</script>
<template>
  <dialog
    ref="dialog"
    class="auth-modal form-dialog"
    :aria-labelledby="heading"
    @cancel.prevent="emit('close')"
  >
    <header>
      <h2 :id="heading">{{ title }}</h2>
      <button class="icon-button" type="button" aria-label="关闭" @click="emit('close')">×</button>
    </header>
    <slot />
  </dialog>
</template>
<style scoped>
.form-dialog {
  border: 0;
  color: var(--text-primary);
  max-height: 86dvh;
  overflow: auto;
}
.form-dialog::backdrop {
  background: #17203399;
}
</style>
