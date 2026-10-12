import type { ProviderDescriptor } from "../types.js";

export const codexDescriptor: ProviderDescriptor = {
  provider: "codex",
  displayName: "OpenAI Codex",
  offerings: [
    {
      id: "codex",
      provider: "codex",
      displayName: "OpenAI Codex",
      description: "查看 ChatGPT 订阅中的 Codex 用量。",
      authMethods: [
        { method: "browser-oauth", interaction: "browser-callback" },
        { method: "device-code", interaction: "device-code" },
        { method: "cli-import", interaction: "local-import", sourceLabel: "Codex CLI" },
      ],
    },
  ],
  // plan_type / chatgpt_plan_type. Names claim the multiple vs Plus.
  plans: [
    {
      id: "free",
      displayName: "Free",
      match: ["free"],
      multiplier: 0.1,
      source: "inferred",
    },
    {
      id: "go",
      displayName: "Go",
      match: ["go"],
      multiplier: 0.1,
      source: "inferred",
    },
    {
      id: "plus",
      displayName: "Plus",
      match: ["plus"],
      multiplier: 1,
      source: "published",
    },
    {
      id: "pro-5x",
      displayName: "Pro 5x",
      match: ["prolite", "pro 5x", "pro5x"],
      multiplier: 5,
      source: "published",
    },
    {
      id: "pro",
      displayName: "Pro",
      match: ["pro"],
      multiplier: 5,
      source: "inferred",
    },
    {
      id: "pro-20x",
      displayName: "Pro 20x",
      match: ["pro 20x", "pro20x"],
      multiplier: 20,
      source: "published",
    },
    {
      id: "team",
      displayName: "Team",
      match: ["team"],
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
    {
      id: "edu",
      displayName: "Edu",
      match: ["edu"],
      multiplier: 5,
      source: "inferred",
    },
  ],
};
