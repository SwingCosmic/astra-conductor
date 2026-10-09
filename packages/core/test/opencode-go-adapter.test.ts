import { describe, expect, it, vi } from "vitest";
import { OpencodeGoAdapter, type Account, type CredentialEnvelope } from "../src/internal.js";

const now = new Date("2026-10-01T00:00:00.000Z");

function quotaResponse() {
  return Response.json({
    usage: {
      rolling: { status: "ok", percent: 25, resetsAt: "2026-10-01T05:00:00.000Z" },
      weekly: { status: "ok", percent: 50, resetsAt: "2026-10-07T00:00:00.000Z" },
      monthly: { status: "rate-limited", percent: 80, resetsAt: "2026-11-01T00:00:00.000Z" },
    },
  });
}

describe("OpencodeGoAdapter", () => {
  it("validates and masks an API key without exposing it in metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://opencode.ai/zen/go/v1/usage");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer oc-secret-key");
      return quotaResponse();
    });
    const adapter = new OpencodeGoAdapter(fetchImpl, { now: () => now });

    const result = await adapter.createProvisioning("Bearer oc-secret-key");

    expect(result).toMatchObject({
      authMethod: "api-key",
      displayName: "OpenCode Go",
      maskedIdentifier: "oc-s***-key",
      publicMetadata: { product: "opencode-go" },
      credentials: { provider: "opencode-go", secrets: { apiKey: "oc-secret-key" } },
    });
    expect(JSON.stringify(result.publicMetadata)).not.toContain("oc-secret-key");
  });

  it("normalizes all three official quota windows", async () => {
    const adapter = new OpencodeGoAdapter(async () => quotaResponse(), { now: () => now });
    const account = { id: "opencode-1", provider: "opencode-go" } as Account;
    const envelope = {
      provider: "opencode-go",
      secrets: { apiKey: "oc-secret-key" },
    } as CredentialEnvelope;

    const result = await adapter.fetchUsage(account, envelope);

    expect(result.plan).toBe("OpenCode Go");
    expect(result.overallRemainingPercentage).toBe(0);
    expect(result.groups[0]?.quotas).toEqual([
      expect.objectContaining({ key: "session", used: 3, total: 12, remainingPercentage: 75 }),
      expect.objectContaining({ key: "weekly", used: 15, total: 30, remainingPercentage: 50 }),
      expect.objectContaining({ key: "monthly", used: 60, total: 60, remainingPercentage: 0 }),
    ]);
  });

  it("classifies rejected keys as authentication failures", async () => {
    const adapter = new OpencodeGoAdapter(async () => new Response("", { status: 401 }));

    await expect(adapter.createProvisioning("bad-key")).rejects.toMatchObject({
      code: "authentication",
      retryable: false,
    });
  });
});
