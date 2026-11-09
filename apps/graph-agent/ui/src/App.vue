<script setup lang="ts">
import { ref } from "vue";
import { AppShell, CredentialsPage, ProvidersPage } from "@astra-conductor/shared-ui";
import icon from "../../assets/icons/graphagent.svg";

const active = ref("home");
const version = String(import.meta.env.VITE_APP_VERSION);
const navigation = [
  { id: "home", label: "主页", icon: "⌂" },
  { id: "providers", label: "供应商", icon: "◈" },
  { id: "credentials", label: "凭据管理", icon: "⚙" },
];
</script>

<template>
  <AppShell
    :brand="{ name: 'GraphAgent', icon, version, theme: 'purple' }"
    :navigation="navigation"
    :active-id="active"
    @navigate="active = $event"
  >
    <ProvidersPage v-if="active === 'providers'" />
    <CredentialsPage v-else-if="active === 'credentials'" :show-back="false" />
    <main v-else aria-label="GraphAgent 主页" />
  </AppShell>
</template>
