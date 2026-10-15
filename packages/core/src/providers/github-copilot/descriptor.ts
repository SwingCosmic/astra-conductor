import type { ProviderDescriptor } from "../types.js";

export const githubCopilotDescriptor: ProviderDescriptor = {
  provider: "github-copilot",
  displayName: "GitHub Copilot",
  capabilities: ["account", "usage"],
  offerings: [
    {
      id: "github-copilot",
      provider: "github-copilot",
      displayName: "GitHub Copilot",
      description: "通过 GitHub 设备码授权查看 Copilot 的月度请求配额。",
      websiteUrl: "https://github.com/features/copilot",
      iconKey: "copilot",
      authMethods: [{ method: "device-code", interaction: "device-code" }],
      // 数据层标识符是叶子上游的原始值：copilot_plan 透传（实测为短词
      // "free" / "pro" / "PRO_PLUS" / "business" / "student" …，见 openclaw 与
      // omniroute 上游测试夹具），access_type_sku 兜底（"copilot_pro_plus" /
      // "free_limited" / "copilot_business_seat" 形态；规范化折叠下划线后同键）。
      // 倍率按 AI Credits 月额度合计相对 Pro 基线（1500 / 7000 / 20000 →
      // 1 / 4.6 / 13.3，2026-06-01 起 Premium Request Units 被 AI Credits 取代）；
      // business/enterprise 转 org 池化后无公开 per-seat 数值，维持旧口径待样本。
      plans: [
        {
          id: "copilot-pro",
          displayName: "Copilot Pro",
          match: ["copilot pro", "pro"],
          multiplier: 1,
          source: "published",
          sourceUrl:
            "https://docs.github.com/copilot/concepts/billing/usage-based-billing-for-individuals",
          verifiedAt: "2026-10-14",
        },
        {
          id: "copilot-pro-plus",
          displayName: "Copilot Pro+",
          match: [
            "copilot pro+",
            "copilot pro plus",
            "copilot proplus",
            "pro+",
            "pro plus",
            "proplus",
          ],
          multiplier: 4.6,
          source: "published",
          sourceUrl:
            "https://docs.github.com/copilot/concepts/billing/usage-based-billing-for-individuals",
          verifiedAt: "2026-10-14",
        },
        {
          id: "copilot-max",
          displayName: "Copilot Max",
          match: ["copilot max", "max"],
          multiplier: 13.3,
          source: "published",
          sourceUrl:
            "https://docs.github.com/copilot/concepts/billing/usage-based-billing-for-individuals",
          verifiedAt: "2026-10-14",
        },
        {
          id: "copilot-student",
          displayName: "Copilot Student",
          match: ["copilot student", "student"],
          multiplier: 1,
          source: "inferred",
        },
        {
          // `free` / `free limited` / `individual` 是实测免费账号形态：真实账号
          // （2026-10-15，chat 200 / completions 2000 月度计数、无 premium 额度表）
          // 上报 copilot_plan "individual"；AI Credits 时代付费档按观测报
          // pro / PRO_PLUS / max，旧"individual = 付费个人档"语义不再成立。
          id: "copilot-free",
          displayName: "Copilot Free",
          match: ["copilot free", "free", "free limited", "individual"],
          multiplier: 0.1,
          source: "inferred",
        },
        {
          id: "copilot-business",
          displayName: "Copilot Business",
          match: ["copilot business", "business", "copilot business seat"],
          multiplier: 1,
          source: "inferred",
        },
        {
          id: "copilot-enterprise",
          displayName: "Copilot Enterprise",
          match: ["copilot enterprise", "enterprise"],
          multiplier: 3.3,
          source: "inferred",
        },
      ],
    },
  ],
};
