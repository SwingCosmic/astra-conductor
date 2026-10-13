import { describe, expect, it, vi } from "vitest";
import { AntigravityAdapter, type Account } from "../src/internal.js";
import { parseAntigravityQuotaGroups } from "../src/vendor/omniroute/open-sse/services/usage/antigravity.ts";

const now = new Date("2026-09-27T08:00:00.000Z");

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("Antigravity protocol", () => {
  it("uses Google consent without openid and discovers a project with numeric metadata", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new AntigravityAdapter(
      async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("oauth2.googleapis.com/token")) {
          return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
        }
        if (url.includes("userinfo")) return json({ email: "user@example.test" });
        if (url.includes("loadCodeAssist")) {
          const body = JSON.parse(String(init?.body)) as { metadata: Record<string, unknown> };
          expect(body.metadata).toMatchObject({ ideType: 9, pluginType: 2 });
          expect(typeof body.metadata.platform).toBe("number");
          return json({
            cloudaicompanionProject: { id: "project-1" },
            currentTier: { id: "PRO", name: "Pro" },
          });
        }
        return new Response(null, { status: 404 });
      },
      { now: () => now },
    );
    const authorization = adapter.createBrowserAuthorization("http://localhost:43210/callback");
    const url = new URL(authorization.url);
    expect(url.searchParams.get("scope")).not.toContain("openid");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");

    const provisioning = await adapter.finishBrowserAuthorization(authorization, "code-1");
    expect(provisioning.publicMetadata).toMatchObject({
      projectId: "project-1",
      clientProfile: "ide",
      oauthClient: "builtin",
    });
    expect(provisioning.credentials.secrets.refreshToken).toBe("refresh");
    expect(requests.some((request) => request.url.includes("loadCodeAssist"))).toBe(true);
  });

  it("keeps grouped five-hour and weekly quotas and leaves missing fractions unknown", async () => {
    const groups = parseAntigravityQuotaGroups({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "five_hour",
              displayName: "5 Hour Quota",
              remainingFraction: 0.75,
              resetTime: "2026-09-27T13:00:00.000Z",
            },
            {
              bucketId: "weekly",
              displayName: "Weekly Quota",
              remainingFraction: 0.4,
              resetTime: "2026-10-01T00:00:00.000Z",
            },
            { bucketId: "unknown", displayName: "Preview Quota" },
          ],
        },
      ],
    });
    expect(groups[0]).toMatchObject({
      displayName: "Gemini Models",
      quotas: [
        { displayName: "5 Hour Quota", windowSeconds: 18_000, remainingPercentage: 75 },
        { displayName: "Weekly Quota", windowSeconds: 604_800, remainingPercentage: 40 },
        { displayName: "Preview Quota", remainingPercentage: null, remaining: null },
      ],
    });
  });

  it("uses a 15-minute refresh lead and normalizes live groups", async () => {
    const adapter = new AntigravityAdapter(
      async (input, init) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) {
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("refresh_token")).toBe("refresh-old");
          return json({ access_token: "access-new", expires_in: 3600 });
        }
        if (url.includes("loadCodeAssist")) return json({ currentTier: { name: "Starter" } });
        if (url.includes("retrieveUserQuotaSummary")) {
          return json({
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [{ displayName: "Weekly Quota", remainingFraction: 0.9 }],
              },
            ],
          });
        }
        return new Response(null, { status: 404 });
      },
      { now: () => now },
    );
    const account: Account = {
      id: "agy-1",
      provider: "antigravity",
      offeringId: "antigravity",
      authMethod: "browser-oauth",
      stableIdentity: "project-1:user",
      displayName: "user@example.test",
      maskedIdentifier: "us***@example.test",
      enabled: true,
      credentialState: "available",
      publicMetadata: { projectId: "project-1", tier: "Starter" },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const envelope = {
      version: 1 as const,
      accountId: account.id,
      provider: "antigravity" as const,
      authMethod: "browser-oauth" as const,
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      secrets: { accessToken: "access-old", refreshToken: "refresh-old" },
    };
    const refreshed = await adapter.refreshCredentials(account, envelope);
    expect(refreshed.changed).toBe(true);
    expect(refreshed.envelope.secrets).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-old",
    });
    const snapshot = await adapter.fetchUsage(account, refreshed.envelope);
    expect(snapshot.plan).toBe("Starter");
    expect(snapshot.groups[0]?.displayName).toBe("Gemini Models");
    expect(snapshot.overallRemainingPercentage).toBe(90);
  });
});
