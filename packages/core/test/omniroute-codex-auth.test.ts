import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCodexBackendIdentityHeaders } from "../src/vendor/omniroute/open-sse/config/codexClient.ts";
import {
  __resetRefreshSerializerForTest,
  serializeRefresh,
} from "../src/vendor/omniroute/open-sse/services/refreshSerializer.ts";
import { getRefreshLeadMs } from "../src/vendor/omniroute/open-sse/services/tokenRefresh.ts";
import { refreshCodexToken } from "../src/vendor/omniroute/open-sse/services/tokenRefresh/providers/codex.ts";
import { getCodexUsage } from "../src/vendor/omniroute/open-sse/services/usage/codex.ts";
import {
  CodexDeviceFlowError,
  requestUserCode,
  runCodexDeviceFlow,
} from "../src/vendor/omniroute/src/lib/oauth/codexDeviceFlow.ts";
import { CODEX_CONFIG } from "../src/vendor/omniroute/src/lib/oauth/constants/oauth.ts";
import { codex } from "../src/vendor/omniroute/src/lib/oauth/providers/codex.ts";
import {
  flattenCodexImportPayload,
  normalizeCodexImportRecord,
} from "../src/vendor/omniroute/src/lib/oauth/services/codexImport.ts";
import { parseAndValidateCodexAuth } from "../src/vendor/omniroute/src/lib/oauth/utils/codexAuthImport.ts";
import {
  generateCodeChallenge,
  generatePKCE,
} from "../src/vendor/omniroute/src/lib/oauth/utils/pkce.ts";

const USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const POLL_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
type FetchInput = Parameters<typeof fetch>[0];

function fakeJwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.CODEX_REFRESH_SPACING_MS;
  __resetRefreshSerializerForTest();
});

describe("vendored Codex browser OAuth", () => {
  it("builds the PKCE login URL with isolated multi-account login", () => {
    const url = new URL(
      codex.buildAuthUrl(
        CODEX_CONFIG,
        "http://localhost:1455/auth/callback",
        "state-1",
        "challenge-1",
      ),
    );

    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CODEX_CONFIG.clientId);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
  });

  it("exchanges an authorization code with the fixed callback and verifier", async () => {
    const fetchMock = vi.fn(async (_input: FetchInput, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe(CODEX_CONFIG.clientId);
      expect(body.get("code")).toBe("code-1");
      expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
      expect(body.get("code_verifier")).toBe("verifier-1");
      return jsonResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        id_token: "id-1",
        expires_in: 3600,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await codex.exchangeToken(
      CODEX_CONFIG,
      "code-1",
      "http://localhost:1455/auth/callback",
      "verifier-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(TOKEN_URL, expect.objectContaining({ method: "POST" }));
    expect(tokens.refresh_token).toBe("refresh-1");
  });

  it("maps the selected workspace and per-user identity from the ID token", () => {
    const idToken = fakeJwt({
      email: "member@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "personal-workspace",
        chatgpt_plan_type: "free",
        chatgpt_user_id: "user-1",
        organizations: [
          {
            id: "team-workspace",
            is_default: false,
            role: "member",
            title: "Example Team",
          },
        ],
      },
    });

    const mapped = codex.mapTokens({
      access_token: "access-1",
      refresh_token: "refresh-1",
      id_token: idToken,
      expires_in: 3600,
    });

    expect(mapped.email).toBe("member@example.com");
    expect(mapped.providerSpecificData.workspaceId).toBe("team-workspace");
    expect(mapped.providerSpecificData.workspacePlanType).toBe("team");
    expect(mapped.providerSpecificData.chatgptUserId).toBe("user-1");
  });
});

describe("vendored Codex custom device authorization", () => {
  it("runs user-code, pending poll, and token exchange without Web session state", async () => {
    const calls: string[] = [];
    let pollCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url === USERCODE_URL) {
          expect(JSON.parse(String(init?.body))).toEqual({ client_id: CODEX_CONFIG.clientId });
          return jsonResponse({
            device_auth_id: "device-1",
            user_code: "ABCD-1234",
            interval: 0.001,
          });
        }
        if (url === POLL_URL) {
          pollCount += 1;
          if (pollCount === 1) return new Response("pending", { status: 403 });
          return jsonResponse({ authorization_code: "code-1", code_verifier: "verifier-1" });
        }
        const body = new URLSearchParams(String(init?.body));
        expect(url).toBe(TOKEN_URL);
        expect(body.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
        expect(body.get("code_verifier")).toBe("verifier-1");
        return jsonResponse({
          access_token: "access-1",
          refresh_token: "refresh-1",
          id_token: "id-1",
          expires_in: 3600,
        });
      }),
    );

    const seenCodes: string[] = [];
    const tokens = await runCodexDeviceFlow({
      clientId: CODEX_CONFIG.clientId,
      onUserCode: ({ userCode }) => seenCodes.push(userCode),
    });

    expect(seenCodes).toEqual(["ABCD-1234"]);
    expect(tokens.refresh_token).toBe("refresh-1");
    expect(calls).toEqual([USERCODE_URL, POLL_URL, POLL_URL, TOKEN_URL]);
  });

  it("reports account-level device authorization gating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("disabled", { status: 404 })),
    );

    await expect(requestUserCode(CODEX_CONFIG.clientId)).rejects.toMatchObject({
      code: "device_disabled",
      status: 404,
    } satisfies Partial<CodexDeviceFlowError>);
  });
});

