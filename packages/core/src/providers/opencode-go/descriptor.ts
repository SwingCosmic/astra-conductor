import type { ProviderDescriptor } from "../types.js";

export const opencodeGoDescriptor: ProviderDescriptor = {
  provider: "opencode-go",
  displayName: "OpenCode Go",
  capabilities: ["account", "usage"],
  offerings: [
    {
      id: "opencode-go",
      provider: "opencode-go",
      displayName: "OpenCode Go",
      description: "查看 OpenCode Go 的 5 小时、周和月用量。",
      websiteUrl: "https://opencode.ai/zen",
      iconKey: "opencode",
      authMethods: [{ method: "api-key", interaction: "secret-form" }],
      // Single product, no published relative ladder. "Go" here is the product name.
      plans: [
        {
          id: "opencode-go",
          displayName: "OpenCode Go",
          match: ["opencode go"],
          multiplier: 5,
          source: "inferred",
        },
      ],
    },
  ],
};
