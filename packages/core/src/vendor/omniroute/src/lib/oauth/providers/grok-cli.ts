import {
  getGrokBuildOAuthHeaders,
  GROK_BUILD_OAUTH_REFERRER,
} from "@omniroute/open-sse/config/grokBuild.ts";
import { GROK_BUILD_OAUTH_CONFIG, GROK_CLI_CONFIG } from "../constants/stage7.ts";

export interface GrokDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface GrokMappedTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresIn: number;
  email: string | null;
  name: string | null;
  providerSpecificData: Record<string, string | number | null>;
}

interface ParsedJwt {
  email: string | null;
  name: string | null;
  exp: number | null;
  userId: string | null;
  teamId: string | null;
  organizationId: string | null;
  principalType: string | null;
  principalId: string | null;
  tier: number | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function oauthResponse(response: Response): Promise<Record<string, unknown>> {
  return record(await response.json().catch(() => ({})));
}

function validateVerificationUri(value: string): void {
  if ([...value].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f)) {
    throw new Error("Grok returned an invalid verification URL");
  }
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Grok returned an unsupported verification URL");
  }
}

export async function requestGrokDeviceCode(
  fetchImpl: typeof fetch = fetch,
): Promise<GrokDeviceAuthorization> {
  const response = await fetchImpl(GROK_CLI_CONFIG.deviceCodeUrl, {
    method: "POST",
    headers: getGrokBuildOAuthHeaders(),
    body: new URLSearchParams({
      client_id: GROK_CLI_CONFIG.clientId,
      scope: GROK_CLI_CONFIG.scope,
      referrer: GROK_BUILD_OAUTH_REFERRER,
    }),
  });
  const data = await oauthResponse(response);
  if (!response.ok) {
    throw new Error(stringValue(data.error_description) ?? "Grok device authorization failed");
  }
  const deviceCode = stringValue(data.device_code);
  const userCode = stringValue(data.user_code);
  const verificationUri = stringValue(data.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("Grok device authorization response is incomplete");
  }
  if (!/^[A-Za-z0-9-]+$/.test(userCode)) {
    throw new Error("Grok returned an invalid device code");
  }
  validateVerificationUri(verificationUri);
  const verificationUriComplete = stringValue(data.verification_uri_complete) ?? verificationUri;
  validateVerificationUri(verificationUriComplete);
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn:
      typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 1800,
    interval: typeof data.interval === "number" && data.interval > 0 ? data.interval : 5,
  };
}

