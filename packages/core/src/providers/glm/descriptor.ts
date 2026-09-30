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
};
