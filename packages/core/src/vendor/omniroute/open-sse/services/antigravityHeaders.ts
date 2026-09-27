const ANTIGRAVITY_IDE_FALLBACK_VERSION = "2.1.1";
const ANTIGRAVITY_IDE_TYPE_ENUM = 9;
const ANTIGRAVITY_PLUGIN_TYPE_GEMINI_ENUM = 2;

function platformEnum(): number {
  if (process.platform === "darwin") return process.arch === "arm64" ? 2 : 1;
  if (process.platform === "linux") return process.arch === "arm64" ? 4 : 3;
  if (process.platform === "win32") return 5;
  return 0;
}

export function getAntigravityOAuthUserAgent(): string {
  return `antigravity/${ANTIGRAVITY_IDE_FALLBACK_VERSION} darwin/arm64 google-api-nodejs-client/10.3.0`;
}

export function getAntigravityContentHeaders(accessToken?: string | null): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": `antigravity/ide/${ANTIGRAVITY_IDE_FALLBACK_VERSION} darwin/arm64`,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

export function getAntigravityIdeNodeHeaders(
  accessToken?: string | null,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": getAntigravityOAuthUserAgent(),
    "X-Goog-Api-Client": "gl-node/22.21.1",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

export function getAntigravityLoadCodeAssistMetadata(): Record<string, number> {
  return {
    ideType: ANTIGRAVITY_IDE_TYPE_ENUM,
    platform: platformEnum(),
    pluginType: ANTIGRAVITY_PLUGIN_TYPE_GEMINI_ENUM,
  };
}
