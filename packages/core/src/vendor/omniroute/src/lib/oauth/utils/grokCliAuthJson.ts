export type GrokCliAuthJsonResult =
  | { ok: true; token: Record<string, unknown> }
  | { ok: false; error: string };

export function parseGrokCliAuthJson(value: unknown): GrokCliAuthJsonResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "auth.json must be a JSON object from ~/.grok/auth.json" };
  }
  const document = value as Record<string, unknown>;
  let hasAccessToken = false;
  for (const entry of Object.values(document)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const accessToken =
      typeof record.key === "string" ? record.key : (record.access_token as unknown);
    if (typeof accessToken !== "string" || !accessToken.startsWith("eyJ")) continue;
    hasAccessToken = true;
    if (typeof record.refresh_token === "string" && record.refresh_token.length > 0) {
      return { ok: true, token: document };
    }
  }
  return hasAccessToken
    ? { ok: false, error: "auth.json is missing refresh_token; run grok login again" }
    : { ok: false, error: "auth.json does not contain a Grok Build JWT" };
}
