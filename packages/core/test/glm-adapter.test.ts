import { describe, expect, it } from "vitest";
import {
  CredentialVault,
  GlmAccountProvisioner,
  GlmAdapter,
  MemoryStorage,
  type CredentialCipherPort,
} from "../src/internal.js";

const now = new Date("2026-09-25T12:00:00.000Z");

class FakeCipher implements CredentialCipherPort {
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async encrypt(plaintext: string): Promise<Uint8Array> {
    return Buffer.from(plaintext);
  }

  async decrypt(ciphertext: Uint8Array): Promise<{ plaintext: string; shouldReEncrypt: boolean }> {
    return { plaintext: Buffer.from(ciphertext).toString(), shouldReEncrypt: false };
  }
}

function quotaResponse(): Response {
  return Response.json({
    success: true,
    code: 200,
    data: {
      planName: "GLM Coding Pro Plan",
      limits: [
        {
          type: "CREDIT_LIMIT",
          unit: 3,
          number: 5,
          percentage: 25,
          usage: 28_000,
          currentValue: 7_000,
          remaining: 21_000,
          nextResetTime: Date.parse("2026-09-25T15:00:00.000Z"),
        },
        {
          type: "TOKENS_LIMIT",
          unit: 6,
          number: 1,
          percentage: 60,
          nextResetTime: Date.parse("2026-09-30T00:00:00.000Z"),
        },
      ],
    },
  });
}

function resetResponse(): Response {
  return Response.json({
    success: true,
    code: 200,
    data: {
      fiveHourResets: [
        { recordId: 2, expireTime: "2099-09-25 15:00:00", resetType: "FIVE_HOUR" },
        { recordId: 1, expireTime: "2099-09-25 13:00:00", resetType: "FIVE_HOUR" },
      ],
      weekResets: [{ recordId: 3, expireTime: "2099-09-26 13:00:00", resetType: "WEEK" }],
    },
  });
}

describe("GLM Coding Plan adapter", () => {
  it("uses the China endpoints and exposes ordered reset-card details", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return url.includes("customer-package-reset") ? resetResponse() : quotaResponse();
    };
    const adapter = new GlmAdapter(fetchImpl, { now: () => now });
    const provisioning = await adapter.createProvisioning("china-secret-key", "china");
    const account = {
      id: "glm-china",
      provider: "glm" as const,
      authMethod: "api-key" as const,
      stableIdentity: provisioning.stableIdentity,
      displayName: provisioning.displayName,
      maskedIdentifier: provisioning.maskedIdentifier,
      enabled: true,
      credentialState: "available" as const,
      publicMetadata: provisioning.publicMetadata,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const snapshot = await adapter.fetchUsage(account, {
      ...provisioning.credentials,
      accountId: account.id,
    });

    expect(requests.map((request) => request.url)).toContain(
      "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    );
    expect(requests.some((request) => request.url.includes("/list?targetType=PERSONAL"))).toBe(
      true,
    );
    expect(requests.every((request) => request.authorization === "Bearer china-secret-key")).toBe(
      true,
    );
    expect(snapshot.plan).toBe("Glm Coding Pro");
    expect(snapshot.groups[0]?.quotas).toMatchObject([
      { key: "session", remaining: 21_000, remainingPercentage: 75 },
      { key: "weekly", remainingPercentage: 40 },
    ]);
    expect(snapshot.extras).toEqual([
      {
        key: "reset-credits",
        value: "3",
        items: [
          { key: "five_hour:0", kind: "five-hour", expiresAt: "2099-09-25 13:00:00" },
          { key: "five_hour:1", kind: "five-hour", expiresAt: "2099-09-25 15:00:00" },
          { key: "week:2", kind: "weekly", expiresAt: "2099-09-26 13:00:00" },
        ],
      },
    ]);
  });

  it("keeps international accounts separate and rejects invalid keys", async () => {
    const urls: string[] = [];
    const adapter = new GlmAdapter(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("customer-package-reset")) return resetResponse();
      return quotaResponse();
    });
    const china = await adapter.createProvisioning("shared-key", "china");
    const international = await adapter.createProvisioning("shared-key", "international");
    const imported = await adapter.createProvisioning("imported-key", "china", "cli-import");
    expect(china.stableIdentity).not.toBe(international.stableIdentity);
    expect(imported.authMethod).toBe("cli-import");
    expect(imported.credentials.authMethod).toBe("cli-import");
    expect(international.publicMetadata).toMatchObject({
      region: "international",
      presentationId: "zai-coding-plan",
    });
    expect(urls).toContain("https://api.z.ai/api/monitor/usage/quota/limit");

    const invalid = new GlmAdapter(async () => new Response("", { status: 401 }));
    await expect(invalid.createProvisioning("bad-key", "china")).rejects.toMatchObject({
      code: "authentication",
    });
  });

  it("deduplicates an account without exposing the API key", async () => {
    const storage = new MemoryStorage();
    const vault = new CredentialVault(storage, new FakeCipher(), () => now);
    const provisioner = new GlmAccountProvisioner(
      storage,
      vault,
      () => now,
      () => "glm-1",
    );
    const adapter = new GlmAdapter(async (input) =>
      String(input).includes("customer-package-reset") ? resetResponse() : quotaResponse(),
    );
    const input = await adapter.createProvisioning("private-key-value", "china");
    const first = await provisioner.save(input);
    const second = await provisioner.save(input);
    expect(second.id).toBe(first.id);
    expect(JSON.stringify(first)).not.toContain("private-key-value");
    expect(storage.accounts.list()).toHaveLength(1);
  });
});
