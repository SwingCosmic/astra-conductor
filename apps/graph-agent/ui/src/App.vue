<script setup lang="ts">
import { ref } from "vue";
import type { PublicAccount } from "@astra-conductor/contract/common";
import { AppShell, CredentialsPage, ProvidersPage } from "@astra-conductor/shared-ui";
import icon from "../../assets/icons/graphagent.svg";
import TestChatPage from "./pages/TestChatPage.vue";
import ModelsPage from "./pages/ModelsPage.vue";
import CustomProvidersPanel from "./pages/CustomProvidersPanel.vue";
import "./pages/models.css";
const active = ref("home"),
  account = ref<PublicAccount>(),
  editor = ref<InstanceType<typeof ModelsPage>>(),
  focusAccount = ref<PublicAccount>();
const version = String(import.meta.env.VITE_APP_VERSION);
const navigation = [
  { id: "home", label: "测试对话", icon: "☏" },
  { id: "models", label: "模型配置", icon: "◇" },
  { id: "providers", label: "供应商", icon: "◈" },
  { id: "credentials", label: "凭据管理", icon: "⚙" },
];
async function navigate(id: string, fromAccount?: PublicAccount) {
  if (id === active.value) return;
  if (active.value === "models" && editor.value && !(await editor.value.mayLeave())) return;
  focusAccount.value = active.value === "models" && id === "providers" ? account.value : undefined;
  account.value = fromAccount;
  active.value = id;
}
</script>
<template>
  <AppShell
    :brand="{ name: 'GraphAgent', icon, version, theme: 'purple' }"
    :navigation="navigation"
    :active-id="active"
    @navigate="navigate($event)"
  >
    <ProvidersPage
      v-if="active === 'providers'"
      hide-compatible-template
      :focus-account="focusAccount"
    >
      <template #custom-providers="{ snapshot, reload }"
        ><CustomProvidersPanel
          :snapshot="snapshot"
          :focus-account="focusAccount?.id"
          @reload="reload"
          @models="navigate('models', $event)"
      /></template>
      <template #account-actions="{ account: a, connection }"
        ><button
          v-if="connection?.routes?.length"
          :id="'model-for-' + a.id"
          class="outline-action"
          @click="navigate('models', a)"
        >
          模型配置
        </button></template
      ></ProvidersPage
    >
    <CredentialsPage v-else-if="active === 'credentials'" :show-back="false" />
    <ModelsPage
      v-else-if="active === 'models'"
      ref="editor"
      :initial-account="account"
      @providers="navigate('providers')"
      @chat="navigate('home')"
    />
    <TestChatPage v-else @configure="navigate('models')" />
  </AppShell>
</template>
