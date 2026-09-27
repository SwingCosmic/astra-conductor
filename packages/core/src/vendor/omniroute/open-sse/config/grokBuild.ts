export const GROK_BUILD_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_BUILD_OAUTH_ISSUER = "https://auth.x.ai";
export const GROK_BUILD_DEVICE_CODE_URL = `${GROK_BUILD_OAUTH_ISSUER}/oauth2/device/code`;
export const GROK_BUILD_TOKEN_URL = `${GROK_BUILD_OAUTH_ISSUER}/oauth2/token`;
export const GROK_BUILD_DEFAULT_CLIENT_VERSION = "0.2.106";
export const GROK_BUILD_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_BUILD_TOKEN_AUTH = "xai-grok-cli";
export const GROK_BUILD_OAUTH_REFERRER = "grok-build";

export const GROK_BUILD_OAUTH_SCOPES = Object.freeze([
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
]);

function mapPlatform(platform: string): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
}

function mapArch(arch: string): string {
  if (arch === "arm64") return "aarch64";
  if (arch === "x64") return "x86_64";
  return arch;
}

export function getGrokBuildOAuthHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "x-grok-client-version": GROK_BUILD_DEFAULT_CLIENT_VERSION,
    "x-grok-client-surface": "ui",
  };
}

export function getGrokBuildModelsHeaders(input: {
  token?: string | null;
  userId?: string | null;
  email?: string | null;
  principalType?: string | null;
}): Record<string, string> {
  const principalType = input.principalType?.trim().toLowerCase();
  const includeEmail = principalType !== "team" && principalType !== "organization";
  return {
    Accept: "application/json",
    "x-grok-client-version": GROK_BUILD_DEFAULT_CLIENT_VERSION,
    "x-grok-client-identifier": GROK_BUILD_CLIENT_IDENTIFIER,
    "x-grok-client-mode": "headless",
    "User-Agent": `${GROK_BUILD_CLIENT_IDENTIFIER}/${GROK_BUILD_DEFAULT_CLIENT_VERSION} (${mapPlatform(process.platform)}; ${mapArch(process.arch)})`,
    "X-XAI-Token-Auth": GROK_BUILD_TOKEN_AUTH,
    ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
    ...(input.userId ? { "x-userid": input.userId } : {}),
    ...(includeEmail && input.email ? { "x-email": input.email } : {}),
  };
}
