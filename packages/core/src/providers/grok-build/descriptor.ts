import type { ProviderDescriptor } from "../types.js";
import { GROK_CLI_IMPORT_PATH_HINT } from "./auth-flow.js";

export const grokBuildDescriptor: ProviderDescriptor = {
  provider: "grok-build",
  displayName: "Grok Build",
  capabilities: ["account", "usage"],
  offerings: [
    {
      id: "grok-build",
      provider: "grok-build",
      displayName: "Grok Build",
      description: "查看 Grok Build 订阅用量。",
      iconKey: "grok",
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
      // subscriptionTier 透传。2026-06 改版后的新档位（官方倍率相对 Plus 基线）
      // 字符串为推测形态：正则先行兜底（单词边界避免 `super` 误吞 `supergrok`），
      // 待真实 subscriptionTier 样本校准后收敛为精确键；旧 SuperGrok 档按
      // legacy 保留以兼容存量账号（xAI 未公布存量截止时间，legacyUntil 省略）。
      plans: [
        {
          id: "plus",
          displayName: "Plus",
          match: ["plus", /\bplus\b/],
          multiplier: 1,
          source: "published",
          sourceUrl: "https://x.ai/pricing",
          verifiedAt: "2026-10-14",
        },
        {
          id: "premium",
          displayName: "Premium",
          match: ["premium", /\bpremium\b/],
          multiplier: 4,
          source: "published",
          sourceUrl: "https://x.ai/pricing",
          verifiedAt: "2026-10-14",
        },
        {
          id: "super",
          displayName: "Super",
          match: ["super", /\bsuper\b/],
          multiplier: 15,
          source: "published",
          sourceUrl: "https://x.ai/pricing",
          verifiedAt: "2026-10-14",
        },
        {
          id: "ultra",
          displayName: "Ultra",
          match: ["ultra", /\bultra\b/],
          multiplier: 50,
          source: "published",
          sourceUrl: "https://x.ai/pricing",
          verifiedAt: "2026-10-14",
        },
        {
          id: "supergrok-pro",
          displayName: "SuperGrok Pro",
          match: ["supergrokpro", "supergrok pro", "grokpro"],
          multiplier: 5,
          source: "inferred",
          legacy: true,
        },
        {
          id: "supergrok-heavy",
          displayName: "SuperGrok Heavy",
          match: ["supergrok heavy", "supergrokheavy"],
          multiplier: 20,
          source: "inferred",
          legacy: true,
        },
        {
          // tier 缺失时叶子的兜底合成标识，非订阅档，不标 legacy。
          id: "grok-build",
          displayName: "Grok Build",
          match: ["grok build"],
          multiplier: 5,
          source: "inferred",
        },
      ],
    },
  ],
};
