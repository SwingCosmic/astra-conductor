import type { ProviderDescriptor } from "../types.js";
import { CODEX_CLI_IMPORT_PATH_HINT } from "./auth-flow.js";

const CODEX_PRO_TIERS_URL = "https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers";

const codexPlans: ProviderDescriptor["offerings"][number]["plans"] = [
  // plan_type / chatgpt_plan_type（openai/codex account.rs 枚举）。倍率相对 Plus。
  {
    id: "free",
    displayName: "Free",
    match: ["free"],
    multiplier: 0.1,
    source: "inferred",
  },
  {
    id: "go",
    displayName: "Go",
    match: ["go"],
    multiplier: 0.1,
    source: "inferred",
  },
  {
    id: "plus",
    displayName: "Plus",
    match: ["plus"],
    multiplier: 1,
    source: "published",
  },
  {
    // Pro 100（plan_type `prolite`）。2026-10-29 官方将 Work 与 Codex allowance
    // 翻倍，倍率按原 5x 实测口径同比推算为 10x（官方不公布 Plus 相对倍率，
    // 待样本复核）。展示名与 match 防御键统一为官方美元档名。
    id: "pro-100",
    displayName: "Pro 100",
    match: ["prolite", "pro 100", "pro100"],
    multiplier: 10,
    source: "published",
    sourceUrl: CODEX_PRO_TIERS_URL,
    verifiedAt: "2026-11-17",
  },
  {
    // Pro 200（plan_type `pro`，存量/新订无法从字符串区分）。2026-09-29 邮件
    // 宣布的削减已被官方取消（2026-10-29），恢复原 20x 口径，legacy `pro-20x`
    // 条目随之删除；其 `pro 20x` 展示形态键并入本条。
    id: "pro",
    displayName: "Pro 200",
    match: ["pro", "pro 200", "pro200", "pro 20x", "pro20x"],
    multiplier: 20,
    source: "published",
    sourceUrl: CODEX_PRO_TIERS_URL,
    verifiedAt: "2026-11-17",
  },
  {
    // Pro 500（plan_type `promax`）。2026-10-29 allowance 翻倍，按官方 ~25x
    // 口径同比推算为 50x，待样本复核。
    id: "promax",
    displayName: "Pro 500",
    match: ["promax"],
    multiplier: 50,
    source: "published",
    sourceUrl: CODEX_PRO_TIERS_URL,
    verifiedAt: "2026-11-17",
  },
  {
    id: "team",
    displayName: "Team",
    match: ["team"],
    multiplier: 5,
    source: "inferred",
  },
  {
    // B 端自服新变体（self_serve_business_prolite / _usage_based）规范化后是
    // 多词长串，精确匹配必失配，由 /^self serve business/ 正则归并。
    id: "business",
    displayName: "Business",
    match: ["business", /^self serve business/],
    multiplier: 5,
    source: "inferred",
  },
  {
    id: "enterprise",
    displayName: "Enterprise",
    match: ["enterprise", "ent26", /^enterprise cbp/],
    multiplier: 5,
    source: "inferred",
  },
  {
    id: "edu",
    displayName: "Edu",
    match: ["edu", "edu plus", "edu pro", /^edu/],
    multiplier: 5,
    source: "inferred",
  },
];

export const codexDescriptor: ProviderDescriptor = {
  provider: "codex",
  displayName: "OpenAI",
  capabilities: ["account", "usage", "model-catalog", "inference"],
  offerings: [
    {
      id: "codex",
      provider: "codex",
      displayName: "OpenAI Codex",
      description: "查看 ChatGPT 订阅中的 Codex 用量。",
      iconKey: "codex",
      authMethods: [
        { method: "browser-oauth", interaction: "browser-callback" },
        { method: "device-code", interaction: "device-code" },
        {
          method: "cli-import",
          interaction: "local-import",
          sourceLabel: "Codex CLI",
          sourcePathHint: CODEX_CLI_IMPORT_PATH_HINT,
        },
      ],
      plans: codexPlans,
    },
    {
      id: "openai-api-key",
      provider: "codex",
      displayName: "OpenAI API",
      description: "使用官方 API Key 访问 OpenAI 模型。",
      iconKey: "codex",
      supportsSubscriptionUsage: false,
      connectionKind: "fixed-routes",
      authMethods: [{ method: "api-key", interaction: "secret-form", sourceLabel: "API Key" }],
      plans: [],
    },
  ],
};
