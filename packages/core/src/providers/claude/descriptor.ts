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
  // Official 5h multiples vs Pro. Bare `max` is the top identifier rung (20).
  plans: [
    {
      id: "pro",
      displayName: "Pro",
      match: ["pro"],
      multiplier: 1,
      source: "published",
    },
    {
      id: "max-5x",
      displayName: "Max 5x",
      match: ["max 5x", "max5x", "5x", "default claude max 5x"],
      multiplier: 5,
      source: "published",
    },
    {
      id: "max-20x",
      displayName: "Max 20x",
      match: ["max 20x", "max20x", "20x", "default claude max 20x"],
      multiplier: 20,
      source: "published",
    },
    {
      id: "max",
      displayName: "Max",
      match: ["max"],
      multiplier: 20,
      source: "inferred",
    },
  ],
};
