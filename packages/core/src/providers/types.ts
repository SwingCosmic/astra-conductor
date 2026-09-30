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

export interface ProviderDescriptor {
  provider: ProviderId;
  displayName: string;
  offerings: ProviderOfferingDescriptor[];
}
