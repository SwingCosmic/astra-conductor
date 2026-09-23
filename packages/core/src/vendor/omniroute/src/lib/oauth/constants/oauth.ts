import { resolvePublicCred } from "@omniroute/open-sse/utils/publicCreds.ts";

// Codex (OpenAI) OAuth Configuration (Authorization Code Flow with PKCE)
export const CODEX_CONFIG = {
  clientId: resolvePublicCred("codex_id", "CODEX_OAUTH_CLIENT_ID"),
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scope: "openid profile email offline_access",
  codeChallengeMethod: "S256",
  // Additional OpenAI-specific params
  extraParams: {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
    // prompt=login forces Auth0/OpenAI to RE-AUTHENTICATE the user instead of
    // silently reusing an existing browser session. This is THE KEY parameter
    // that enables multi-account OAuth on the same device + same client_id:
    // without it, OAuth flow #2 carries over session state from OAuth flow #1
    // and Auth0 invalidates the previous account's refresh_token family as a
    // "session takeover". With prompt=login, each OAuth flow creates an
    // isolated session that does not trample siblings.
    // Ported from ndycode/codex-multi-auth (auth.ts: forceNewLogin option) —
    // the only known tool that sustains multiple Codex OAuth accounts.
    prompt: "login",
  },
};
