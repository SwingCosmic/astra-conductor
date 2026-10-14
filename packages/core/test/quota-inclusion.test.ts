import { describe, expect, it } from "vitest";
import type { UsageQuota } from "../src/internal.js";
import { includedQuotas } from "../src/providers/quota-inclusion.js";

function quota(partial: Partial<UsageQuota>): UsageQuota {
  return {
    key: partial.key ?? "meter",
    displayName: null,
    windowSeconds: null,
    used: 0,
    total: 100,
    remaining: 100,
    remainingPercentage: 100,
    resetAt: null,
    unlimited: false,
    ...partial,
  };
}

describe("quota inclusion gate", () => {
  it("drops zero-allotment meters that still report a percentage", () => {
    // 未包含的表：无正额度、非 unlimited、却带百分比读数（0% 误报形态）。
    expect(includedQuotas([quota({ key: "premium", total: 0, remainingPercentage: 0 })])).toEqual(
      [],
    );
  });

  it("keeps unlimited meters and unreported sentinels", () => {
    expect(
      includedQuotas([
        quota({ key: "chat", total: 0, remaining: 0, unlimited: true }),
        quota({ key: "models", total: 0, remaining: null, remainingPercentage: null }),
        quota({ key: "session" }),
      ]).map((item) => item.key),
    ).toEqual(["chat", "models", "session"]);
  });
});
