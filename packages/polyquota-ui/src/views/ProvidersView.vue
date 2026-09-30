<script setup lang="ts">
import { computed, ref } from "vue";
import AuthModal from "../components/AuthModal.vue";
import type { PublicAccount } from "../models";
import { accountPresentationId, authMethodLabel, type ProviderPresentation } from "../presentation";

const props = defineProps<{
  accounts: PublicAccount[];
  presentations: ProviderPresentation[];
  busy: boolean;
}>();
const emit = defineEmits<{
  connected: [account: PublicAccount];
  refreshCredentials: [account: PublicAccount];
  toggle: [account: PublicAccount];
  remove: [account: PublicAccount];
}>();
const modalProvider = ref<ProviderPresentation | null>(null);
const expanded = ref(new Set<string>(["codex"]));

function providerAccounts(provider: ProviderPresentation): PublicAccount[] {
  return props.accounts.filter((account) => accountPresentationId(account) === provider.id);
}

function toggleExpanded(provider: ProviderPresentation): void {
  const next = new Set(expanded.value);
  if (next.has(provider.id)) next.delete(provider.id);
  else next.add(provider.id);
  expanded.value = next;
}

function hasRefreshableToken(account: PublicAccount): boolean {
  return (
    account.provider !== "glm" &&
    (account.authMethod === "browser-oauth" || account.authMethod === "device-code")
  );
}

function tokenExpiryLabel(value: string | null): string {
  if (!value) return "未提供";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function isTokenExpired(value: string | null): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

const connectedCount = computed(() => new Set(props.accounts.map(accountPresentationId)).size);
</script>

<template>
  <section class="content-page providers-page">
    <header class="content-header">
      <div>
        <h1>服务商接入</h1>
        <p>管理服务商与账号接入方式 · 已接入 {{ connectedCount }} 个服务商</p>
      </div>
    </header>
    <div class="provider-list">
      <article v-for="provider in presentations" :key="provider.id" class="provider-row">
        <div class="provider-summary">
          <span class="provider-mark">
            <img v-if="provider.icon" :src="provider.icon" alt="" />
            <template v-else>{{ provider.mark }}</template>
          </span>
          <div class="provider-title">
            <h2>{{ provider.name }}</h2>
            <p>
              <span
                class="status-dot"
                :class="{ connected: providerAccounts(provider).length }"
              />{{
                providerAccounts(provider).length
                  ? `已接入 · ${providerAccounts(provider).length} 个账号`
                  : provider.available
                    ? "尚未接入"
                    : "即将支持"
              }}
            </p>
            <p class="provider-description">{{ provider.description }}</p>
          </div>
          <div class="method-chips">
            <span v-for="method in provider.authMethods" :key="method.id">{{ method.label }}</span>
          </div>
          <button
            class="primary-action"
            :disabled="busy || !provider.available"
            @click="modalProvider = provider"
          >
            {{ providerAccounts(provider).length ? "添加账号" : "添加" }}
          </button>
          <button
            class="icon-button"
            :disabled="!providerAccounts(provider).length"
            :aria-label="expanded.has(provider.id) ? '收起账号' : '展开账号'"
            @click="toggleExpanded(provider)"
          >
            {{ expanded.has(provider.id) ? "⌃" : "⌄" }}
          </button>
        </div>
        <div
          v-if="expanded.has(provider.id) && providerAccounts(provider).length"
          class="provider-accounts"
        >
          <div
            v-for="account in providerAccounts(provider)"
            :key="account.id"
            class="provider-account-row"
          >
            <span class="account-avatar">♙</span>
            <div class="account-identity">
              <strong>{{ account.maskedIdentifier }}</strong>
              <span
                v-if="hasRefreshableToken(account)"
                class="token-expiry"
                :class="{ expired: isTokenExpired(account.tokenExpiresAt) }"
              >
                令牌到期：{{ tokenExpiryLabel(account.tokenExpiresAt)
                }}{{ isTokenExpired(account.tokenExpiresAt) ? "（已过期）" : "" }}
              </span>
            </div>
            <span class="method-chip">{{
              authMethodLabel(account.authMethod, account.provider)
            }}</span
            ><span class="account-state"
              ><i :class="{ off: !account.enabled }" />{{
                account.enabled ? "已启用" : "已停用"
              }}</span
            ><button
              v-if="hasRefreshableToken(account)"
              :disabled="busy"
              @click="emit('refreshCredentials', account)"
            >
              刷新令牌</button
            ><button :disabled="busy" @click="emit('toggle', account)">
              {{ account.enabled ? "停用" : "启用" }}</button
            ><button class="danger-text" :disabled="busy" @click="emit('remove', account)">
              删除
            </button>
          </div>
        </div>
      </article>
    </div>
    <AuthModal
      v-if="modalProvider"
      :provider="modalProvider"
      @close="modalProvider = null"
      @connected="
        (account) => {
          modalProvider = null;
          emit('connected', account);
        }
      "
    />
  </section>
</template>
