import { GROK_BUILD_TOKEN_URL } from "@omniroute/open-sse/config/grokBuild.ts";
import { resolvePublicCred } from "@omniroute/open-sse/utils/publicCreds.ts";

export interface GrokRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function refreshGrokBuildToken(
  refreshToken: string,
  providerSpecificData: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<GrokRefreshResult | { error: "unrecoverable_refresh_error" } | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: resolvePublicCred("grok_id", "GROK_OAUTH_CLIENT_ID"),
    refresh_token: refreshToken,
  });
  const principalType = stringValue(providerSpecificData.principalType);
  const principalId = stringValue(providerSpecificData.principalId);
  if (principalType) body.set("principal_type", principalType);
  if (principalId) body.set("principal_id", principalId);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) await wait(Math.min(2_000, 200 * 2 ** (attempt - 2)));
    try {
      const response = await fetchImpl(GROK_BUILD_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        if (data.error === "invalid_grant" || data.error === "invalid_client") {
          return { error: "unrecoverable_refresh_error" };
        }
        continue;
      }
      const accessToken = stringValue(data.access_token);
      if (!accessToken) continue;
      return {
        accessToken,
        refreshToken: stringValue(data.refresh_token) ?? refreshToken,
        expiresIn:
          typeof data.expires_in === "number" && data.expires_in > 0
            ? data.expires_in
            : 21_600,
      };
    } catch {
      // Retry bounded transient failures.
    }
  }
  return null;
}
