import type { ProviderDescriptor } from "../types.js";

export const antigravityDescriptor: ProviderDescriptor = {
  provider: "antigravity",
  displayName: "Antigravity",
  capabilities: ["account", "usage"],
  offerings: [
    {
      id: "antigravity",
      provider: "antigravity",
      displayName: "Antigravity",
      description: "查看 Antigravity 订阅用量。",
      iconKey: "antigravity",
      authMethods: [{ method: "browser-oauth", interaction: "browser-callback" }],
      // 2026-05-19 改版后官方口径以 Pro 为 1x 基线；Ultra 拆为 5x / 20x 两档
      // （叶子透传原始 tier 名，由精确键与正则区分，ultra-5x 声明在 ultra
      // 之前保证正则先于宽泛模式求值）。防御性 rung 保留；tier 长名
      // （`Antigravity Starter Quota` 形态）由子串正则接住。
      plans: [
        {
          id: "pro",
          displayName: "Pro",
          match: ["pro"],
          multiplier: 1,
          source: "published",
          sourceUrl: "https://antigravity.google/blog/changes-to-antigravity-plans",
          verifiedAt: "2026-10-14",
        },
        {
          id: "ultra-5x",
          displayName: "Ultra 5x",
          match: ["ultra 5x", "ultra5x", /ultra\s*5x/],
          multiplier: 5,
          source: "published",
          sourceUrl: "https://antigravity.google/blog/changes-to-antigravity-plans",
          verifiedAt: "2026-10-14",
        },
        {
          id: "ultra",
          displayName: "Ultra 20x",
          match: ["ultra", "ultra 20x", "ultra20x", /ultra\s*20x/, /\bultra\b/],
          multiplier: 20,
          source: "published",
          sourceUrl: "https://antigravity.google/blog/changes-to-antigravity-plans",
          verifiedAt: "2026-10-14",
        },
        {
          id: "starter",
          displayName: "Starter",
          match: ["starter", /starter/],
          multiplier: 0.1,
          source: "inferred",
        },
        {
          id: "free",
          displayName: "Free",
          match: ["free"],
          multiplier: 0.1,
          source: "inferred",
        },
        {
          id: "lite",
          displayName: "Lite",
          match: ["lite"],
          multiplier: 0.1,
          source: "inferred",
        },
        {
          id: "plus",
          displayName: "Plus",
          match: ["plus"],
          multiplier: 1,
          source: "inferred",
        },
        {
          id: "business",
          displayName: "Business",
          match: ["business"],
          multiplier: 5,
          source: "inferred",
        },
        {
          id: "enterprise",
          displayName: "Enterprise",
          match: ["enterprise"],
          multiplier: 5,
          source: "inferred",
        },
      ],
    },
  ],
};
