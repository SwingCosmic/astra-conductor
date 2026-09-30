import type { ProviderDescriptor } from "../types.js";

export const grokBuildDescriptor: ProviderDescriptor = {
  provider: "grok-build",
  displayName: "Grok Build",
  offerings: [
    {
      id: "grok-build",
      provider: "grok-build",
      displayName: "Grok Build",
      description: "查看 Grok Build 订阅用量。",
      authMethods: [
        { method: "device-code", interaction: "device-code" },
        { method: "browser-oauth", interaction: "browser-callback" },
        { method: "cli-import", interaction: "local-import", sourceLabel: "Grok CLI" },
      ],
    },
  ],
};
