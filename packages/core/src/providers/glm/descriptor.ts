import type { ProviderDescriptor } from "../types.js";

export const glmDescriptor: ProviderDescriptor = {
  provider: "glm",
  displayName: "GLM Coding Plan",
  offerings: [
    {
      id: "bigmodel-coding-plan",
      provider: "glm",
      displayName: "BigModel Coding Plan",
      description: "智谱国内 Coding Plan，查看 5 小时、周配额和重置卡。",
      websiteUrl: "https://bigmodel.cn/coding-plan/personal/overview",
      region: "china",
      authMethods: [
        { method: "cli-import", interaction: "local-import", sourceLabel: "ZCode" },
        { method: "api-key", interaction: "secret-form" },
      ],
    },
    {
      id: "zai-coding-plan",
      provider: "glm",
      displayName: "Z.ai Coding Plan",
      description: "智谱国际版 Coding Plan，查看 5 小时、周配额和重置卡。",
      websiteUrl: "https://z.ai/manage-apikey/apikey-list",
      region: "international",
      authMethods: [
        { method: "cli-import", interaction: "local-import", sourceLabel: "ZCode" },
        { method: "api-key", interaction: "secret-form" },
      ],
    },
  ],
  // Official weekly credits Lite 10000 / Pro 60000 / Max 140000 → 1 : 6 : 14.
  plans: [
    {
      id: "lite",
      displayName: "Lite",
      match: ["lite", "glm coding lite"],
      multiplier: 1,
      source: "published",
    },
    {
      id: "pro",
      displayName: "Pro",
      match: ["pro", "glm coding pro"],
      multiplier: 6,
      source: "published",
    },
    {
      id: "max",
      displayName: "Max",
      match: ["max", "glm coding max"],
      multiplier: 14,
      source: "published",
    },
  ],
};
