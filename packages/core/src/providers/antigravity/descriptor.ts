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
  // Name-only rungs. No published multiples; starter/lite/free → 0.1, plus → 1,
  // pro → 5, ultra → 20.
  plans: [
    {
      id: "free",
      displayName: "Free",
      match: ["free"],
      multiplier: 0.1,
      source: "inferred",
    },
    {
      id: "lite",
      displayName: "Lite",
      match: ["lite"],
      multiplier: 0.1,
      source: "inferred",
    },
    {
      id: "starter",
      displayName: "Starter",
      match: ["starter"],
      multiplier: 0.1,
      source: "inferred",
    },
    {
      id: "plus",
      displayName: "Plus",
      match: ["plus"],
      multiplier: 1,
      source: "inferred",
    },
    {
      id: "pro",
      displayName: "Pro",
      match: ["pro"],
      multiplier: 5,
      source: "inferred",
    },
    {
      id: "business",
      displayName: "Business",
      match: ["business"],
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
      id: "ultra",
      displayName: "Ultra",
      match: ["ultra"],
      multiplier: 20,
      source: "inferred",
    },
  ],
};
