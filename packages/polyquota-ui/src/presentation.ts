import bigmodelIcon from "./assets/icon/bigmodel.svg";
import gptIcon from "./assets/icon/gpt.png";
import zaiIcon from "./assets/icon/zai.svg";
import type {
  AuthMethod,
  GlmRegion,
  ProviderId,
  PublicAccount,
  UsageExtra,
  UsageQuota,
  UsageQuotaGroup,
} from "./models";

export interface AuthMethodPresentation {
  id: AuthMethod;
  label: string;
}

export interface ProviderPresentation {
  id: string;
  provider: ProviderId;
  region?: GlmRegion;
  name: string;
  description: string;
  mark: string;
  icon?: string;
  websiteUrl?: string;
  available: boolean;
  authMethods: AuthMethodPresentation[];
  planLabels: Record<string, string>;
  quotaLabels: Record<string, string>;
  groupLabels: Record<string, string>;
  extraLabels: Record<string, string>;
  extraItemLabels: Record<string, string>;
}

const authMethods: Record<AuthMethod, AuthMethodPresentation> = {
  "browser-oauth": {
    id: "browser-oauth",
    label: "浏览器 OAuth",
  },
  "device-code": {
    id: "device-code",
    label: "设备码",
  },
  "cli-import": {
    id: "cli-import",
    label: "Codex CLI",
  },
  "api-key": {
    id: "api-key",
    label: "API Key",
  },
};

const zcodeImport: AuthMethodPresentation = {
  id: "cli-import",
  label: "ZCode",
};

export const providers: ProviderPresentation[] = [
  {
    id: "codex",
    provider: "codex",
    name: "OpenAI Codex",
    description: "查看 ChatGPT 订阅中的 Codex 用量。",
    mark: "◎",
    icon: gptIcon,
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
    extraItemLabels: {},
  },
  {
    id: "bigmodel-coding-plan",
    provider: "glm",
    region: "china",
    name: "BigModel Coding Plan",
    description: "智谱国内 Coding Plan，查看 5 小时、周配额和重置卡。",
    mark: "",
    icon: bigmodelIcon,
    websiteUrl: "https://bigmodel.cn/coding-plan/personal/overview",
    available: true,
    authMethods: [zcodeImport, authMethods["api-key"]],
    planLabels: {
      lite: "Lite",
      pro: "Pro",
      max: "Max",
      "glm coding lite": "Lite",
      "glm coding pro": "Pro",
      "glm coding max": "Max",
    },
    quotaLabels: { session: "5 Hours Quota", weekly: "Weekly Quota", mcp_monthly: "Monthly" },
    groupLabels: {},
    extraLabels: { "reset-credits": "重置卡" },
    extraItemLabels: { "five-hour": "5 小时使用周期", weekly: "每周使用周期" },
  },
  {
    id: "zai-coding-plan",
    provider: "glm",
    region: "international",
    name: "Z.ai Coding Plan",
    description: "智谱国际版 Coding Plan，查看 5 小时、周配额和重置卡。",
    mark: "",
    icon: zaiIcon,
    websiteUrl: "https://z.ai/manage-apikey/apikey-list",
    available: true,
    authMethods: [zcodeImport, authMethods["api-key"]],
    planLabels: {
      lite: "Lite",
      pro: "Pro",
      max: "Max",
      "glm coding lite": "Lite",
      "glm coding pro": "Pro",
      "glm coding max": "Max",
    },
    quotaLabels: { session: "5 Hours Quota", weekly: "Weekly Quota", mcp_monthly: "Monthly" },
    groupLabels: {},
    extraLabels: { "reset-credits": "重置卡" },
    extraItemLabels: { "five-hour": "5 小时使用周期", weekly: "每周使用周期" },
  },
  {
    id: "grok-build",
    provider: "grok-build",
    name: "Grok Build",
    description: "查看 Grok Build 订阅用量。",
    mark: "X",
    available: false,
    authMethods: [authMethods["api-key"]],
    planLabels: {},
    quotaLabels: {},
    groupLabels: {},
    extraLabels: {},
    extraItemLabels: {},
  },
  {
    id: "antigravity",
    provider: "antigravity",
    name: "Antigravity",
    description: "查看 Antigravity 订阅用量。",
    mark: "A",
    available: false,
    authMethods: [authMethods["browser-oauth"], authMethods["api-key"]],
    planLabels: {},
    quotaLabels: {},
    groupLabels: {},
    extraLabels: {},
    extraItemLabels: {},
  },
];

export function accountPresentationId(account: PublicAccount): string {
  if (account.provider !== "glm") return account.provider;
  if (typeof account.publicMetadata.presentationId === "string") {
    return account.publicMetadata.presentationId;
  }
  return account.publicMetadata.region === "china" ? "bigmodel-coding-plan" : "zai-coding-plan";
}

export function providerPresentation(
  providerOrAccount: ProviderId | PublicAccount,
): ProviderPresentation {
  const id =
    typeof providerOrAccount === "string"
      ? providerOrAccount
      : accountPresentationId(providerOrAccount);
  return (
    providers.find((item) => item.id === id) ??
    providers.find((item) => item.provider === id) ??
    providers[0]!
  );
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

export function planLabel(provider: ProviderId | PublicAccount, plan: string): string {
  const value = plan.trim();
  if (!value) return "未提供";
  return providerPresentation(provider).planLabels[value.toLowerCase()] ?? value;
}

export function quotaLabel(provider: ProviderId | PublicAccount, quota: UsageQuota): string {
  const presentation = providerPresentation(provider);
  const duration = windowLabel(quota.windowSeconds);
  const nativeName = quota.displayName?.trim();
  if (nativeName && duration && /^(session|weekly|monthly)$/i.test(nativeName)) {
    return duration;
  }
  const mapped = presentation.quotaLabels[quota.key];
  if (mapped) return mapped;
  if (nativeName && duration && !nativeName.toLowerCase().includes(duration.toLowerCase())) {
    return `${nativeName} · ${duration}`;
  }
  return nativeName || duration || quota.key.replaceAll("_", " ");
}

export function groupLabel(
  provider: ProviderId | PublicAccount,
  group: UsageQuotaGroup,
): string | null {
  return group.displayName ?? providerPresentation(provider).groupLabels[group.key] ?? null;
}

export function extraLabel(provider: ProviderId | PublicAccount, extra: UsageExtra): string {
  return providerPresentation(provider).extraLabels[extra.key] ?? extra.key.replaceAll("-", " ");
}

export function extraItemLabel(provider: ProviderId | PublicAccount, kind: string): string {
  return providerPresentation(provider).extraItemLabels[kind] ?? kind.replaceAll("-", " ");
}

export function authMethodLabel(method: AuthMethod, provider?: ProviderId): string {
  if (method === "cli-import" && provider === "glm") return zcodeImport.label;
  return authMethods[method].label;
}
