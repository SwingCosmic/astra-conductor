// Default token expiry buffer (refresh if expires within 5 minutes).
// Used as fallback for providers without an explicit lead time in
// REFRESH_LEAD_MS below.
export const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// Per-provider proactive-refresh lead time.
//
// For multi-account OAuth on providers that enforce "single active session per
// client_id" (notably OpenAI Codex / Auth0), refreshing one account's token
// can invalidate the refresh_token family of OTHER accounts under the same
// client. We MINIMIZE refresh frequency for these providers: stay on the
// original access_token until it is genuinely about to expire, so each account
// gets the full access_token lifetime without triggering Auth0's family-
// invalidation logic on its siblings.
//
// Trade-off: when refresh finally happens (last 5 min before expiry), Auth0
// MAY invalidate other accounts' refresh_tokens. The user must re-auth those.
// This is the upstream limitation documented in openai/codex#9648.
//
// Providers with non-rotating tokens (Google, Anthropic) or where multi-
// account is naturally isolated keep longer lead times.
export const REFRESH_LEAD_MS: Record<string, number> = {
  // Rotating refresh tokens — minimize refresh frequency to avoid the
  // "refresh-invalidates-siblings" cascade documented for OpenAI Auth0.
  codex: 5 * 60 * 1000, // 5 minutes
  openai: 5 * 60 * 1000, // same Auth0 backend as codex
  claude: 5 * 60 * 1000, // Anthropic OAuth rotates refresh_tokens (user-reported)
  "gitlab-duo": 5 * 60 * 1000, // GitLab token family revocation on misuse
  kiro: 5 * 60 * 1000, // AWS SSO OIDC issues one-time-use refresh tokens
  "kimi-coding": 5 * 60 * 1000, // Moonshot rotates per-refresh
  // Google OAuth refresh_tokens are permanent (non-rotating) — longer lead
  // is safe and reduces unnecessary upstream chatter.
  antigravity: 15 * 60 * 1000,
  agy: 15 * 60 * 1000, // same Google backend as antigravity (non-rotating refresh tokens)
};

/**
 * Upstream providers that stored connections may still name, but that this build no
 * longer serves. They are NOT routable — absent from PROVIDERS, from the chat REGISTRY,
 * and without an executor — so keeping their token fresh maintains a credential that can
 * never answer a request.
 *
 * Deprecation, not deletion: a connection here becomes terminal with a reason that names
 * where to go instead, rather than silently sitting at `active` doing nothing. The
 * migration target must be routable — `tests/unit/gemini-cli-deprecation.test.ts` asserts
 * that, so the notice can never point somewhere useless.
 */
export const DEPRECATED_PROVIDERS: Readonly<
  Record<string, { readonly migrateTo: string; readonly reason: string }>
> = {
  "gemini-cli": {
    migrateTo: "gemini",
    // The legacy path redeemed the token with PROVIDERS.gemini's client — the very same
    // public Gemini CLI / Code Assist OAuth client — which is why re-adding the account
    // under `gemini` is a real migration and not a suggestion to start over.
    reason:
      "The gemini-cli provider was discontinued and is not routable. Re-add this account " +
      "under the `gemini` provider — it uses the same Google OAuth client, so the same " +
      "login works and the account becomes usable again.",
  },
};

/** Whether `provider` is a deprecated upstream that must not be refreshed. */
export function isDeprecatedProvider(provider: string): boolean {
  return Boolean(provider) && Object.prototype.hasOwnProperty.call(DEPRECATED_PROVIDERS, provider);
}

/** The migration notice for a deprecated provider, or null when it is not deprecated. */
export function getDeprecationNotice(
  provider: string
): { migrateTo: string; reason: string } | null {
  return isDeprecatedProvider(provider) ? DEPRECATED_PROVIDERS[provider] : null;
}

/**
 * Get the proactive refresh lead time (ms) for a given provider.
 *
 * Precedence:
 *   1. A per-connection override in `providerSpecificData.refreshLeadMs`
 *      (must be a positive finite number), so an operator can tune the lead
 *      time for a single connection without touching the provider defaults.
 *   2. The provider default from REFRESH_LEAD_MS.
 *   3. TOKEN_EXPIRY_BUFFER_MS (5 min) when nothing else applies.
 */
export function getRefreshLeadMs(
  provider: string,
  providerSpecificData?: { refreshLeadMs?: unknown } | null
): number {
  const override = providerSpecificData?.refreshLeadMs;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }
  return REFRESH_LEAD_MS[provider] ?? TOKEN_EXPIRY_BUFFER_MS;
}
