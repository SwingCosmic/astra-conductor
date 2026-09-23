import { CODEX_CONFIG } from "@omniroute/src/lib/oauth/constants/oauth.ts";
import { buildFormParams, type RefreshLogger } from "../shared.ts";

export type CodexRefreshResult =
  | {
      accessToken: string | undefined;
      refreshToken: string;
      expiresIn: number | undefined;
    }
  | { error: "unrecoverable_refresh_error"; code: string };

/**
 * Refresh Codex OAuth tokens. OpenAI rotates refresh tokens, so callers must
 * persist a returned refreshToken before allowing another refresh.
 */
export async function refreshCodexToken(
  refreshToken: string,
  log: RefreshLogger,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexRefreshResult | null> {
  try {
    const response = await fetchImpl(CODEX_CONFIG.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      // Omitting scope is intentional. Supplying it can make Auth0 treat the
      // refresh as a re-scope and invalidate sibling token families.
      body: buildFormParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_CONFIG.clientId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorCode: string | null = null;
      try {
        const parsed = JSON.parse(errorText) as {
          error?: string | { code?: unknown };
        };
        if (typeof parsed.error === "string") errorCode = parsed.error;
        else if (typeof parsed.error?.code === "string") errorCode = parsed.error.code;
      } catch {
        // Non-JSON failures remain retryable unless the status is 401.
      }

      if (
        errorCode === "refresh_token_reused" ||
        errorCode === "invalid_grant" ||
        errorCode === "token_expired" ||
        errorCode === "invalid_token" ||
        response.status === 401
      ) {
        const code = errorCode || "unauthorized";
        log?.error?.(
          "TOKEN_REFRESH",
          "Codex refresh token already used or invalid. Re-authentication required.",
          { status: response.status, errorCode: code },
        );
        return { error: "unrecoverable_refresh_error", code };
      }

      log?.error?.("TOKEN_REFRESH", "Failed to refresh Codex token", {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const tokens = (await response.json()) as Record<string, unknown>;
    const accessToken =
      typeof tokens.access_token === "string" ? tokens.access_token : undefined;
    const nextRefreshToken =
      typeof tokens.refresh_token === "string" ? tokens.refresh_token : refreshToken;
    const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : undefined;

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Codex token", {
      hasNewAccessToken: Boolean(accessToken),
      hasNewRefreshToken: nextRefreshToken !== refreshToken,
      expiresIn,
    });

    return {
      accessToken,
      refreshToken: nextRefreshToken,
      expiresIn,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.error?.("TOKEN_REFRESH", `Network error refreshing Codex token: ${message}`);
    return null;
  }
}
