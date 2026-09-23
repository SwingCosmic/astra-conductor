// Default token expiry buffer (refresh if expires within 5 minutes).
// Used as fallback for providers without an explicit lead time in
// REFRESH_LEAD_MS below.
export const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// Per-provider proactive-refresh lead time.
//
// For multi-account OAuth on providers that enforce "single active session per
// client_id" (notably OpenAI Codex / Auth0), refreshing one account's token
// can invalidate the refresh_token family of OTHER accounts under that same
// client. Keep the original access token until it is genuinely about to expire
// so each account gets the full access-token lifetime.
export const REFRESH_LEAD_MS: Record<string, number> = {
  codex: 5 * 60 * 1000,
};

/**
 * Get the proactive refresh lead time (ms) for a given provider.
 *
 * Precedence:
 *   1. A positive finite per-connection override.
 *   2. The provider default from REFRESH_LEAD_MS.
 *   3. TOKEN_EXPIRY_BUFFER_MS.
 */
export function getRefreshLeadMs(
  provider: string,
  providerSpecificData?: { refreshLeadMs?: unknown } | null,
): number {
  const override = providerSpecificData?.refreshLeadMs;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }
  return REFRESH_LEAD_MS[provider] ?? TOKEN_EXPIRY_BUFFER_MS;
}
