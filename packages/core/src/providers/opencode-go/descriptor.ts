import type { ProviderDescriptor } from "../types.js";

export const opencodeGoDescriptor: ProviderDescriptor = {
  provider: "opencode-go",
  displayName: "OpenCode Go",
  offerings: [
    {
      id: "opencode-go",
      provider: "opencode-go",
      displayName: "OpenCode Go",
      description: "查看 OpenCode Go 的 5 小时、周和月用量。",
      websiteUrl: "https://opencode.ai/zen",
      authMethods: [{ method: "api-key", interaction: "secret-form" }],
    },
  ],
};
