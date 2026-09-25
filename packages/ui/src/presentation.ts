import type { AuthMethod, ProviderId, UsageExtra, UsageQuota, UsageQuotaGroup } from "./models";

export interface AuthMethodPresentation {
  id: AuthMethod;
  label: string;
  summary: string;
}

export interface ProviderPresentation {
  id: ProviderId;
  name: string;
  mark: string;
  available: boolean;
  authMethods: AuthMethodPresentation[];
  planLabels: Record<string, string>;
  quotaLabels: Record<string, string>;
  groupLabels: Record<string, string>;
  extraLabels: Record<string, string>;
}

const authMethods: Record<AuthMethod, AuthMethodPresentation> = {
  "browser-oauth": {
    id: "browser-oauth",
    label: "浏览器 OAuth",
    summary: "在浏览器完成授权，应用通过临时本地回调接收结果。",
  },
  "device-code": {
    id: "device-code",
    label: "设备码",
    summary: "复制设备码并在验证页面完成授权。",
  },
  "cli-import": {
    id: "cli-import",
    label: "Codex CLI",
    summary: "只读导入本机 Codex CLI 凭据，不修改原文件。",
  },
  "api-key": {
    id: "api-key",
    label: "API Key",
    summary: "填写服务商签发的 API Key 并验证有效性。",
  },
};

export const providers: ProviderPresentation[] = [
  {
    id: "codex",
    name: "OpenAI Codex",
    mark: "◎",
    available: true,
    authMethods: [
      authMethods["browser-oauth"],
      authMethods["device-code"],
      authMethods["cli-import"],
    ],
    planLabels: {
      prolite: "Pro 5x",
      free: "Free",
      go: "Go",
      plus: "Plus",
      pro: "Pro",
      team: "Team",
      enterprise: "Enterprise",
      edu: "Edu",
    },
    quotaLabels: {
      session: "5-hour",
      weekly: "Weekly",
      code_review: "Code review · 5-hour",
      code_review_weekly: "Code review · Weekly",
    },
    groupLabels: {},
    extraLabels: { "reset-credits": "Reset credits" },
  },
  {
    id: "glm",
    name: "GLM",
    mark: "Z",
    available: false,
    authMethods: [authMethods["api-key"]],
    planLabels: { lite: "Lite", pro: "Pro", max: "Max" },
    quotaLabels: {},
    groupLabels: {},
    extraLabels: {},
  },
  {
    id: "grok-build",
    name: "Grok Build",
    mark: "X",
    available: false,
    authMethods: [authMethods["api-key"]],
    planLabels: {},
    quotaLabels: {},
    groupLabels: {},
    extraLabels: {},
  },
  {
    id: "antigravity",
    name: "Antigravity",
    mark: "A",
    available: false,
    authMethods: [authMethods["browser-oauth"], authMethods["api-key"]],
    planLabels: {},
    quotaLabels: {},
    groupLabels: {},
    extraLabels: {},
  },
];

export function providerPresentation(provider: ProviderId): ProviderPresentation {
  return providers.find((item) => item.id === provider) ?? providers[0]!;
}

function windowLabel(seconds: number | null): string | null {
  if (seconds === 18_000) return "5-hour";
  if (seconds === 604_800) return "Weekly";
  if (seconds !== null && seconds >= 20 * 86_400) return "Monthly";
  if (seconds !== null && seconds > 0 && seconds % 3_600 === 0) {
    return `${seconds / 3_600}-hour`;
  }
  return null;
}

export function planLabel(provider: ProviderId, plan: string): string {
  const value = plan.trim();
  if (!value) return "未提供";
  return providerPresentation(provider).planLabels[value.toLowerCase()] ?? value;
}

export function quotaLabel(provider: ProviderId, quota: UsageQuota): string {
  const presentation = providerPresentation(provider);
  const mapped = presentation.quotaLabels[quota.key];
  if (mapped) return mapped;
  const duration = windowLabel(quota.windowSeconds);
  const nativeName = quota.displayName?.trim();
  if (nativeName && duration && !nativeName.toLowerCase().includes(duration.toLowerCase())) {
    return `${nativeName} · ${duration}`;
  }
  return nativeName || duration || quota.key.replaceAll("_", " ");
}

export function groupLabel(provider: ProviderId, group: UsageQuotaGroup): string | null {
  return group.displayName ?? providerPresentation(provider).groupLabels[group.key] ?? null;
}

export function extraLabel(provider: ProviderId, extra: UsageExtra): string {
  return providerPresentation(provider).extraLabels[extra.key] ?? extra.key.replaceAll("-", " ");
}

export function authMethodLabel(method: AuthMethod): string {
  return authMethods[method].label;
}
