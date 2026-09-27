import { ANTIGRAVITY_CONFIG } from "../constants/stage7.ts";
import {
  getAntigravityIdeNodeHeaders,
  getAntigravityLoadCodeAssistMetadata,
  getAntigravityOAuthUserAgent,
} from "@omniroute/open-sse/services/antigravityHeaders.ts";
import { extractCodeAssistOnboardTierId } from "@omniroute/open-sse/services/codeAssistSubscription.ts";

export interface AntigravityTokens {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface AntigravityPostExchange {
  projectId: string;
  tierId: string;
  email: string | null;
  oauthClient: "builtin" | `custom:${string}`;
  projectDiscoveryOutcome?: "requires_manual_project" | "discovery_failed";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function projectId(value: unknown): string {
  const project = record(value).cloudaicompanionProject;
  if (typeof project === "string") return project;
  const id = record(project).id;
  return typeof id === "string" ? id : "";
}

async function firstOk(
  urls: readonly string[],
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) return response;
      lastError = new Error(`Antigravity endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No Antigravity endpoint is available");
}

export function buildAntigravityAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_CONFIG.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: ANTIGRAVITY_CONFIG.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${ANTIGRAVITY_CONFIG.authorizeUrl}?${params.toString()}`;
}

export async function exchangeAntigravityToken(
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AntigravityTokens> {
  const response = await fetchImpl(ANTIGRAVITY_CONFIG.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": getAntigravityOAuthUserAgent(),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ANTIGRAVITY_CONFIG.clientId,
      client_secret: ANTIGRAVITY_CONFIG.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) throw new Error(`Antigravity token exchange failed (${response.status})`);
  const tokens = record(await response.json());
  if (typeof tokens.access_token !== "string" || !tokens.access_token) {
    throw new Error("Antigravity token response is incomplete");
  }
  return tokens as unknown as AntigravityTokens;
}

async function loadCodeAssist(
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await firstOk(
    ANTIGRAVITY_CONFIG.loadCodeAssistEndpoints,
    {
      method: "POST",
      headers: getAntigravityIdeNodeHeaders(accessToken),
      body: JSON.stringify({ metadata: getAntigravityLoadCodeAssistMetadata() }),
    },
    fetchImpl,
  );
  return record(await response.json());
}

export async function finishAntigravityExchange(
  tokens: AntigravityTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<AntigravityPostExchange> {
  const userInfoResponse = await fetchImpl(`${ANTIGRAVITY_CONFIG.userInfoUrl}?alt=json`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  const userInfo = userInfoResponse?.ok ? record(await userInfoResponse.json()) : {};
  const email = typeof userInfo.email === "string" ? userInfo.email : null;
  let subscription: Record<string, unknown>;
  try {
    subscription = await loadCodeAssist(tokens.access_token, fetchImpl);
  } catch {
    return {
      projectId: "",
      tierId: "legacy-tier",
      email,
      oauthClient: "builtin",
      projectDiscoveryOutcome: "discovery_failed",
    };
  }
  let discoveredProject = projectId(subscription);
  const tierId = extractCodeAssistOnboardTierId(subscription);
  if (!discoveredProject) {
    let onboardAccepted = false;
    try {
      await firstOk(
        ANTIGRAVITY_CONFIG.onboardUserEndpoints,
        {
          method: "POST",
          headers: getAntigravityIdeNodeHeaders(tokens.access_token),
          body: JSON.stringify({
            tier_id: tierId,
            metadata: getAntigravityLoadCodeAssistMetadata(),
          }),
        },
        fetchImpl,
      );
      onboardAccepted = true;
      subscription = await loadCodeAssist(tokens.access_token, fetchImpl);
      discoveredProject = projectId(subscription);
    } catch {
      // The outcome below distinguishes a missing project from a failed request.
    }
    if (!discoveredProject) {
      return {
        projectId: "",
        tierId,
        email,
        oauthClient: "builtin",
        projectDiscoveryOutcome: onboardAccepted ? "requires_manual_project" : "discovery_failed",
      };
    }
  }
  return {
    projectId: discoveredProject,
    tierId,
    email,
    oauthClient: "builtin",
  };
}
