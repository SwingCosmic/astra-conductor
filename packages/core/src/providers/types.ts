import type { AuthMethod, GlmRegion, ProviderId } from "../models.js";

export type AuthMethodInteraction =
  | "browser-callback"
  | "device-code"
  | "local-import"
  | "secret-form";

export interface ProviderAuthMethodDescriptor {
  method: AuthMethod;
  interaction: AuthMethodInteraction;
  sourceLabel?: string;
}

export interface ProviderOfferingDescriptor {
  id: string;
  provider: ProviderId;
  displayName: string;
  description?: string;
  websiteUrl?: string;
  region?: GlmRegion;
  authMethods: ProviderAuthMethodDescriptor[];
}

/**
 * One-time plan catalog entry. Runtime scoring only looks these up; it does not
 * re-guess names. `source` records how the multiplier was filled in:
 * published vendor ratio, or a one-time inference from the identifier / name.
 */
export type ProviderPlanSource = "published" | "inferred";

export interface ProviderPlanDescriptor {
  id: string;
  displayName: string;
  /**
   * Raw `usage.plan` strings that map to this entry. Matching lowercases and
   * collapses whitespace / `_` / `-`; it is exact on the normalized form.
   */
  match: readonly string[];
  /** Weight `w` relative to the provider baseline. Must be finite and greater than 0. */
  multiplier: number;
  source: ProviderPlanSource;
}

export interface ProviderDescriptor {
  provider: ProviderId;
  displayName: string;
  offerings: ProviderOfferingDescriptor[];
  plans: readonly ProviderPlanDescriptor[];
}
