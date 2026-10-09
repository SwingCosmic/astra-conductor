import type { ProviderDescriptor } from "../types.js";

export const claudeDescriptor: ProviderDescriptor = {
  provider: "claude",
  displayName: "Claude Code",
  offerings: [
    {
      id: "claude",
      provider: "claude",
      displayName: "Claude Code",
      description: "读取 Claude Code OAuth 凭据并查看订阅用量。",
      websiteUrl: "https://claude.ai/settings/usage",
      authMethods: [
        { method: "cli-import", interaction: "local-import", sourceLabel: "Claude Code" },
      ],
    },
  ],
};
