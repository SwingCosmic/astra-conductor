import { httpServices } from "./service-helpers.js";
import { describe, expect, it } from "vitest";
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
      httpServices(
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
              currentTier: { id: "free-tier", name: "Antigravity" },
              paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
            });
          }
          return new Response(null, { status: 404 });
        },
        { now: () => now },
      ),
    );
    const authorization = adapter.createBrowserAuthorization("http://localhost:43210/callback");
    const url = new URL(authorization.url);
    expect(url.searchParams.get("scope")).not.toContain("openid");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");

    const provisioning = await adapter.finishBrowserAuthorization(authorization, "code-1");
    expect(provisioning.publicMetadata).toMatchObject({
      projectId: "project-1",
      tier: "Google AI Pro",
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
              // A missing fraction remains unknown even with a valid reset.
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
        {
          displayName: "Weekly Quota",
          windowSeconds: 604_800,
          remainingPercentage: null,
          remaining: null,
        },
        { displayName: "5 Hour Quota", windowSeconds: 18_000, remainingPercentage: 75 },
      ],
    });
  });

  it("passes tier names through verbatim instead of folding them into coarse labels", async () => {
    // [astra] 偏差特征：叶子停止关键词折叠（ULTRA→Ultra 等）后，长 tier 名
    // （`Antigravity Starter Quota`）与 Ultra 5x / 20x 的区分由原始 tier 名
    // 承载，目录侧用精确键 + 正则接住（见 providers-catalog 测试）。
    const cases: Array<[unknown, string, string?]> = [
      ...["Antigravity Starter Quota", "Ultra 5x", "Ultra 20x"].map((name): [unknown, string] => [
        { currentTier: { name } },
        name,
      ]),
      [{ currentTier: { name: "Pro (Restricted)" } }, "Pro"],
      [{ paidTier: { id: "g1-pro-tier" }, currentTier: { name: "Antigravity" } }, "g1-pro-tier"],
      [{ paidTier: { id: "g1-pro-tier", name: "Antigravity" } }, "g1-pro-tier"],
      [{ paidTier: { id: "g1-pro-tier", name: "Renamed subscription" } }, "g1-pro-tier"],
      [{ paidTier: { id: "future-tier", name: "New plan" } }, "New plan"],
      [null, "Google AI Pro", "Google AI Pro"],
      [{ currentTier: { id: "free-tier", name: "Antigravity" } }, "Google AI Pro", "Google AI Pro"],
      [null, "", "free-tier"],
      [{ currentTier: { name: "Free" } }, "Free", "Google AI Pro"],
      [{ paidTier: { name: "Ultra 5x" } }, "Ultra 5x", "Google AI Pro"],
    ];
    for (const [subscription, expected, previous] of cases) {
      const adapter = new AntigravityAdapter(
        httpServices(
          async (input) => {
            const url = String(input);
            if (url.includes("loadCodeAssist"))
              return subscription ? json(subscription) : new Response(null, { status: 503 });
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
        ),
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
        publicMetadata: { projectId: "project-1", tier: "free-tier" },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      const snapshot = await adapter.fetchUsage(
        account,
        {
          version: 1,
          accountId: account.id,
          provider: "antigravity",
          authMethod: "browser-oauth",
          expiresAt: null,
          secrets: { accessToken: "access", refreshToken: "refresh" },
        },
        previous,
      );
      expect(snapshot.plan).toBe(expected);
    }
  });

  it("uses a 15-minute refresh lead and normalizes live groups", async () => {
    const adapter = new AntigravityAdapter(
      httpServices(
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
      ),
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

  it("keeps official windows even when model balances differ; unaffiliated buckets stay separate", async () => {
    const requests: Array<{ url: string; userAgent: string | null }> = [];
    const adapter = new AntigravityAdapter(
      httpServices(
        async (input, init) => {
          const url = String(input);
          requests.push({ url, userAgent: new Headers(init?.headers).get("User-Agent") });
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
                opaque_20706: { quotaInfo: { remainingFraction: 1 } },
                opaque_23310: {
                  displayName: "Claude Preview",
                  quotaInfo: { remainingFraction: 0.01 },
                },
                chat_20706: { quotaInfo: { remainingFraction: 0.2 } },
                tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
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
      ),
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
      "其它",
    ]);
    const [gemini, thirdParty, other] = snapshot.groups;
    expect(gemini?.quotas.map((q) => [q.windowSeconds, q.remainingPercentage])).toEqual([
      [604800, 40],
      [18000, 60],
    ]);
    expect(thirdParty?.quotas.map((q) => [q.windowSeconds, q.remainingPercentage])).toEqual([
      [604800, 70],
      [18000, 80],
    ]);
    expect(other?.quotas).toMatchObject([
      { windowSeconds: null, remainingPercentage: 100, unlimited: false },
    ]);
    expect(snapshot.overallRemainingPercentage).toBe(40);
    // retrieveUserQuotaSummary must use the OmniRoute 1.4.4 CLI fingerprint; IDE calls use >= 2.5.5.
    const summaryReq = requests.find((r) => r.url.includes("retrieveUserQuotaSummary"));
    expect(summaryReq?.userAgent).toMatch(
      /^antigravity\/cli\/1\.4\.4 \(aidev_client; os_type=\w+; arch=\w+; cl=1003595037; auth_method=consumer\)$/,
    );
    const modelsReq = requests.find((r) => r.url.includes("fetchAvailableModels"));
    expect(modelsReq?.userAgent).toBe("antigravity/ide/2.5.5 darwin/arm64");
  });

  it("synthesizes family groups from model quotas when the summary RPC is unavailable", async () => {
    const adapter = new AntigravityAdapter(
      httpServices(
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
      ),
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
      "Claude and GPT models",
    ]);
    for (const [index, fraction] of [80, 60].entries()) {
      expect(snapshot.groups[index]?.quotas).toMatchObject([
        { windowSeconds: 604800, remainingPercentage: null },
        { windowSeconds: 18000, remainingPercentage: fraction, detail: "按组内模型最低剩余量估算" },
      ]);
    }
  });

  it("uses explicit upstream membership for opaque ids and filters internal/chat buckets from both sources", () => {
    const groups = parseAntigravityQuotaGroups(
      {
        groups: [
          {
            displayName: "Gemini Models",
            description: "Models within this group: opaque_123",
            buckets: [{ window: "weekly", remaining: { remainingFraction: 1 } }],
          },
          {
            displayName: "Gemini 4 Argon",
            buckets: [
              {
                bucketId: "gemini-argon-wtu-weekly",
                displayName: "Weekly Limit Remaining",
                remaining: {
                  remainingFraction: 0.65,
                  resetTime: "2026-10-01T00:00:00.000Z",
                },
              },
            ],
          },
        ],
      },
      {
        models: {
          opaque_123: { quotaInfo: { remainingFraction: 1 } },
          chat_hidden: { quotaInfo: { remainingFraction: 0.1 } },
          opaque_internal: { isInternal: true, quotaInfo: { remainingFraction: 0 } },
          "gemini-flash-preview-new": { quotaInfo: { remainingFraction: 0.75 } },
        },
      },
      {
        buckets: [
          { modelId: "opaque_123", remainingFraction: 0.5 },
          { modelId: "opaque_internal", remainingFraction: 0 },
          { modelId: "chat_hidden", remainingFraction: 0.1 },
          { modelId: "opaque_456", remainingFraction: 1 },
        ],
      },
    );
    expect(groups.map((g) => g.displayName)).toEqual(["Gemini Models", "Gemini 4 Argon", "其它"]);
    expect(groups[0]?.quotas).toMatchObject([
      { remainingPercentage: 100, unlimited: false },
      { remainingPercentage: 50, windowSeconds: 18000 },
    ]);
    expect(groups[1]?.quotas).toMatchObject([
      {
        remainingPercentage: 65,
        windowSeconds: 604800,
        resetAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    expect(groups[2]?.quotas).toMatchObject([
      { remainingPercentage: 100, windowSeconds: null, unlimited: false },
    ]);
  });

  it("retries daily-cloudcode-pa on transient failures and never falls back to prod cloudcode-pa for quota RPCs", async () => {
    const requestedUrls: string[] = [];
    const failingAdapter = new AntigravityAdapter(
      httpServices(
        async (input) => {
          const url = String(input);
          requestedUrls.push(url);
          if (url.includes("loadCodeAssist")) return json({ paidTier: { name: "Google AI Pro" } });
          if (url.startsWith("https://cloudcode-pa.googleapis.com/")) {
            return json({
              groups: [
                {
                  displayName: "Gemini Models",
                  buckets: [
                    { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 1 },
                    { bucketId: "gemini-5h", window: "5h", remainingFraction: 1 },
                  ],
                },
              ],
            });
          }
          return new Response(null, { status: 503 });
        },
        { now: () => now },
      ),
    );
    const account: Account = {
      id: "agy-no-prod-fallback",
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
    const envelope = {
      version: 1 as const,
      accountId: account.id,
      provider: "antigravity" as const,
      authMethod: "browser-oauth" as const,
      expiresAt: null,
      secrets: { accessToken: "access", refreshToken: "refresh" },
    };

    await expect(failingAdapter.fetchUsage(account, envelope)).rejects.toThrow(
      /Antigravity quota summary is unavailable/,
    );
    const quotaUrls = requestedUrls.filter((url) => !url.includes("loadCodeAssist"));
    expect(quotaUrls.length).toBe(6);
    expect(
      quotaUrls.every((url) => url.startsWith("https://daily-cloudcode-pa.googleapis.com/")),
    ).toBe(true);

    let summaryCalls = 0;
    const recoveringAdapter = new AntigravityAdapter(
      httpServices(
        async (input) => {
          const url = String(input);
          if (url.includes("loadCodeAssist")) return json({ paidTier: { name: "Google AI Pro" } });
          if (url.includes("retrieveUserQuotaSummary")) {
            summaryCalls += 1;
            if (summaryCalls === 1) return new Response(null, { status: 503 });
            return json({
              groups: [
                {
                  displayName: "Gemini Models",
                  buckets: [
                    { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.9 },
                    { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.7 },
                  ],
                },
              ],
            });
          }
          return new Response(null, { status: 404 });
        },
        { now: () => now },
      ),
    );
    const snapshot = await recoveringAdapter.fetchUsage(account, envelope);
    expect(summaryCalls).toBe(2);
    expect(snapshot.groups[0]?.quotas.map((q) => q.remainingPercentage)).toEqual([90, 70]);
  });
});
