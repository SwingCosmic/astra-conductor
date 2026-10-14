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
      // match 覆盖用量叶子返回的档位名与上游 copilot_plan 原始值（规范化后
      // 同键）。倍数按高级请求月配额相对 Pro 基线（300 次）一次性推断。
      plans: [
        {
          id: "copilot-pro",
          displayName: "Copilot Pro",
          match: ["copilot pro"],
          multiplier: 1,
          source: "inferred",
        },
        {
          id: "copilot-pro-plus",
          displayName: "Copilot Pro+",
          match: ["copilot pro+", "copilot_pro_plus", "copilot proplus"],
          multiplier: 5,
          source: "inferred",
        },
        {
          id: "copilot-business",
          displayName: "Copilot Business",
          match: ["copilot business"],
          multiplier: 1,
          source: "inferred",
        },
        {
          id: "copilot-enterprise",
          displayName: "Copilot Enterprise",
          match: ["copilot enterprise"],
          multiplier: 3.3,
          source: "inferred",
        },
        {
          id: "copilot-student",
          displayName: "Copilot Student",
          match: ["copilot student"],
          multiplier: 1,
          source: "inferred",
        },
        {
          id: "copilot-free",
          displayName: "Copilot Free",
          match: ["copilot free"],
          multiplier: 0.1,
          source: "inferred",
        },
      ],
    },
  ],
};
