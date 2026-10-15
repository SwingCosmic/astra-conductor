import type { ProviderDescriptor } from "../types.js";
import { CODEX_CLI_IMPORT_PATH_HINT } from "./auth-flow.js";

const CODEX_PRO_TIERS_URL = "https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers";
const CODEX_VERIFIED_AT = "2026-10-14";

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
    id: "pro-5x",
    displayName: "Pro 5x",
    match: ["prolite", "pro 5x", "pro5x"],
    multiplier: 5,
    source: "published",
  },
  {
    // Pro $200：2026-09 重新开放新订后官方口径 ~10x（实测）；存量 20x 老订户
    // 的 plan_type 同为 `pro`，无法从字符串区分，按规则统一取新值。
    id: "pro",
    displayName: "Pro",
    match: ["pro"],
    multiplier: 10,
    source: "published",
    sourceUrl: CODEX_PRO_TIERS_URL,
    verifiedAt: CODEX_VERIFIED_AT,
  },
  {
    // legacy：存量 Pro $200 老订户（保留 20x 至 2026-10-29），经显式
    // `pro 20x` 形态的键命中。
    id: "pro-20x",
    displayName: "Pro 20x",
    match: ["pro 20x", "pro20x"],
    multiplier: 20,
    source: "published",
    legacy: true,
    legacyUntil: "2026-10-29",
    sourceUrl: CODEX_PRO_TIERS_URL,
    verifiedAt: CODEX_VERIFIED_AT,
  },
  {
    id: "promax",
    displayName: "Pro 500",
    match: ["promax"],
    multiplier: 25,
    source: "published",
    sourceUrl: CODEX_PRO_TIERS_URL,
    verifiedAt: CODEX_VERIFIED_AT,
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
  displayName: "OpenAI Codex",
  capabilities: ["account", "usage"],
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
  ],
};
