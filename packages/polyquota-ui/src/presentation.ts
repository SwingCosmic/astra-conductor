import antigravityIcon from "./assets/icon/antigravity.png";
import bigmodelIcon from "./assets/icon/bigmodel.svg";
import claudeIcon from "./assets/icon/claude.svg";
import gptIcon from "./assets/icon/gpt.png";
import grokIcon from "./assets/icon/grok.svg";
import opencodeIcon from "./assets/icon/opencode.png";
import zaiIcon from "./assets/icon/zai.svg";
import type {
  AuthMethod,
  GlmRegion,
  ProviderId,
  PublicAccount,
  PublicProviderDescriptor,
  PublicSystemStatus,
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
  cliImportPath?: string;
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

const grokCliImport: AuthMethodPresentation = {
  id: "cli-import",
  label: "Grok CLI",
};

const claudeCliImport: AuthMethodPresentation = {
  id: "cli-import",
  label: "Claude Code",
};

/**
 * 本地文案与视觉注册表，按 offering id 索引。接入哪些服务商、每家提供哪些
 * 认证方式由主进程快照中的 provider 目录决定；这里只补充图标、标签映射和
 * 目录缺失时的展示回退，不决定可用性。
 */
const presentationRegistry: ProviderPresentation[] = [
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
    cliImportPath: "~/.codex/auth.json",
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
    extraItemLabels: { banked: "Banked reset credit" },
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
    cliImportPath: "~/.zcode/v2/credentials.json",
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
    cliImportPath: "~/.zcode/v2/credentials.json",
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
    mark: "",
    icon: grokIcon,
    available: true,
    authMethods: [authMethods["device-code"], authMethods["browser-oauth"], grokCliImport],
    cliImportPath: "~/.grok/auth.json",
    planLabels: {},
    quotaLabels: { weekly: "Weekly" },
    groupLabels: {},
    extraLabels: {
      "reset-credits": "Reset credits",
      "extra-credits": "额外使用积分",
      "auto-top-up": "自动充值",
    },
    extraItemLabels: {},
  },
  {
    id: "antigravity",
    provider: "antigravity",
    name: "Antigravity",
    description: "查看 Antigravity 订阅用量。",
    mark: "",
    icon: antigravityIcon,
    available: true,
    authMethods: [authMethods["browser-oauth"]],
    planLabels: {},
    quotaLabels: {},
    groupLabels: {},
    extraLabels: {},
    extraItemLabels: {},
  },
  {
    id: "claude",
    provider: "claude",
    name: "Claude Code",
    description: "读取 Claude Code OAuth 凭据并查看订阅用量。",
    mark: "C",
    icon: claudeIcon,
    websiteUrl: "https://claude.ai/settings/usage",
    available: true,
    authMethods: [claudeCliImport],
    cliImportPath: "~/.claude/.credentials.json",
    planLabels: {},
    quotaLabels: { session: "5-hour", weekly: "Weekly" },
    groupLabels: { "model-limits": "Model limits" },
    extraLabels: {},
    extraItemLabels: {},
  },
  {
    id: "opencode-go",
    provider: "opencode-go",
    name: "OpenCode Go",
    description: "查看 OpenCode Go 的 5 小时、周和月用量。",
    mark: "O",
    icon: opencodeIcon,
    websiteUrl: "https://opencode.ai/zen",
    available: true,
    authMethods: [authMethods["api-key"]],
    planLabels: {},
    quotaLabels: { session: "$12 / 5-hour", weekly: "$30 / week", monthly: "$60 / month" },
    groupLabels: {},
    extraLabels: {},
    extraItemLabels: {},
  },
];

const registryById = new Map(presentationRegistry.map((item) => [item.id, item]));

/**
 * 把主进程提供的 provider 目录投影为接入页的展示行。目录决定结构与顺序，
 * 文案注册表补充图标和标签；目录为空（例如浏览器预览）时不虚构任何服务商。
 */
export function catalogPresentations(
  catalog: readonly PublicProviderDescriptor[] | null | undefined,
): ProviderPresentation[] {
  if (!catalog?.length) return [];
  const rows: ProviderPresentation[] = [];
  for (const descriptor of catalog) {
    for (const offering of descriptor.offerings) {
      const fallback =
        registryById.get(offering.id) ??
        presentationRegistry.find((item) => item.provider === descriptor.provider);
      rows.push({
        id: offering.id,
        provider: descriptor.provider,
        region: offering.region,
        name: offering.displayName || fallback?.name || descriptor.displayName,
        description: offering.description ?? fallback?.description ?? "",
        mark: fallback?.mark ?? "",
        icon: fallback?.icon,
        websiteUrl: offering.websiteUrl ?? fallback?.websiteUrl,
        available: true,
        cliImportPath: fallback?.cliImportPath,
        authMethods: offering.authMethods.map((method) => ({
          id: method.method,
          label: method.sourceLabel ?? authMethods[method.method].label,
        })),
        planLabels: fallback?.planLabels ?? {},
        quotaLabels: fallback?.quotaLabels ?? {},
        groupLabels: fallback?.groupLabels ?? {},
        extraLabels: fallback?.extraLabels ?? {},
        extraItemLabels: fallback?.extraItemLabels ?? {},
      });
    }
  }
  return rows;
}

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
    registryById.get(id) ??
    presentationRegistry.find((item) => item.provider === id) ??
    presentationRegistry[0]!
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
  if (method !== "cli-import" || !provider) return authMethods[method].label;
  return (
    providerPresentation(provider).authMethods.find((item) => item.id === "cli-import")?.label ??
    authMethods["cli-import"].label
  );
}

export function systemProxyLabel(status: PublicSystemStatus): string {
  if (status.proxyMode === "environment") {
    return `环境变量：${status.proxyAddress ?? "未提供地址"}`;
  }
  if (status.proxyMode === "system") {
    return `系统代理：${status.proxyAddress ?? "未提供地址"}`;
  }
  if (status.proxyMode === "unknown") {
    return "无法检测，遵循系统";
  }
  return "直连";
}