describe("vendored Codex refresh and usage requests", () => {
  it("refreshes without scope and persists a rotated refresh token", async () => {
    const fetchMock = vi.fn(async (_input: FetchInput, init?: RequestInit) => {
      const body = init?.body;
      expect(body).toBeInstanceOf(URLSearchParams);
      const params = body as URLSearchParams;
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("refresh-old");
      expect(params.get("client_id")).toBe(CODEX_CONFIG.clientId);
      expect(params.has("scope")).toBe(false);
      return jsonResponse({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
      });
    });

    await expect(refreshCodexToken("refresh-old", null, fetchMock)).resolves.toEqual({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresIn: 3600,
    });
    expect(fetchMock).toHaveBeenCalledWith(TOKEN_URL, expect.any(Object));
  });

  it("classifies OAuth error codes and every 401 as unrecoverable", async () => {
    const reused = await refreshCodexToken("refresh-old", null, async () =>
      jsonResponse({ error: { code: "refresh_token_reused" } }, 400),
    );
    expect(reused).toEqual({
      error: "unrecoverable_refresh_error",
      code: "refresh_token_reused",
    });

    const unauthorized = await refreshCodexToken("refresh-old", null, async () =>
      jsonResponse({ error: { message: "rejected" } }, 401),
    );
    expect(unauthorized).toEqual({
      error: "unrecoverable_refresh_error",
      code: "unauthorized",
    });
  });

  it("sends the bound workspace and Codex identity to the usage endpoint", async () => {
    const fetchMock = vi.fn(async (_input: FetchInput, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer access-1");
      expect(headers.get("chatgpt-account-id")).toBe("workspace-1");
      expect(headers.get("originator")).toBe("codex_cli_rs");
      expect(headers.get("version")).toBeTruthy();
      return jsonResponse({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 25, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 10, limit_window_seconds: 604_800 },
        },
        rate_limit_reset_credits: { available_count: 2 },
      });
    });

    const usage = await getCodexUsage("access-1", { workspaceId: "workspace-1" }, fetchMock);

    if (!("quotas" in usage)) throw new Error(usage.message);
    expect(usage.plan).toBe("plus");
    expect(usage.quotas?.session?.remaining).toBe(75);
    expect(usage.quotas?.weekly?.remaining).toBe(90);
    expect(usage.bankedResetCredits).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("vendored Codex credential import", () => {
  it("prefers the access-token expiry and preserves workspace plus user identity", () => {
    const now = Math.floor(Date.now() / 1000);
    const idToken = fakeJwt({
      exp: now - 60,
      email: "member@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "workspace-1",
        chatgpt_user_id: "user-1",
      },
    });
    const accessToken = fakeJwt({ exp: now + 3600 });

    const parsed = parseAndValidateCodexAuth({
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: "refresh-1",
      },
    });

    expect(parsed.accountId).toBe("workspace-1");
    expect(parsed.userId).toBe("user-1");
    expect(parsed.email).toBe("member@example.com");
    expect(new Date(parsed.expiresAt ?? 0).getTime()).toBe((now + 3600) * 1000);
  });

  it("normalizes nested CLI and camelCase bulk records without database access", () => {
    const idToken = fakeJwt({
      email: "member@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "workspace-1",
        chatgpt_plan_type: "team",
      },
    });
    const nested = normalizeCodexImportRecord({
      tokens: {
        access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "refresh-1",
        id_token: idToken,
      },
    });
    expect(nested.ok).toBe(true);
    if (nested.ok) {
      expect(nested.payload.providerSpecificData?.workspaceId).toBe("workspace-1");
      expect(nested.payload.providerSpecificData?.chatgptPlanType).toBe("team");
    }

    const camel = normalizeCodexImportRecord({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      idToken,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(camel.ok).toBe(true);
    expect(flattenCodexImportPayload([{}, {}])).toEqual({ ok: true, records: [{}, {}] });
  });
});

describe("vendored Codex protocol support", () => {
  it("generates valid PKCE material and preserves the five-minute refresh lead", () => {
    const pair = generatePKCE();
    expect(pair.codeVerifier.length).toBe(43);
    expect(pair.state.length).toBe(43);
    expect(pair.codeChallenge).toBe(generateCodeChallenge(pair.codeVerifier));
    expect(pair.codeChallenge).toBe(
      createHash("sha256").update(pair.codeVerifier).digest("base64url"),
    );
    expect(getRefreshLeadMs("codex")).toBe(5 * 60 * 1000);
    expect(getRefreshLeadMs("codex", { refreshLeadMs: 90_000 })).toBe(90_000);
    expect(getCodexBackendIdentityHeaders()).toMatchObject({
      originator: "codex_cli_rs",
    });
  });

  it("serializes sibling Codex refreshes", async () => {
    process.env.CODEX_REFRESH_SPACING_MS = "0";
    let active = 0;
    let maxActive = 0;
    const run = () =>
      serializeRefresh("codex", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      });

    await Promise.all([run(), run(), run()]);
    expect(maxActive).toBe(1);
  });
});
