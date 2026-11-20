import type { ProviderDescriptor } from "../types.js";
import { GROK_CLI_IMPORT_PATH_HINT } from "./auth-flow.js";
import { grokBuildRouteConfig } from "./model-policy.js";

export const grokBuildDescriptor: ProviderDescriptor = {
  provider: "grok-build",
  displayName: "Grok Build",
  capabilities: ["account", "usage", "model-catalog", "inference"],
  offerings: [
    {
      id: "grok-build",
      provider: "grok-build",
      displayName: "Grok Build",
      description: "查看 Grok Build 订阅用量。",
      iconKey: "grok",
      routeConfig: grokBuildRouteConfig,
      authMethods: [
        { method: "device-code", interaction: "device-code" },
        { method: "browser-oauth", interaction: "browser-callback" },
        {
          method: "cli-import",
          interaction: "local-import",
          sourceLabel: "Grok CLI",
          sourcePathHint: GROK_CLI_IMPORT_PATH_HINT,
        },
      ],
      // subscriptionTier 透传。2026-06 改版后的新四档（官方倍率相对 Plus 基线，
      // 2026-10-12 起官方名称 The X Subscription，捆绑 Grok / Grok Bot / Cursor / X）。
      // 真实样本校准（2026-10-15 观测、2026-11-17 账号确认）：改版后 Premium 档
      // 上报 `GrokPro`——xAI 沿用了内部档位串，故 `grokpro` 精确键归 Premium；
      // 其余档位按同形态补 `Grok<X>` 防御正则，`\b<X>\b` 兜底未知的单词形态
      // （单词边界避免 `super` 误吞 `supergrok`）。旧 SuperGrok 档按 legacy 保留
      // 以兼容存量账号（xAI 未公布存量截止时间，legacyUntil 省略）。
      plans: [
        {
          key: "plus",
          displayName: "Plus",
          match: ["plus", /^grok\s*plus$/, /\bplus\b/],
          multiplier: 1,
          source: "published",
          sourceUrl: "https://x.ai/pricing",
          verifiedAt: "2026-10-14",
        },
        {
          key: "premium",
          displayName: "Premium",
          match: ["premium", "grokpro", /^grok\s*premium$/, /\bpremium\b/],
          multiplier: 4,
          source: "published",
          sourceUrl: "https://x.ai/pricing",
          verifiedAt: "2026-11-17",
        },
        {
          key: "super",
          displayName: "Super",
          match: ["super", /^grok\s*super$/, /\bsuper\b/],
          multiplier: 15,
          source: "published",
          sourceUrl: "https://x.ai/pricing",
          verifiedAt: "2026-10-14",
        },
        {
          key: "ultra",
          displayName: "Ultra",
          match: ["ultra", /^grok\s*ultra$/, /\bultra\b/],
          multiplier: 50,
          source: "published",
          sourceUrl: "https://x.ai/pricing",
          verifiedAt: "2026-10-14",
        },
        {
          key: "supergrok-pro",
          displayName: "SuperGrok Pro",
          match: ["supergrokpro", "supergrok pro"],
          multiplier: 5,
          source: "inferred",
          legacy: true,
        },
        {
          key: "supergrok-heavy",
          displayName: "SuperGrok Heavy",
          match: ["supergrok heavy", "supergrokheavy"],
          multiplier: 20,
          source: "inferred",
          legacy: true,
        },
        {
          // tier 缺失时叶子的兜底合成标识，非订阅档，不标 legacy。
          key: "grok-build",
          displayName: "Grok Build",
          match: ["grok build"],
          multiplier: 5,
          source: "inferred",
        },
      ],
    },
  ],
};
