import { CodexAuthFileError } from "@omniroute/src/lib/oauth/utils/codexAuthFile.ts";

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function decodeJwtPayload(jwt: string): JsonRecord | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return toRecord(JSON.parse(payload));
  } catch {
    return null;
  }
}

function extractExpFromJwt(jwt: string): number | null {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return null;
  const exp = payload.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
}

// Prefer access_token.exp over id_token.exp — the id_token may be expired
// while the access_token (and refresh_token) are still valid. Using a stale
// id_token expiry would mark the connection as expired immediately after import
// and trigger an unnecessary refresh (which can invalidate the token family).
function extractExpiresAt(accessToken: string, idToken: string): string | null {
  const accessExp = extractExpFromJwt(accessToken);
  if (accessExp !== null) return new Date(accessExp * 1000).toISOString();
  const idExp = extractExpFromJwt(idToken);
  if (idExp !== null) return new Date(idExp * 1000).toISOString();
  return null;
}

function extractJwtEmail(idToken: string): string | null {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return null;
  return toNonEmptyString(payload.email);
}

function extractCodexAccountId(
  idToken: string,
  tokensAccountId: string | undefined
): string | null {
  if (tokensAccountId && tokensAccountId.trim()) return tokensAccountId.trim();
  const payload = decodeJwtPayload(idToken);
  const authInfo = payload ? toRecord(payload["https://api.openai.com/auth"]) : {};
  return (
    toNonEmptyString(authInfo.chatgpt_account_id) || toNonEmptyString(authInfo.account_id) || null
  );
}

// Two DISTINCT users can share the SAME workspace/account id (e.g. two members of the
// same ChatGPT Team). The account id alone is NOT a unique connection key. The id_token
// auth claim carries the per-user `chatgpt_user_id`; use it (falling back to `user_id`,
// then the JWT `sub`) so imports can be deduped by workspace AND user. See #6301.
function extractCodexUserId(idToken: string): string | null {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return null;
  const authInfo = toRecord(payload["https://api.openai.com/auth"]);
  return (
    toNonEmptyString(authInfo.chatgpt_user_id) ||
    toNonEmptyString(authInfo.user_id) ||
    toNonEmptyString(payload.sub) ||
    null
  );
}

// On overwrite, keep the incoming per-user id but fall back to the one already stored
// on the existing connection (legacy imports carried none) rather than dropping it (#6301).
function mergeCodexUserId(incomingUserId: string | null, existing: JsonRecord): string | null {
  return incomingUserId ?? toNonEmptyString(toRecord(existing.providerSpecificData).chatgptUserId);
}

// ──── Public types ────────────────────────────────────────────────────────────

export interface ParsedCodexAuth {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  // Per-user identity within the workspace (chatgpt_user_id / user_id / JWT sub).
  // Distinct users can share the same accountId, so this disambiguates them (#6301).
  userId: string | null;
  email: string | null;
  expiresAt: string | null;
}


// ──── Parse & validate ────────────────────────────────────────────────────────

export function parseAndValidateCodexAuth(raw: unknown): ParsedCodexAuth {
  const doc = toRecord(raw);

  // Codex CLI no longer writes auth_mode in auth.json (only OmniRoute's own export
  // includes it). Accept both formats as long as the required tokens are present.
  if (doc.auth_mode !== undefined && doc.auth_mode !== null && doc.auth_mode !== "chatgpt") {
    throw new CodexAuthFileError(
      "Not a Codex auth.json — unexpected auth_mode value",
      400,
      "invalid_auth_file"
    );
  }

  const tokens = toRecord(doc.tokens);
  const idToken = toNonEmptyString(tokens.id_token);
  const accessToken = toNonEmptyString(tokens.access_token);
  const refreshToken = toNonEmptyString(tokens.refresh_token);

  if (!idToken) {
    throw new CodexAuthFileError(
      "id_token is missing or empty in the auth.json",
      400,
      "missing_id_token"
    );
  }

  if (!accessToken) {
    throw new CodexAuthFileError(
      "access_token is missing or empty in the auth.json",
      400,
      "missing_access_token"
    );
  }

  if (!refreshToken) {
    throw new CodexAuthFileError(
      "refresh_token is missing or empty in the auth.json",
      400,
      "missing_refresh_token"
    );
  }

  const tokensAccountId = toNonEmptyString(tokens.account_id) ?? undefined;
  const accountId = extractCodexAccountId(idToken, tokensAccountId);

  if (!accountId) {
    throw new CodexAuthFileError(
      "Unable to derive account_id from the auth.json tokens",
      400,
      "missing_account_id"
    );
  }

  return {
    idToken,
    accessToken,
    refreshToken,
    accountId,
    userId: extractCodexUserId(idToken),
    email: extractJwtEmail(idToken),
    expiresAt: extractExpiresAt(accessToken, idToken),
  };
}
