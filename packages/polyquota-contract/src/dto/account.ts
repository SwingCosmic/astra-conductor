export type JsonPrimitive = string | number | boolean | null;
export type PublicMetadata = Record<string, JsonPrimitive>;

export type CredentialState = "available" | "locked" | "missing";

export interface PublicAccount {
  id: string;
  provider: string;
  offeringId: string;
  authMethod: string;
  displayName: string;
  maskedIdentifier: string;
  enabled: boolean;
  credentialState: CredentialState;
  tokenExpiresAt: string | null;
  publicMetadata: PublicMetadata;
  createdAt: string;
  updatedAt: string;
}
