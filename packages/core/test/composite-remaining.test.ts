import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAPSHOT_TTL_MS,
  SESSION_MAX_SECONDS,
  WEEKLY_MAX_SECONDS,
  computeCompositeRemaining,
  inferWindowFamily,
  remainingBand,
  snapshotFreshnessLimitMs,
  type CompositeRemainingAccountInput,
  type CompositeRemainingQuota,
  type CompositeRemainingSnapshot,
} from "../src/internal.js";

const fetchedAt = "2026-10-11T11:50:00.000Z";

/**
 * 套餐倍率查表键已从 provider 改为接入点：同一 provider 的各接入点目录可不同
 * （GLM 两个接入点当前一致）。此处映射测试中每个 provider 使用的代表接入点。
 */
const offeringByProvider: Record<CompositeRemainingAccountInput["provider"], string> = {
  antigravity: "antigravity",
  claude: "claude",
  codex: "codex",
  "grok-build": "grok-build",
  glm: "bigmodel-coding-plan",
  "opencode-go": "opencode-go",
};

function quota(
  partial: Partial<CompositeRemainingQuota> & Pick<CompositeRemainingQuota, "key">,
): CompositeRemainingQuota {
  return {
    displayName: null,
    windowSeconds: null,
    remainingPercentage: null,
    unlimited: false,
    ...partial,
  };
}

function snapshot(
  plan: string,
  quotas: CompositeRemainingQuota[],
  groups: CompositeRemainingSnapshot["groups"] = [{ key: "default", quotas }],
): CompositeRemainingSnapshot {
  return { plan, fetchedAt, groups };
}

function account(
  id: string,
  provider: CompositeRemainingAccountInput["provider"],
  plan: string,
  quotas: CompositeRemainingQuota[],
  extra?: Partial<CompositeRemainingAccountInput> & {
    groups?: CompositeRemainingSnapshot["groups"];
    fetchedAt?: string;
  },
): CompositeRemainingAccountInput {
  const usage = extra?.groups
    ? { plan, fetchedAt: extra.fetchedAt ?? fetchedAt, groups: extra.groups }
    : snapshot(plan, quotas);
  return {
    enabled: extra?.enabled ?? true,
    provider,
    offeringId: offeringByProvider[provider],
    snapshot: extra?.snapshot === undefined ? usage : extra.snapshot,
  };
}

describe("window family inference", () => {
  it("classifies by duration first, with 24h as session and 14d as week", () => {
    expect(inferWindowFamily(quota({ key: "monthly", windowSeconds: SESSION_MAX_SECONDS }))).toBe(
      "session",
    );
    expect(
      inferWindowFamily(quota({ key: "session", windowSeconds: SESSION_MAX_SECONDS + 1 })),
    ).toBe("week");
    expect(inferWindowFamily(quota({ key: "session", windowSeconds: WEEKLY_MAX_SECONDS }))).toBe(
      "week",
    );
    expect(
      inferWindowFamily(quota({ key: "session", windowSeconds: WEEKLY_MAX_SECONDS + 1 })),
    ).toBe("month");
  });

  it("falls back to key and display name when duration is missing", () => {
    expect(inferWindowFamily(quota({ key: "weekly" }))).toBe("week");
    expect(inferWindowFamily(quota({ key: "code_review_weekly" }))).toBe("week");
    expect(inferWindowFamily(quota({ key: "mcp_monthly" }))).toBe("month");
    expect(inferWindowFamily(quota({ key: "session" }))).toBe("session");
    expect(inferWindowFamily(quota({ key: "five_hour", displayName: "5 Hour Quota" }))).toBe(
      "session",
    );
    expect(inferWindowFamily(quota({ key: "product_grok_build" }))).toBeNull();
  });
});

