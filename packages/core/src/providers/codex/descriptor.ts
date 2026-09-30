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
};
