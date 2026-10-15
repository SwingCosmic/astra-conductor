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
    const requests: Array<{
      url: string;
      authorization: string | null;
      method: string;
      body: string | null;
    }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("Authorization"),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (url.endsWith("/use")) return Response.json({ success: true, code: 200, data: {} });
      return url.includes("customer-package-reset") ? resetResponse() : quotaResponse();
    };
    const adapter = new GlmAdapter(fetchImpl, { now: () => now });
    const provisioning = await adapter.createProvisioning(
      "china-secret-key",
      "bigmodel-coding-plan",
    );
    const account = {
      id: "glm-china",
      provider: "glm" as const,
      offeringId: "bigmodel-coding-plan",
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
    const envelope = {
      ...provisioning.credentials,
      accountId: account.id,
    };
    const snapshot = await adapter.fetchUsage(account, envelope);

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
    // [astra] 偏差特征：归一化标识（TitleCase 改写 + 去 "Plan" 后缀）之外的
    // 上游原始 planName 附带为 rawPlanLabel，仅目录未命中时作展示回退。
    expect(snapshot.rawPlanLabel).toBe("GLM Coding Pro Plan");
    // CREDIT_LIMIT 带 usage 计数是真实原始量；TOKENS_LIMIT 仅百分比，合成刻度不标 rawAmounts。
    expect(snapshot.groups[0]?.quotas).toMatchObject([
      { key: "session", remaining: 21_000, remainingPercentage: 75, rawAmounts: true },
      { key: "weekly", remainingPercentage: 40, rawAmounts: false },
    ]);
    expect(snapshot.extras).toEqual([]);
    expect(snapshot.resetCredits).toEqual({
      kind: "itemized",
      items: [
        { id: "1", type: "five-hour", expiresAt: "2099-09-25 13:00:00" },
        { id: "2", type: "five-hour", expiresAt: "2099-09-25 15:00:00" },
        { id: "3", type: "weekly", expiresAt: "2099-09-26 13:00:00" },
      ],
    });

    await adapter.redeemResetCard(account, envelope, { kind: "item", itemId: "1" });
    const redemption = requests.find((request) => request.url.endsWith("/use"));
    expect(redemption).toMatchObject({
      url: "https://open.bigmodel.cn/api/biz/customer-package-reset/use",
      authorization: "Bearer china-secret-key",
      method: "POST",
    });
    expect(JSON.parse(redemption?.body ?? "{}")).toMatchObject({
      targetType: "PERSONAL",
      resetType: "FIVE_HOUR",
      recordId: 1,
      requestId: expect.any(String),
    });
    await expect(
      adapter.redeemResetCard(account, envelope, { kind: "item", itemId: "missing" }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      adapter.redeemResetCard(account, envelope, { kind: "aggregate" }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("drops the MCP monthly meter when the plan reports no allotment for it", async () => {
    // 计划未包含 MCP 月度窗口时 TIME_LIMIT 无 usage/total，剩余按 0 计——
    // 无额度却带百分比读数的表不进快照，避免 0% 误报。
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("customer-package-reset")) return resetResponse();
      return Response.json({
        success: true,
        code: 200,
        data: {
          planName: "GLM Coding Lite Plan",
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
            { type: "TIME_LIMIT", percentage: 100 },
          ],
        },
      });
    };
    const adapter = new GlmAdapter(fetchImpl, { now: () => now });
    const provisioning = await adapter.createProvisioning(
      "china-secret-key",
      "bigmodel-coding-plan",
    );
    const account = {
      id: "glm-lite",
      provider: "glm" as const,
      offeringId: "bigmodel-coding-plan",
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

    expect(snapshot.groups[0]?.quotas.map((quota) => quota.key)).toEqual(["session", "weekly"]);
    expect(snapshot.groups[0]?.quotas.every((quota) => quota.total > 0)).toBe(true);
  });

  it("keeps international accounts separate and rejects invalid keys", async () => {
    const urls: string[] = [];
    const adapter = new GlmAdapter(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("customer-package-reset")) return resetResponse();
      return quotaResponse();
    });
    const china = await adapter.createProvisioning("shared-key", "bigmodel-coding-plan");
    const international = await adapter.createProvisioning("shared-key", "zai-coding-plan");
    const imported = await adapter.createProvisioning(
      "imported-key",
      "bigmodel-coding-plan",
      "cli-import",
    );
    expect(china.stableIdentity).not.toBe(international.stableIdentity);
    expect(china.offeringId).toBe("bigmodel-coding-plan");
    expect(international.offeringId).toBe("zai-coding-plan");
    expect(imported.authMethod).toBe("cli-import");
    expect(imported.credentials.authMethod).toBe("cli-import");
    expect(international.publicMetadata).toEqual({});
    expect(urls).toContain("https://api.z.ai/api/monitor/usage/quota/limit");

    const invalid = new GlmAdapter(async () => new Response("", { status: 401 }));
    await expect(
      invalid.createProvisioning("bad-key", "bigmodel-coding-plan"),
    ).rejects.toMatchObject({
      code: "authentication",
    });
    await expect(adapter.createProvisioning("shared-key", "glm")).rejects.toMatchObject({
      code: "validation",
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
    const input = await adapter.createProvisioning("private-key-value", "bigmodel-coding-plan");
    const first = await provisioner.save(input);
    const second = await provisioner.save(input);
    expect(second.id).toBe(first.id);
    expect(JSON.stringify(first)).not.toContain("private-key-value");
    expect(storage.accounts.list()).toHaveLength(1);
  });
});