export async function pollGrokDeviceToken(
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const response = await fetchImpl(GROK_CLI_CONFIG.tokenUrl, {
    method: "POST",
    headers: getGrokBuildOAuthHeaders(),
    body: new URLSearchParams({
      client_id: GROK_CLI_CONFIG.clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  return { ok: response.ok, data: await oauthResponse(response) };
}

export function buildGrokBuildAuthUrl(
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: GROK_BUILD_OAUTH_CONFIG.clientId,
    redirect_uri: redirectUri,
    scope: GROK_BUILD_OAUTH_CONFIG.scope,
    code_challenge: codeChallenge,
    code_challenge_method: GROK_BUILD_OAUTH_CONFIG.codeChallengeMethod,
    state,
  });
  return `${GROK_BUILD_OAUTH_CONFIG.authorizeUrl}?${query.toString()}`;
}

export async function exchangeGrokBuildToken(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(GROK_BUILD_OAUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: GROK_BUILD_OAUTH_CONFIG.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  const data = await oauthResponse(response);
  if (!response.ok) {
    throw new Error(stringValue(data.error_description) ?? "Grok Build token exchange failed");
  }
  return data;
}

function decodeJwt(token: unknown): ParsedJwt {
  const empty: ParsedJwt = {
    email: null,
    name: null,
    exp: null,
    userId: null,
    teamId: null,
    organizationId: null,
    principalType: null,
    principalId: null,
    tier: null,
  };
  if (typeof token !== "string") return empty;
  const parts = token.split(".");
  if (parts.length !== 3) return empty;
  try {
    const payload = record(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
    const principalType = stringValue(payload.principal_type);
    const principalId = stringValue(payload.principal_id);
    const principal = principalType?.toLowerCase();
    const sharedPrincipal = principal === "team" || principal === "organization";
    return {
      email: stringValue(payload.email) ?? stringValue(payload.preferred_username),
      name: stringValue(payload.name),
      exp: typeof payload.exp === "number" ? payload.exp : null,
      userId: sharedPrincipal ? principalId : stringValue(payload.sub),
      teamId:
        principal === "team" ? principalId : stringValue(payload.team_id),
      organizationId:
        principal === "organization" ? principalId : stringValue(payload.organization_id),
      principalType,
      principalId,
      tier: typeof payload.tier === "number" ? payload.tier : null,
    };
  } catch {
    return empty;
  }
}

function first<T>(...values: Array<T | null | undefined>): T | null {
  return values.find((value): value is T => value !== null && value !== undefined) ?? null;
}

function identity(accessToken: string, idToken: string | null) {
  const access = decodeJwt(accessToken);
  const id = decodeJwt(idToken);
  return {
    email: first(id.email, access.email),
    name: first(id.name, access.name),
    userId: first(access.userId, id.userId),
    teamId: first(access.teamId, id.teamId),
    organizationId: first(access.organizationId, id.organizationId),
    principalType: first(access.principalType, id.principalType),
    principalId: first(access.principalId, id.principalId),
    tier: first(access.tier, id.tier),
    exp: access.exp,
  };
}

function mappedTokens(
  accessToken: string,
  refreshToken: string | null,
  idToken: string | null,
  expiresIn: number,
  tokenType: string | null,
  scope: string | null,
): GrokMappedTokens {
  const resolved = identity(accessToken, idToken);
  return {
    accessToken,
    refreshToken,
    idToken,
    expiresIn: Math.max(1, expiresIn),
    email: resolved.email,
    name: resolved.name,
    providerSpecificData: {
      userId: resolved.userId,
      email: resolved.email,
      teamId: resolved.teamId,
      organizationId: resolved.organizationId,
      principalType: resolved.principalType,
      principalId: resolved.principalId,
      tier: resolved.tier,
      tokenType,
      scope,
    },
  };
}

export function mapGrokBrowserTokens(tokens: Record<string, unknown>): GrokMappedTokens {
  const accessToken = stringValue(tokens.access_token) ?? "";
  const idToken = stringValue(tokens.id_token);
  const expiresIn =
    typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
      ? tokens.expires_in
      : 21_600;
  return mappedTokens(
    accessToken,
    stringValue(tokens.refresh_token),
    idToken,
    expiresIn,
    stringValue(tokens.token_type) ?? "Bearer",
    stringValue(tokens.scope) ?? GROK_BUILD_OAUTH_CONFIG.scope,
  );
}

export function mapGrokImportedToken(input: unknown): GrokMappedTokens {
  const document = record(input);
  const preferredKey = `${GROK_CLI_CONFIG.issuer}::${GROK_CLI_CONFIG.clientId}`;
  const entries = Object.entries(document).sort(([left], [right]) =>
    left === preferredKey ? -1 : right === preferredKey ? 1 : 0,
  );
  const entry = entries
    .map(([, value]) => record(value))
    .find(
      (value) =>
        (stringValue(value.key)?.startsWith("eyJ") ||
          stringValue(value.access_token)?.startsWith("eyJ")) &&
        stringValue(value.refresh_token),
    );
  if (!entry) throw new Error("Grok CLI auth.json does not contain refreshable credentials");
  const accessToken = stringValue(entry.key) ?? stringValue(entry.access_token) ?? "";
  const idToken = stringValue(entry.id_token);
  const claims = decodeJwt(accessToken);
  const expiresAt = stringValue(entry.expires_at);
  const parsedExpiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const expiresIn = Number.isFinite(parsedExpiry)
    ? Math.floor((parsedExpiry - Date.now()) / 1000)
    : claims.exp
      ? claims.exp - Math.floor(Date.now() / 1000)
      : 21_600;
  return mappedTokens(
    accessToken,
    stringValue(entry.refresh_token),
    idToken,
    expiresIn,
    stringValue(entry.token_type),
    stringValue(entry.scope),
  );
}