describe("composite remaining", () => {
  it("uses equal weights when plan multipliers match", () => {
    const result = computeCompositeRemaining([
      account("a", "codex", "plus", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 80 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 40 }),
      ]),
      account("b", "codex", "plus", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 20 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 90 }),
      ]),
    ]);
    expect(result.status).toBe("complete");
    expect(result.sessionScore).toBe(50);
    expect(result.weeklyScore).toBe(65);
    expect(result.remaining).toBe(50);
    expect(result.band).toBe("attention");
    expect(result.sessionBand).toBe("attention");
    expect(result.weeklyBand).toBe("healthy");
  });

  it("weights GLM Lite and Max by the catalog multipliers", () => {
    const result = computeCompositeRemaining([
      account("lite", "glm", "lite", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 80 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 40 }),
      ]),
      account("max", "glm", "max", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 20 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 90 }),
      ]),
    ]);
    expect(result.sessionScore).toBeCloseTo(24, 5);
    expect(result.weeklyScore).toBeCloseTo(86.66666, 4);
    expect(result.remaining).toBeCloseTo(24, 5);
  });

  it("converts weekly-only remainings with the 1/5 session coefficient", () => {
    const high = computeCompositeRemaining([
      account("a", "codex", "plus", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 80 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 40 }),
      ]),
      account("b", "codex", "plus", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 20 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 90 }),
      ]),
      account("c", "codex", "plus", [
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 50 }),
      ]),
    ]);
    expect(high.sessionScore).toBeCloseTo(66.66666, 4);
    expect(high.weeklyScore).toBeCloseTo(60, 5);
    expect(high.remaining).toBeCloseTo(60, 5);

    const low = computeCompositeRemaining([
      account("c", "codex", "plus", [
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 10 }),
      ]),
    ]);
    expect(low.sessionScore).toBe(50);
    expect(low.weeklyScore).toBe(10);
    expect(low.remaining).toBe(10);
  });

  it("converts monthly-only remainings with month/4 and does not min against a monthly score", () => {
    const half = computeCompositeRemaining([
      account("m", "opencode-go", "OpenCode Go", [
        quota({ key: "monthly", windowSeconds: 2_592_000, remainingPercentage: 50 }),
      ]),
    ]);
    expect(half.weeklyScore).toBe(100);
    expect(half.sessionScore).toBe(100);
    expect(half.remaining).toBe(100);

    const ten = computeCompositeRemaining([
      account("m", "opencode-go", "OpenCode Go", [
        quota({ key: "monthly", windowSeconds: 2_592_000, remainingPercentage: 10 }),
      ]),
    ]);
    expect(ten.weeklyScore).toBe(40);
    expect(ten.sessionScore).toBe(100);
    expect(ten.remaining).toBe(40);

    const four = computeCompositeRemaining([
      account("m", "opencode-go", "OpenCode Go", [
        quota({ key: "monthly", windowSeconds: 2_592_000, remainingPercentage: 4 }),
      ]),
    ]);
    expect(four.weeklyScore).toBe(16);
    expect(four.sessionScore).toBe(80);
    expect(four.remaining).toBe(16);
  });

  it("ignores disabled accounts, model-limit groups, and unknown plans use mid weight 5", () => {
    const result = computeCompositeRemaining([
      account("on", "codex", "mystery-tier", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 100 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 100 }),
      ]),
      {
        ...account("off", "codex", "plus", [
          quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 0 }),
          quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 0 }),
        ]),
        enabled: false,
      },
      account("claude", "claude", "pro", [], {
        groups: [
          {
            key: "default",
            quotas: [
              quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 100 }),
              quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 100 }),
            ],
          },
          {
            key: "model-limits",
            quotas: [
              quota({ key: "weekly-fable", windowSeconds: 604_800, remainingPercentage: 0 }),
            ],
          },
        ],
      }),
    ]);
    expect(result.enabledAccountCount).toBe(2);
    expect(result.scoredAccountCount).toBe(2);
    expect(result.remaining).toBe(100);
    expect(result.status).toBe("complete");
  });

  it("treats missing snapshots as incomplete without scoring them as zero", () => {
    const mixed = computeCompositeRemaining([
      account("ok", "codex", "plus", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 10 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 10 }),
      ]),
      { enabled: true, provider: "glm", offeringId: "bigmodel-coding-plan", snapshot: null },
    ]);
    expect(mixed.status).toBe("incomplete");
    expect(mixed.scoredAccountCount).toBe(1);
    expect(mixed.remaining).toBe(10);
    expect(mixed.band).toBe("critical");
  });

  it("scores stored snapshots without regard to fetch time", () => {
    const stale = computeCompositeRemaining([
      account("old", "codex", "plus", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 80 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 80 }),
      ]),
    ]);
    expect(stale.status).toBe("complete");
    expect(stale.scoredAccountCount).toBe(1);
    expect(stale.remaining).toBe(80);
    expect(stale.band).toBe("healthy");
  });

  it("fully recomputes R from every stored snapshot instead of scoring only the latest refresh", () => {
    const result = computeCompositeRemaining([
      account("fresh", "codex", "plus", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 80 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 40 }),
      ]),
      account(
        "cached",
        "codex",
        "plus",
        [
          quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 20 }),
          quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 90 }),
        ],
        { fetchedAt: "2026-10-01T00:00:00.000Z" },
      ),
    ]);
    expect(result.status).toBe("complete");
    expect(result.scoredAccountCount).toBe(2);
    expect(result.sessionScore).toBe(50);
    expect(result.weeklyScore).toBe(65);
    expect(result.remaining).toBe(50);
  });

  it("scores missing longer windows as full and unlimited windows as full", () => {
    const sessionOnly = computeCompositeRemaining([
      account("s", "codex", "plus", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 40 }),
      ]),
    ]);
    expect(sessionOnly.sessionScore).toBe(40);
    expect(sessionOnly.weeklyScore).toBe(100);
    expect(sessionOnly.remaining).toBe(40);

    const unlimited = computeCompositeRemaining([
      account("u", "antigravity", "Pro", [
        quota({
          key: "session",
          windowSeconds: 18_000,
          remainingPercentage: null,
          unlimited: true,
        }),
        quota({
          key: "weekly",
          windowSeconds: 604_800,
          remainingPercentage: null,
          unlimited: true,
        }),
      ]),
    ]);
    expect(unlimited.remaining).toBe(100);
  });

  it("returns the empty unknown state when no enabled accounts exist", () => {
    const result = computeCompositeRemaining([
      {
        ...account("off", "codex", "plus", [
          quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 10 }),
        ]),
        enabled: false,
      },
    ]);
    expect(result).toMatchObject({
      status: "empty",
      remaining: null,
      sessionScore: null,
      weeklyScore: null,
      band: "unknown",
      enabledAccountCount: 0,
    });
  });

  it("is a pure function of enabled-account usage and is stable across repeated calls", () => {
    const input = [
      account("a", "codex", "plus", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 80 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 40 }),
      ]),
      account("b", "codex", "plus", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 20 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 90 }),
      ]),
    ];
    const first = computeCompositeRemaining(input);
    expect(computeCompositeRemaining(input)).toEqual(first);
    expect(computeCompositeRemaining(input)).toEqual(first);
    expect(
      computeCompositeRemaining([
        ...input,
        {
          ...account("off", "codex", "plus", [
            quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 0 }),
            quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 0 }),
          ]),
          enabled: false,
        },
      ]),
    ).toEqual(first);
  });

  it("equals the result of omitting disabled accounts instead of scoring their usage", () => {
    const enabled = account("on", "codex", "plus", [
      quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 40 }),
      quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 40 }),
    ]);
    const disabled = {
      ...account("off", "codex", "plus", [
        quota({ key: "session", windowSeconds: 18_000, remainingPercentage: 0 }),
        quota({ key: "weekly", windowSeconds: 604_800, remainingPercentage: 0 }),
      ]),
      enabled: false,
    };
    expect(computeCompositeRemaining([enabled, disabled])).toEqual(
      computeCompositeRemaining([enabled]),
    );
  });
});

describe("remaining bands and freshness", () => {
  it("maps 50 to attention, 20 to critical, and above 50 to healthy", () => {
    expect(remainingBand(50.1)).toBe("healthy");
    expect(remainingBand(50)).toBe("attention");
    expect(remainingBand(20.1)).toBe("attention");
    expect(remainingBand(20)).toBe("critical");
    expect(remainingBand(0)).toBe("critical");
    expect(remainingBand(null)).toBe("unknown");
  });

  it("uses two polling intervals, or 30 minutes when polling is off", () => {
    expect(snapshotFreshnessLimitMs(true, 15)).toBe(30 * 60 * 1000);
    expect(snapshotFreshnessLimitMs(false, 15)).toBe(DEFAULT_SNAPSHOT_TTL_MS);
  });
});
