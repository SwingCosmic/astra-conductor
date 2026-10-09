/**
 * Selected from OmniRoute's Claude auth importer at the pinned source commit.
 * Database lookup, connection creation and HTTP enrichment stay outside this leaf.
 */

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export interface ParsedClaudeAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: string | null;
  scopes: string[];
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

export function parseAndValidateClaudeAuth(raw: unknown): ParsedClaudeAuth {
  const oauth = toRecord(toRecord(raw).claudeAiOauth);
  const accessToken = toNonEmptyString(oauth.accessToken);
  const refreshToken = toNonEmptyString(oauth.refreshToken);
  if (!accessToken) throw new Error("accessToken is missing or empty in claudeAiOauth");
  if (!refreshToken) throw new Error("refreshToken is missing or empty in claudeAiOauth");

  let expiresAt: string | null = null;
  if (typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)) {
    expiresAt = new Date(oauth.expiresAt).toISOString();
  } else if (typeof oauth.expiresAt === "string" && oauth.expiresAt.trim()) {
    const timestamp = Date.parse(oauth.expiresAt);
    if (!Number.isFinite(timestamp)) throw new Error("expiresAt is invalid in claudeAiOauth");
    expiresAt = new Date(timestamp).toISOString();
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scopes: Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    subscriptionType: toNonEmptyString(oauth.subscriptionType),
    rateLimitTier: toNonEmptyString(oauth.rateLimitTier),
  };
}
