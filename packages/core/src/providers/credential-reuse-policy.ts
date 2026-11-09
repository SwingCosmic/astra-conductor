import { getRefreshLeadMs } from "@omniroute/open-sse/services/tokenRefresh.ts";
import type { Account, CredentialEnvelope, PublicMetadata } from "../models.js";
import type { ClockPort } from "../ports.js";

type CredentialReusePolicy = "account-expiry-window" | "provider-expiry-window" | "copilot-oauth";

// Only providers with a refresh preflight opt in. Fixed windows ignore account overrides.
const policies = {
  codex: "account-expiry-window",
  claude: "account-expiry-window",
  antigravity: "provider-expiry-window",
  "grok-build": "provider-expiry-window",
  "github-copilot": "copilot-oauth",
} satisfies Record<string, CredentialReusePolicy>;

export function isOutsideRefreshWindow(
  provider: string,
  expiresAt: string | null,
  now: Date,
  metadata?: PublicMetadata,
): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry - now.getTime() > getRefreshLeadMs(provider, metadata);
}

export function createCredentialReuseCheck(
  provider: keyof typeof policies,
  clock: ClockPort,
): (account: Account, envelope: CredentialEnvelope) => boolean {
  const policy = policies[provider];
  if (policy === "copilot-oauth") {
    return (_account, envelope) =>
      envelope.expiresAt === null && envelope.secrets.copilotToken === undefined;
  }
  return (account, envelope) =>
    isOutsideRefreshWindow(
      provider,
      envelope.expiresAt,
      clock.now(),
      policy === "account-expiry-window" ? account.publicMetadata : undefined,
    );
}
