<script setup lang="ts">
import { ref, watch } from "vue";
const props = defineProps<{ name: string; icon?: string | null }>();
const failed = ref(false);
watch(
  () => props.icon,
  () => {
    failed.value = false;
  },
);
</script>
<template>
  <span class="provider-mark" aria-hidden="true"
    ><img v-if="icon && !failed" :src="icon" alt="" @error="failed = true" /><template v-else>{{
      name.charAt(0).toUpperCase()
    }}</template></span
  >
</template>
