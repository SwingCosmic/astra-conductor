import { httpServices } from "./service-helpers.js";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, type Account, type CredentialEnvelope } from "../src/internal.js";

const now = new Date("2026-10-01T00:00:00.000Z");

function usageResponse() {
  return Response.json({
    tier: "max",
    five_hour: { utilization: 25, resets_at: "2026-10-01T05:00:00.000Z" },
    seven_day: { utilization: 40, resets_at: "2026-10-07T00:00:00.000Z" },
    limits: [
      {
        kind: "weekly_scoped",
        percent: 10,
        resets_at: "2026-10-07T00:00:00.000Z",
        scope: { model: { display_name: "Fable" } },
      },
    ],
  });
}

function bootstrapResponse() {
  return Response.json({
    oauth_account: {
      account_uuid: "acct-1",
      account_email: "claude@example.test",
      organization_uuid: "org-1",
      organization_name: "Example Org",
      organization_type: "team",
      organization_rate_limit_tier: "max",
    },
  });
}

function fetchMock() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/claude_cli/bootstrap")) return bootstrapResponse();
    if (url.endsWith("/api/oauth/usage")) {
      expect(new Headers(init?.headers).get("User-Agent")).toMatch(/^claude-code\//);
      return usageResponse();
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

describe("ClaudeAdapter", () => {
  it("imports Claude Code credentials and derives identity from bootstrap", async () => {
    const fetchImpl = fetchMock();
    const adapter = new ClaudeAdapter(httpServices(fetchImpl, { now: () => now }));

    const result = await adapter.createProvisioningFromCli({
      claudeAiOauth: {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: now.getTime() + 3_600_000,
        subscriptionType: "max",
      },
    });

    expect(result).toMatchObject({
      authMethod: "cli-import",
      stableIdentity: "account:acct-1",
      displayName: "claude@example.test",
      maskedIdentifier: "cl***@example.test",
      publicMetadata: {
        accountUuid: "acct-1",
        organizationUuid: "org-1",
        plan: "max",
      },
      credentials: {
        provider: "claude",
        secrets: { accessToken: "access-1", refreshToken: "refresh-1" },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("normalizes account and model quota windows", async () => {
    const adapter = new ClaudeAdapter(httpServices(fetchMock(), { now: () => now }));
    const account = {
      id: "claude-1",
      provider: "claude",
      offeringId: "claude",
      publicMetadata: {},
    } as Account;
    const envelope = {
      provider: "claude",
      secrets: { accessToken: "access-1", refreshToken: "refresh-1" },
    } as CredentialEnvelope;

    const result = await adapter.fetchUsage(account, envelope);

    expect(result.plan).toBe("max");
    expect(result.overallRemainingPercentage).toBe(60);
    expect(result.groups[0]?.quotas).toEqual([
      expect.objectContaining({ key: "session", windowSeconds: 18_000, remainingPercentage: 75 }),
      expect.objectContaining({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 60 }),
    ]);
    expect(result.groups[1]).toMatchObject({
      key: "model-limits",
      quotas: [expect.objectContaining({ key: "weekly-fable", remainingPercentage: 90 })],
    });
  });

  it("refreshes rotating OAuth credentials through the injected transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.anthropic.com/v1/oauth/token");
      expect(String(init?.body)).toContain("refresh_token=refresh-1");
      return Response.json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });
    });
    const adapter = new ClaudeAdapter(httpServices(fetchImpl, { now: () => now }));
    const account = { provider: "claude", offeringId: "claude", publicMetadata: {} } as Account;
    const envelope = {
      provider: "claude",
      expiresAt: now.toISOString(),
      secrets: { accessToken: "access-1", refreshToken: "refresh-1" },
    } as CredentialEnvelope;

    const result = await adapter.refreshCredentials(account, envelope, true);

    expect(result).toMatchObject({
      changed: true,
      envelope: {
        expiresAt: "2026-10-01T01:00:00.000Z",
        secrets: { accessToken: "access-2", refreshToken: "refresh-2" },
      },
    });
  });
});
