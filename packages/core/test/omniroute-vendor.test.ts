/**
 * Characterization tests ported from these OmniRoute upstream tests at commit
 * 3ee283bb944d6d62cc219f74317d5186942e1780:
 * - tests/unit/usage-quota-core-split.test.ts
 * - tests/unit/quota-window-label.test.ts
 * - tests/unit/codex-usage-windows.test.ts
 * - tests/unit/codex-usage-quotas-review-window.test.ts
 * - tests/unit/codex-usage-quotas-latent-window.test.ts
 * - tests/unit/codex-banked-reset-credits-5199.test.ts
 * - tests/unit/publicCreds.test.ts
 *
 * Only assertions for the manually selected, side-effect-free vendor files are
 * retained. These tests are project-owned and are not synchronization output.
 *
 * services/usage/github.ts was vendored verbatim from the same commit for the
 * GitHub Copilot provider (astra-only strict-ts cast annotated inline); the
 * describe block below pins its paid/free quota parsing, including the
 * #2876 limited-user remaining-count semantics.
 *
 * [astra] deviation family "rawAmounts": glm.ts and github.ts annotate each
 * quota with whether used/total are provider-reported raw counts versus the
 * percentage-synthesis fallback scales (total = 100). The github describe
 * block pins both sides of that annotation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_SPARK_DISPLAY_NAME,
  CODEX_SPARK_QUOTA_SESSION,
} from "../src/vendor/omniroute/open-sse/config/codexQuotaScopes.ts";
import { buildCodexUsageQuotas } from "../src/vendor/omniroute/open-sse/services/codexUsageQuotas.ts";
import {
  formatQuotaUsageReason,
  formatQuotaWindowLabel,
} from "../src/vendor/omniroute/open-sse/services/quotaWindowLabel.ts";
import {
  createQuotaFromUsage,
  parseResetTime,
} from "../src/vendor/omniroute/open-sse/services/usage/quota.ts";
import { getGitHubUsage } from "../src/vendor/omniroute/open-sse/services/usage/github.ts";
import {
  decodePublicCred,
  encodePublicCred,
  type EmbeddedDefaultKey,
  resolvePublicCred,
} from "../src/vendor/omniroute/open-sse/utils/publicCreds.ts";

describe("vendored quota primitives", () => {
  it("normalizes reset timestamps and clamps used values", () => {
    expect(parseResetTime(1_700_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
    expect(parseResetTime("1700000000")).toBe(new Date(1_700_000_000_000).toISOString());
    expect(parseResetTime(0)).toBeNull();
    expect(parseResetTime("not a date")).toBeNull();

    expect(createQuotaFromUsage(250, 100, null)).toEqual({
      used: 100,
      total: 100,
      remaining: 0,
      remainingPercentage: 0,
      resetAt: null,
      unlimited: false,
    });
  });

  it("derives duration-aware window labels", () => {
    expect(formatQuotaWindowLabel({ key: "session" })).toBe("session");
    expect(
      formatQuotaWindowLabel({
        key: "session",
        displayName: "Weekly",
        windowSeconds: 2_592_000,
      }),
    ).toBe("Monthly (30d)");
    expect(
      formatQuotaUsageReason(
        { key: "session", displayName: "Session", windowSeconds: 18_000 },
        99.6,
      ),
    ).toBe("Session (5h) usage 100%");
  });
});

describe("vendored Codex quota normalization", () => {
  it("preserves main window durations and normalizes snake_case fields", () => {
    const { quotas } = buildCodexUsageQuotas({
      rate_limit: {
        primary_window: {
          used_percent: 7,
          limit_window_seconds: 18_000,
          reset_at: 1_785_623_016,
        },
        secondary_window: {
          used_percent: 19,
          limit_window_seconds: 604_800,
          reset_at: 1_785_678_428,
        },
      },
    });

    expect(quotas.session).toEqual({
      used: 7,
      total: 100,
      remaining: 93,
      resetAt: new Date(1_785_623_016_000).toISOString(),
      unlimited: false,
      windowSeconds: 18_000,
    });
    expect(quotas.weekly).toEqual({
      used: 19,
      total: 100,
      remaining: 81,
      resetAt: new Date(1_785_678_428_000).toISOString(),
      unlimited: false,
      windowSeconds: 604_800,
    });
  });

  it("labels a 30-day primary window as Monthly", () => {
    const { quotas } = buildCodexUsageQuotas({
      rate_limit: {
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 2_592_000,
          reset_after_seconds: 100_000,
        },
      },
    });

    expect(quotas.session?.displayName).toBe("Monthly");
    expect(quotas.session?.windowSeconds).toBe(2_592_000);
  });

  it("normalizes dedicated and fallback review windows", () => {
    const dedicated = buildCodexUsageQuotas({
      code_review_rate_limit: {
        primary_window: { used_percent: 40 },
        secondary_window: { used_percent: 70 },
      },
      additional_rate_limits: [
        {
          limit_name: "review",
          rate_limit: { primary_window: { used_percent: 99 } },
        },
      ],
    }).quotas;
    expect(dedicated.code_review?.used).toBe(40);
    expect(dedicated.code_review_weekly?.used).toBe(70);

    const fallback = buildCodexUsageQuotas({
      additional_rate_limits: [
        {
          metered_feature: "code_review",
          rate_limit: {
            primary_window: { used_percent: 33 },
            secondary_window: { used_percent: 55 },
          },
        },
      ],
    }).quotas;
    expect(fallback.code_review?.remaining).toBe(67);
    expect(fallback.code_review_weekly?.remaining).toBe(45);
  });

  it("hides latent Spark limits and exposes active ones", () => {
    const week = 604_800;
    const latent = buildCodexUsageQuotas({
      additional_rate_limits: [
        {
          metered_feature: "codex_bengalfox",
          rate_limit: {
            primary_window: {
              used_percent: 0,
              limit_window_seconds: week,
              reset_after_seconds: week,
            },
          },
        },
      ],
    }).quotas;
    expect(latent[CODEX_SPARK_QUOTA_SESSION]).toBeUndefined();

    const active = buildCodexUsageQuotas({
      additional_rate_limits: [
        {
          metered_feature: "codex_bengalfox",
          rate_limit: {
            primary_window: {
              used_percent: 12,
              limit_window_seconds: week,
              reset_after_seconds: 400_000,
            },
          },
        },
      ],
    }).quotas;
    expect(active[CODEX_SPARK_QUOTA_SESSION]?.used).toBe(12);
    expect(active[CODEX_SPARK_QUOTA_SESSION]?.displayName).toBe(CODEX_SPARK_DISPLAY_NAME);
  });

  it("surfaces reset credits without introducing a redemption action", () => {
    const result = buildCodexUsageQuotas({
      rateLimit: { primaryWindow: { usedPercent: 5 } },
      rateLimitResetCredits: { availableCount: 7 },
      rateLimitReachedType: "primary_window",
    });

    expect(result.bankedResetCredits).toBe(7);
    expect(result.rateLimitReachedType).toBe("primary_window");
    expect(result.quotas.session?.used).toBe(5);
  });
});

describe("vendored github usage leaf", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("infers plan names and drops unlimited quota snapshots", async () => {
    vi.stubGlobal("fetch", (async () =>
      Response.json({
        copilot_plan: "copilot_pro_plus",
        quota_reset_date: "2026-11-01T00:00:00Z",
        quota_snapshots: {
          chat: { entitlement: 0, remaining: 0, unlimited: true },
          premium_interactions: { entitlement: 1500, remaining: 300, unlimited: false },
        },
      })) as typeof fetch);

    const result = await getGitHubUsage("gho_token");
    if ("message" in result) throw new Error(result.message ?? "unexpected");
    expect(result.plan).toBe("Copilot Pro+");
    expect(Object.keys(result.quotas)).toEqual(["premium_interactions"]);
    expect(result.quotas.premium_interactions).toMatchObject({
      used: 1200,
      total: 1500,
      remainingPercentage: 20,
      // [astra] 偏差特征：entitlement 计数是真实原始量。
      rawAmounts: true,
    });
  });

  it("marks percent-only snapshots as synthesized, not raw amounts", async () => {
    // [astra] 偏差特征：仅有 percent_remaining 的表会合成 total=100 刻度，
    // rawAmounts 必须为 false，UI 不得把它当作 使用量/总量 展示。
    vi.stubGlobal("fetch", (async () =>
      Response.json({
        access_type_sku: "free_limited",
        quota_reset_date: "2026-11-01T00:00:00Z",
        quota_snapshots: {
          chat: { entitlement: 0, remaining: 0, unlimited: false, percent_remaining: 45 },
        },
      })) as typeof fetch);

    const result = await getGitHubUsage("gho_token");
    if ("message" in result) throw new Error(result.message ?? "unexpected");
    expect(result.quotas.chat).toMatchObject({
      total: 100,
      used: 55,
      remainingPercentage: 45,
      rawAmounts: false,
    });
  });

  it("counts limited_user_quotas downward as remaining, not used (#2876)", async () => {
    vi.stubGlobal("fetch", (async () =>
      Response.json({
        access_type_sku: "free_limited",
        monthly_quotas: { chat: 50 },
        limited_user_quotas: { chat: 10 },
        limited_user_reset_date: "2026-11-01T00:00:00Z",
      })) as typeof fetch);

    const result = await getGitHubUsage("gho_token");
    if ("message" in result) throw new Error(result.message ?? "unexpected");
    expect(result.plan).toBe("Copilot Free");
    expect(result.quotas.chat).toMatchObject({
      used: 40,
      total: 50,
      remaining: 10,
      remainingPercentage: 20,
      // [astra] 偏差特征：monthly/limited 计数是真实请求量。
      rawAmounts: true,
    });
  });

  it("drops meters the subscription does not include (entitlement 0, percent 0)", async () => {
    // 真实免费账号形态：quota_snapshots 中 premium 只有 percent_remaining 0、
    // 无正额度；百分比合成不得把它渲染成"100 中剩余 0"。
    vi.stubGlobal("fetch", (async () =>
      Response.json({
        access_type_sku: "free_limited",
        quota_reset_date: "2026-11-01T00:00:00Z",
        quota_snapshots: {
          premium_interactions: {
            entitlement: 0,
            remaining: 0,
            unlimited: false,
            percent_remaining: 0,
          },
          chat: { entitlement: 200, remaining: 200, unlimited: false },
        },
      })) as typeof fetch);

    const result = await getGitHubUsage("gho_token");
    if ("message" in result) throw new Error(result.message ?? "unexpected");
    expect(Object.keys(result.quotas)).toEqual(["chat"]);
    expect(result.quotas.chat).toMatchObject({ total: 200, remainingPercentage: 100 });
    expect(result.plan).toBe("Copilot Free");
  });
});

describe("vendored public credential helpers", () => {
  const envName = "OMNIROUTE_TEST_PUBLIC_CRED";
  const original = process.env[envName];

  afterEach(() => {
    if (original === undefined) delete process.env[envName];
    else process.env[envName] = original;
  });

  it("resolves the credential keys the project consumes", () => {
    const keys = [
      "claude_id",
      "codex_id",
      "grok_id",
      "antigravity_id",
      "antigravity_alt",
      "github_copilot_id",
    ] satisfies EmbeddedDefaultKey[];

    for (const key of keys) expect(resolvePublicCred(key).length).toBeGreaterThan(0);
    expect(resolvePublicCred("grok_id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(resolvePublicCred("antigravity_id")).toMatch(
      /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/,
    );
    expect(resolvePublicCred("antigravity_alt")).toMatch(/^GOCSPX-/);
  });

  it("round-trips masked values and honors an environment override", () => {
    const sample = "public-client-value";
    expect(decodePublicCred(encodePublicCred(sample))).toBe(sample);

    process.env[envName] = "project-override!";
    expect(resolvePublicCred("codex_id", envName)).toBe("project-override!");
  });
});
