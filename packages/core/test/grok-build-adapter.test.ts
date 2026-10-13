import { describe, expect, it, vi } from "vitest";
import { GrokBuildAdapter, type Account, type CredentialEnvelope } from "../src/internal.js";
import {
  pollGrokDeviceToken,
  requestGrokDeviceCode,
} from "../src/vendor/omniroute/src/lib/oauth/providers/grok-cli.ts";

const now = new Date("2026-09-27T08:00:00.000Z");

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
    JSON.stringify(payload),
  ).toString("base64url")}.signature`;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("Grok Build protocol", () => {
  it("uses the upstream device-code headers and validates the verification URL", async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-grok-client-surface")).toBe("ui");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("referrer")).toBe("grok-build");
      return json({
        device_code: "device-1",
        user_code: "ABCD-1234",
        verification_uri: "https://auth.x.ai/activate",
        verification_uri_complete: "https://auth.x.ai/activate?code=ABCD-1234",
        interval: 5,
        expires_in: 1800,
      });
    });
    await expect(requestGrokDeviceCode(fetchImpl)).resolves.toMatchObject({
      userCode: "ABCD-1234",
      interval: 5,
    });

    const pollFetch = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
      return json({ error: "authorization_pending" }, 400);
    });
    await expect(pollGrokDeviceToken("device-1", pollFetch)).resolves.toEqual({
      ok: false,
      data: { error: "authorization_pending" },
    });
  });

  it("imports a complete CLI file and preserves principal fields during refresh", async () => {
    const accessToken = jwt({
      email: "team@example.test",
      principal_type: "team",
      principal_id: "team-42",
      exp: Math.floor(now.getTime() / 1000) + 3600,
    });
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const adapter = new GrokBuildAdapter(
      async (input, init) => {
        calls.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
        return json({ access_token: "new-access", expires_in: 7200 });
      },
      { now: () => now },
    );
    const provisioning = adapter.fromCliAuth({
      "https://auth.x.ai::client": {
        key: accessToken,
        refresh_token: "refresh-1",
      },
    });
    expect(provisioning.stableIdentity).toBe("team:team-42");
    expect(provisioning.publicMetadata).toMatchObject({
      principalType: "team",
      principalId: "team-42",
      userId: "team-42",
    });
    const account: Account = {
      id: "grok-1",
      provider: "grok-build",
      offeringId: "grok-build",
      authMethod: "cli-import",
      stableIdentity: provisioning.stableIdentity,
      displayName: provisioning.displayName,
      maskedIdentifier: provisioning.maskedIdentifier,
      enabled: true,
      credentialState: "available",
      publicMetadata: provisioning.publicMetadata,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const envelope: CredentialEnvelope = {
      ...provisioning.credentials,
      accountId: account.id,
      expiresAt: new Date(now.getTime() - 1).toISOString(),
    };
    const refreshed = await adapter.refreshCredentials(account, envelope);
    expect(refreshed.envelope.secrets).toMatchObject({
      accessToken: "new-access",
      refreshToken: "refresh-1",
    });
    expect(calls[0]?.body.get("principal_type")).toBe("team");
    expect(calls[0]?.body.get("principal_id")).toBe("team-42");
  });

  it("normalizes weekly, product, credits, and auto-top-up usage", async () => {
    let autoTopUpAvailable = true;
    const adapter = new GrokBuildAdapter(
      async (input) => {
        const url = String(input);
        if (url.endsWith("/user?include=subscription")) {
          return json({ userId: "user-1", subscriptionTier: "SuperGrok Pro" });
        }
        if (url.includes("/billing?format=credits")) {
          return json({
            config: {
              creditUsagePercent: 20,
              currentPeriod: { end: "2026-10-01T00:00:00.000Z" },
              productUsage: [{ product: "Grok Build", usagePercent: 45 }],
              prepaidBalance: { val: -1234 },
            },
          });
        }
        if (url.endsWith("/auto-topup-rule")) {
          return autoTopUpAvailable
            ? json({ rule: { enabled: false } })
            : new Response(null, { status: 404 });
        }
        return new Response(null, { status: 404 });
      },
      { now: () => now },
    );
    const account: Account = {
      id: "grok-1",
      provider: "grok-build",
      offeringId: "grok-build",
      authMethod: "browser-oauth",
      stableIdentity: "user:user-1",
      displayName: "Grok",
      maskedIdentifier: "gro***",
      enabled: true,
      credentialState: "available",
      publicMetadata: { userId: "user-1" },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const snapshot = await adapter.fetchUsage(account, {
      version: 1,
      accountId: account.id,
      provider: "grok-build",
      authMethod: "browser-oauth",
      expiresAt: null,
      secrets: { accessToken: "access", refreshToken: "refresh" },
    });
    expect(snapshot.plan).toBe("SuperGrok Pro");
    expect(snapshot.groups[0]?.quotas).toMatchObject([
      { key: "weekly", remainingPercentage: 80, windowSeconds: 604_800 },
      { key: "product_grok_build", displayName: "Grok Build", remainingPercentage: 55 },
    ]);
    expect(snapshot.extras).toEqual([
      { key: "extra-credits", value: "$12.34" },
      { key: "auto-top-up", value: "已停用" },
    ]);

    autoTopUpAvailable = false;
    const snapshotWithoutAutoTopUp = await adapter.fetchUsage(account, {
      version: 1,
      accountId: account.id,
      provider: "grok-build",
      authMethod: "browser-oauth",
      expiresAt: null,
      secrets: { accessToken: "access", refreshToken: "refresh" },
    });
    expect(snapshotWithoutAutoTopUp.extras).toEqual([{ key: "extra-credits", value: "$12.34" }]);
  });
});
