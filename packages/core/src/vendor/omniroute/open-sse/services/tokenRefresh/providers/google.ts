export async function refreshGoogleToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { accessToken: string; refreshToken: string; expiresIn?: number }
  | { error: "unrecoverable_refresh_error"; code: "invalid_grant" }
  | null
> {
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return body.error === "invalid_grant"
      ? { error: "unrecoverable_refresh_error", code: "invalid_grant" }
      : null;
  }
  if (typeof body.access_token !== "string" || !body.access_token) return null;
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" && body.refresh_token
        ? body.refresh_token
        : refreshToken,
    ...(typeof body.expires_in === "number" ? { expiresIn: body.expires_in } : {}),
  };
}
