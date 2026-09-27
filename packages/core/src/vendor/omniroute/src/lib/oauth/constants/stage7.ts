import { resolvePublicCred } from "@omniroute/open-sse/utils/publicCreds.ts";
import {
  ANTIGRAVITY_BOOTSTRAP_BASE_URLS,
  getAntigravityFetchAvailableModelsUrls,
} from "@omniroute/open-sse/config/antigravityUpstream.ts";
import {
  GROK_BUILD_DEVICE_CODE_URL,
  GROK_BUILD_OAUTH_ISSUER,
  GROK_BUILD_OAUTH_SCOPES,
  GROK_BUILD_TOKEN_URL,
} from "@omniroute/open-sse/config/grokBuild.ts";

export const GROK_CLI_CONFIG = {
  clientId: resolvePublicCred("grok_id", "GROK_OAUTH_CLIENT_ID"),
  issuer: GROK_BUILD_OAUTH_ISSUER,
  deviceCodeUrl: GROK_BUILD_DEVICE_CODE_URL,
  tokenUrl: GROK_BUILD_TOKEN_URL,
  scope: GROK_BUILD_OAUTH_SCOPES.join(" "),
};

export const GROK_BUILD_OAUTH_CONFIG = {
  clientId: resolvePublicCred("grok_id", "GROK_OAUTH_CLIENT_ID"),
  authorizeUrl: `${GROK_BUILD_OAUTH_ISSUER}/oauth2/authorize`,
  tokenUrl: GROK_BUILD_TOKEN_URL,
  scope: "openid profile email offline_access grok-cli:access",
  codeChallengeMethod: "S256",
  loopbackPort: 56122,
  callbackPath: "/callback",
  callbackHost: "127.0.0.1",
};

export const ANTIGRAVITY_CONFIG = {
  clientId: resolvePublicCred("antigravity_id", "ANTIGRAVITY_OAUTH_CLIENT_ID"),
  clientSecret: resolvePublicCred("antigravity_alt", "ANTIGRAVITY_OAUTH_CLIENT_SECRET"),
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  loadCodeAssistEndpoints: ANTIGRAVITY_BOOTSTRAP_BASE_URLS.map(
    (baseUrl) => `${baseUrl}/v1internal:loadCodeAssist`,
  ),
  onboardUserEndpoints: ANTIGRAVITY_BOOTSTRAP_BASE_URLS.map(
    (baseUrl) => `${baseUrl}/v1internal:onboardUser`,
  ),
  fetchAvailableModelsEndpoints: getAntigravityFetchAvailableModelsUrls(),
};
