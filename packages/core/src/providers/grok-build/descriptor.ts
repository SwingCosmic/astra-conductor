import type { ProviderDescriptor } from "../types.js";
import { GROK_CLI_IMPORT_PATH_HINT } from "./auth-flow.js";

export const grokBuildDescriptor: ProviderDescriptor = {
  provider: "grok-build",
  displayName: "Grok Build",
  capabilities: ["account", "usage"],
  offerings: [
    {
      id: "grok-build",
      provider: "grok-build",
      displayName: "Grok Build",
      description: "查看 Grok Build 订阅用量。",
      iconKey: "grok",
      authMethods: [
        { method: "device-code", interaction: "device-code" },
        { method: "browser-oauth", interaction: "browser-callback" },
        {
          method: "cli-import",
          interaction: "local-import",
          sourceLabel: "Grok CLI",
          sourcePathHint: GROK_CLI_IMPORT_PATH_HINT,
        },
      ],
      // subscriptionTier strings. Pro in the name → 5; Heavy inferred as top rung 20.
      plans: [
        {
          id: "supergrok-pro",
          displayName: "SuperGrok Pro",
          match: ["supergrokpro", "supergrok pro", "grokpro"],
          multiplier: 5,
          source: "inferred",
        },
        {
          id: "supergrok-heavy",
          displayName: "SuperGrok Heavy",
          match: ["supergrok heavy", "supergrokheavy"],
          multiplier: 20,
          source: "inferred",
        },
        {
          id: "grok-build",
          displayName: "Grok Build",
          match: ["grok build"],
          multiplier: 5,
          source: "inferred",
        },
      ],
    },
  ],
};
