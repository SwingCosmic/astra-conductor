import type { ProviderDescriptor } from "../types.js";
import { ZCODE_CREDENTIALS_PATH_HINT } from "./zcode-credentials.js";

// Official weekly credits Lite 10000 / Pro 60000 / Max 140000 → 1 : 6 : 14.
// 两个接入点各自声明一份：国内与国际版的计费目录当前一致，但允许未来独立演进。
const glmPlans: ProviderDescriptor["offerings"][number]["plans"] = [
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
];

export const glmDescriptor: ProviderDescriptor = {
  provider: "glm",
  displayName: "GLM Coding Plan",
  capabilities: ["account", "usage"],
  offerings: [
    {
      id: "bigmodel-coding-plan",
      provider: "glm",
      displayName: "BigModel Coding Plan",
      description: "智谱国内 Coding Plan，查看 5 小时、周配额和重置卡。",
      websiteUrl: "https://bigmodel.cn/coding-plan/personal/overview",
      iconKey: "bigmodel",
      authMethods: [
        {
          method: "cli-import",
          interaction: "local-import",
          sourceLabel: "ZCode",
          sourcePathHint: ZCODE_CREDENTIALS_PATH_HINT,
        },
        { method: "api-key", interaction: "secret-form" },
      ],
      plans: glmPlans,
    },
    {
      id: "zai-coding-plan",
      provider: "glm",
      displayName: "Z.ai Coding Plan",
      description: "智谱国际版 Coding Plan，查看 5 小时、周配额和重置卡。",
      websiteUrl: "https://z.ai/manage-apikey/apikey-list",
      iconKey: "zai",
      authMethods: [
        {
          method: "cli-import",
          interaction: "local-import",
          sourceLabel: "ZCode",
          sourcePathHint: ZCODE_CREDENTIALS_PATH_HINT,
        },
        { method: "api-key", interaction: "secret-form" },
      ],
      plans: glmPlans,
    },
  ],
};
