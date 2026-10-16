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

  it("passes tier names through verbatim instead of folding them into coarse labels", async () => {
    // [astra] 偏差特征：叶子停止关键词折叠（ULTRA→Ultra 等）后，长 tier 名
    // （`Antigravity Starter Quota`）与 Ultra 5x / 20x 的区分由原始 tier 名
    // 承载，目录侧用精确键 + 正则接住（见 providers-catalog 测试）。
    const cases: Array<[string, string]> = [
      ["Antigravity Starter Quota", "Antigravity Starter Quota"],
      ["Ultra 5x", "Ultra 5x"],
      ["Ultra 20x", "Ultra 20x"],
      ["Pro (Restricted)", "Pro"],
    ];
    for (const [tier, expected] of cases) {
      const adapter = new AntigravityAdapter(
        async (input) => {
          const url = String(input);
          if (url.includes("loadCodeAssist")) return json({ currentTier: { name: tier } });
          if (url.includes("retrieveUserQuotaSummary")) {
            return json({
              groups: [
                {
                  displayName: "Gemini Models",
                  buckets: [{ displayName: "Weekly Quota", remainingFraction: 0.5 }],
                },
              ],
            });
          }
          return new Response(null, { status: 404 });
        },
        { now: () => now },
      );
      const account: Account = {
        id: "agy-tier",
        provider: "antigravity",
        offeringId: "antigravity",
        authMethod: "browser-oauth",
        stableIdentity: "project-1:user",
        displayName: "user@example.test",
        maskedIdentifier: "us***@example.test",
        enabled: true,
        credentialState: "available",
        publicMetadata: { projectId: "project-1" },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      const snapshot = await adapter.fetchUsage(account, {
        version: 1,
        accountId: account.id,
        provider: "antigravity",
        authMethod: "browser-oauth",
        expiresAt: null,
        secrets: { accessToken: "access", refreshToken: "refresh" },
      });
      expect(snapshot.plan, tier).toBe(expected);
    }
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

  it("merges raw per-model quotas into their model-family groups", async () => {
    // 上游三源：fetchAvailableModels（按模型目录视图）+ retrieveUserQuota（按模型
    // 实时消耗，优先覆盖目录刻度）+ retrieveUserQuotaSummary（按族 5h/周聚合）。
    // 有按模型 5 小时数据的族不再重复展示族级 5h 聚合桶，周配额保留。
    // 展示名 live 优先：供应商会反复改模型目录，营销名可能挂在目录快照不认识的
    // 新引擎 id 上（"Gemini 3.1 Flash Lite" 实际由 gemini-3.8-flash-tiered 提供），
    // 行内 detail 保留桶的原始 id 供核对。
    const adapter = new AntigravityAdapter(
      async (input) => {
        const url = String(input);
        if (url.includes("loadCodeAssist")) return json({ currentTier: { name: "Starter" } });
        if (url.includes("retrieveUserQuotaSummary")) {
          return json({
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [
                  {
                    bucketId: "five_hour",
                    displayName: "5 Hour Quota",
                    remainingFraction: 0.6,
                    resetTime: "2026-09-27T12:00:00.000Z",
                  },
                  {
                    bucketId: "weekly",
                    displayName: "Weekly Quota",
                    remainingFraction: 0.4,
                    resetTime: "2026-10-01T00:00:00.000Z",
                  },
                ],
              },
              {
                displayName: "Claude and GPT models",
                buckets: [
                  {
                    bucketId: "five_hour",
                    displayName: "5 Hour Quota",
                    remainingFraction: 0.8,
                    resetTime: "2026-09-27T12:00:00.000Z",
                  },
                  {
                    bucketId: "weekly",
                    displayName: "Weekly Quota",
                    remainingFraction: 0.7,
                    resetTime: "2026-10-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          });
        }
        if (url.includes("fetchAvailableModels")) {
          return json({
            models: {
              "gemini-3.8-flash-tiered": {
                displayName: "Gemini 3.1 Flash Lite",
                quotaInfo: { remainingFraction: 0.9, resetTime: "2026-09-27T12:00:00.000Z" },
              },
              "gemini-internal-preview": {
                isInternal: true,
                quotaInfo: { remainingFraction: 0.9, resetTime: "2026-09-27T12:00:00.000Z" },
              },
              "gemini-2.5-flash": { quotaInfo: {} },
              "claude-opus-4-6-thinking": {
                quotaInfo: { remainingFraction: 0.25, resetTime: "2026-09-27T12:00:00.000Z" },
              },
              "gpt-oss-120b-medium": { quotaInfo: { remainingFraction: 1 } },
            },
          });
        }
        if (url.includes("retrieveUserQuota")) {
          // 实时桶优先：目录刻度 90%，实时只剩 50%；目录外新模型只出现在这里。
          return json({
            buckets: [
              {
                modelId: "gemini-3.8-flash-tiered",
                remainingFraction: 0.5,
                resetTime: "2026-09-27T12:00:00.000Z",
              },
              { modelId: "gemini-4.2-flash-solo", remainingFraction: 0.75 },
            ],
          });
        }
        return new Response(null, { status: 404 });
      },
      { now: () => now },
    );
    const snapshot = await adapter.fetchUsage(
      {
        id: "agy-models",
        provider: "antigravity",
        offeringId: "antigravity",
        authMethod: "browser-oauth",
        stableIdentity: "project-1:user",
        displayName: "user@example.test",
        maskedIdentifier: "us***@example.test",
        enabled: true,
        credentialState: "available",
        publicMetadata: { projectId: "project-1" },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        version: 1,
        accountId: "agy-models",
        provider: "antigravity",
        authMethod: "browser-oauth",
        expiresAt: null,
        secrets: { accessToken: "access", refreshToken: "refresh" },
      },
    );

    expect(snapshot.groups.map((group) => group.displayName)).toEqual([
      "Gemini Models",
      "Claude and GPT models",
    ]);
    const gemini = snapshot.groups[0]?.quotas ?? [];
    // 族级 5h 聚合桶让位给按模型 5h 数据；周配额保留；实时桶覆盖目录刻度。
    // 展示名取 live 目录的 displayName；目录外新模型回退原始 id。
    expect(gemini.map((quota) => quota.displayName)).toEqual([
      "Weekly Quota",
      "Gemini 3.1 Flash Lite",
      "gemini-4.2-flash-solo",
    ]);
    expect(gemini[1]).toMatchObject({
      key: "gemini_3_8_flash_tiered",
      detail: "gemini-3.8-flash-tiered",
      windowSeconds: 18_000,
      remainingPercentage: 50,
    });
    expect(gemini[2]).toMatchObject({
      key: "gemini_4_2_flash_solo",
      detail: "gemini-4.2-flash-solo",
    });
    expect(gemini[0]?.detail ?? null).toBeNull();
    const claudeGpt = snapshot.groups[1]?.quotas ?? [];
    expect(claudeGpt.map((quota) => quota.displayName)).toEqual([
      "Weekly Quota",
      "Claude Opus 4.6 (Thinking)",
      "GPT-OSS 120B (Medium)",
    ]);
    expect(claudeGpt[1]).toMatchObject({ detail: "claude-opus-4-6-thinking" });
    expect(claudeGpt[2]).toMatchObject({ unlimited: true, remainingPercentage: 100 });
    // internal 模型、无 quotaInfo 的 retired 模型不进快照。
    expect(
      snapshot.groups.flatMap((group) => group.quotas.map((quota) => quota.key)),
    ).not.toContain("gemini_internal_preview");
    expect(snapshot.overallRemainingPercentage).toBe(25);
  });

  it("synthesizes family groups from model quotas when the summary RPC is unavailable", async () => {
    const adapter = new AntigravityAdapter(
      async (input) => {
        const url = String(input);
        if (url.includes("loadCodeAssist")) return json({ currentTier: { name: "Starter" } });
        if (url.includes("fetchAvailableModels")) {
          return json({
            models: {
              "gemini-3.1-flash-lite": {
                quotaInfo: { remainingFraction: 0.8, resetTime: "2026-09-27T12:00:00.000Z" },
              },
              "claude-sonnet-4-6": {
                quotaInfo: { remainingFraction: 0.6, resetTime: "2026-09-27T12:00:00.000Z" },
              },
            },
          });
        }
        return new Response(null, { status: 404 });
      },
      { now: () => now },
    );
    const snapshot = await adapter.fetchUsage(
      {
        id: "agy-nosummary",
        provider: "antigravity",
        offeringId: "antigravity",
        authMethod: "browser-oauth",
        stableIdentity: "project-1:user",
        displayName: "user@example.test",
        maskedIdentifier: "us***@example.test",
        enabled: true,
        credentialState: "available",
        publicMetadata: { projectId: "project-1" },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        version: 1,
        accountId: "agy-nosummary",
        provider: "antigravity",
        authMethod: "browser-oauth",
        expiresAt: null,
        secrets: { accessToken: "access", refreshToken: "refresh" },
      },
    );

    expect(snapshot.groups.map((group) => group.displayName)).toEqual([
      "Gemini Models",
      "Claude and GPT Models",
    ]);
    expect(snapshot.groups[0]?.quotas[0]?.displayName).toBe("Gemini 3.1 Flash Lite");
    expect(snapshot.groups[0]?.quotas[0]?.detail).toBe("gemini-3.1-flash-lite");
    expect(snapshot.groups[1]?.quotas[0]?.displayName).toBe("Claude Sonnet 4.6 (Thinking)");
  });
});
