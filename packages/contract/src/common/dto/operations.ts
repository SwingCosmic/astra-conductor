import type { PublicError } from "./errors.js";

export type CredentialRefreshOutcomeDto =
  | { status: "updated" | "unchanged"; accountId: string; tokenExpiresAt: string | null }
  | { status: "failed"; accountId: string; error: PublicError };
