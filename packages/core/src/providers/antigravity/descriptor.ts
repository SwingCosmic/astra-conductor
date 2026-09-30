import type { ProviderDescriptor } from "../types.js";

export const antigravityDescriptor: ProviderDescriptor = {
  provider: "antigravity",
  displayName: "Antigravity",
  offerings: [
    {
      id: "antigravity",
      provider: "antigravity",
      displayName: "Antigravity",
      description: "查看 Antigravity 订阅用量。",
      authMethods: [{ method: "browser-oauth", interaction: "browser-callback" }],
    },
  ],
};
