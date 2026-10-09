/**
 * Host-decoupled Claude OAuth refresh selected from OmniRoute's claudeOAuth provider leaf.
 */

import { CLAUDE_CONFIG } from "@omniroute/src/lib/oauth/constants/oauth.ts";
import { buildFormParams, readRefreshErrorBody } from "../shared.ts";

export type ClaudeRefreshResult =
  | { accessToken: string; refreshToken: string; expiresIn?: number }
  | { error: "unrecoverable_refresh_error"; code: string };

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function refreshClaudeOAuthToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaudeRefreshResult | null> {
  const response = await fetchImpl(CLAUDE_CONFIG.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
    body: buildFormParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLAUDE_CONFIG.clientId,
    }).toString(),
  });

  if (!response.ok) {
    const { code } = await readRefreshErrorBody(response);
    if (code === "invalid_grant" || code === "invalid_request" || response.status === 401) {
      return { error: "unrecoverable_refresh_error", code: code || String(response.status) };
    }
    return null;
  }

  const tokens = (await response.json()) as Record<string, unknown>;
  const accessToken = stringValue(tokens.access_token);
  if (!accessToken) return null;
  const nextRefreshToken = stringValue(tokens.refresh_token) ?? refreshToken;
  return {
    accessToken,
    refreshToken: nextRefreshToken,
    ...(typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
      ? { expiresIn: tokens.expires_in }
      : {}),
  };
}
