import { describe, expect, it } from "vitest";
import { estimateCharge, parseRateCard } from "../src/model-catalog/pricing.js";
import type { RateCard } from "@astra-conductor/contract/common";

const card: RateCard = {
  rateCardId: "example",
  revision: "1",
  currency: "USD",
  chargeLines: [],
  overrides: [],
  entitlements: [],
};
const line = (meter: string, amount: string, per = 1) => ({
  lineId: meter,
  meter,
  amount,
  per: { quantity: per, unit: "units" },
});
describe("model pricing", () => {
  it("separates input tokens already billed at the cached rate", () => {
    const rates = {
      ...card,
      chargeLines: [
        line("uncachedInputTokens", "2", 1e6),
        line("cachedInputTokens", "0.5", 1e6),
        line("outputTokens", "6", 1e6),
      ],
    };
    expect(
      estimateCharge(rates, {
        meters: { inputTokens: 10000, cachedInputTokens: 6000, outputTokens: 1000 },
      }).subtotal,
    ).toBe("0.017");
    expect(
      estimateCharge(
        { ...card, chargeLines: [line("videoSeconds", "0.06")] },
        { meters: { videoSeconds: 5 } },
      ).subtotal,
    ).toBe("0.3");
  });
  it("distinguishes strict whole-request thresholds and marginal tiers including a previous billing period balance", () => {
    const rates = { ...card, chargeLines: [line("tokens", "1", 1e6)] };
    const meters = { tokens: 1_200_000 };
    expect(
      estimateCharge(
        {
          ...rates,
          overrides: [
            {
              mode: "replace",
              ruleId: "large",
              when: { meter: "tokens", above: 1e6 },
              setAmounts: { tokens: "2" },
            },
          ],
        },
        { meters },
      ).subtotal,
    ).toBe("2.4");
    const graduated: RateCard = {
      ...rates,
      overrides: [
        {
          mode: "graduated",
          ruleId: "bands",
          lineId: "tokens",
          bands: [
            { upToInclusive: 1e6, amount: "1" },
            { upToInclusive: null, amount: "2" },
          ],
        },
      ],
    };
    expect(estimateCharge(graduated, { meters }).subtotal).toBe("1.4");
    const rule = graduated.overrides[0];
    if (rule.mode !== "graduated") throw Error();
    rule.applyTo = "accountBillingCycle";
    expect(estimateCharge(graduated, { meters }).status).toBe("unknown");
    expect(
      estimateCharge(graduated, { meters: { tokens: 200_000 }, usageBefore: { tokens: 900_000 } })
        .subtotal,
    ).toBe("0.3");
  });
  it("uses local peak windows, timezone and dated holiday evidence", () => {
    const rates: RateCard = {
      ...card,
      chargeLines: [line("requests", "1")],
      overrides: [
        {
          ruleId: "peak",
          mode: "replace",
          when: {
            timeZone: "Asia/Shanghai",
            weekdays: [1],
            windows: [["09:00", "12:00"]],
            excludeCalendarRef: "CN",
          },
          setAmounts: { requests: "2" },
        },
      ],
    };
    const w = { meters: { requests: 1 }, time: "2026-11-16T01:00:00Z" };
    expect(estimateCharge(rates, w).status).toBe("unknown");
    expect(estimateCharge(rates, { ...w, calendars: { CN: { "2026": [] } } }).subtotal).toBe("2");
    expect(
      estimateCharge(rates, { ...w, calendars: { CN: { "2026": ["2026-11-16"] } } }).subtotal,
    ).toBe("1");
    expect(estimateCharge(rates, { ...w, time: "2026-11-16T04:00:00Z" }).subtotal).toBe("1");
  });
  it("shows only the known subtotal when the provider omits a separately billed cache count", () => {
    const rates = {
      ...card,
      chargeLines: [
        line("uncachedInputTokens", "2", 1e6),
        line("cachedInputTokens", "0.5", 1e6),
        line("outputTokens", "6", 1e6),
      ],
    };
    const result = estimateCharge(rates, { meters: { inputTokens: 10000, outputTokens: 1000 } });
    expect(result).toMatchObject({ status: "partial", subtotal: "0.006" });
    expect(result.missing).toContain("uncachedInputTokens");
  });
  it("rounds each delivered asset before aggregating and keeps a flat subscription fee outside individual calls", () => {
    const rates: RateCard = {
      ...card,
      subscriptionFee: { amount: "20", period: "month" },
      chargeLines: [
        { ...line("seconds", "0.5"), rounding: { mode: "ceil", scope: "per-item", step: 1 } },
      ],
    };
    expect(estimateCharge(rates, { meters: { seconds: 1.2 } }).status).toBe("unknown");
    expect(
      estimateCharge(rates, { meters: { seconds: 1.2 }, items: { seconds: [0.1, 1.1] } }).subtotal,
    ).toBe("1.5");
    expect(parseRateCard(rates).subscriptionFee).toEqual({ amount: "20", period: "month" });
  });
  it("requires the specified card region and effective period", () => {
    const rates: RateCard = {
      ...card,
      scope: { providerId: "relay", offeringId: "cn", operation: "chat", region: "CN" },
      chargeLines: [line("requests", "2")],
      effectiveFrom: "2026-01-01T00:00:00Z",
      effectiveUntil: "2027-01-01T00:00:00Z",
    };
    const input = { time: "2026-05-01T00:00:00Z", meters: { requests: 1 } };
    expect(estimateCharge(rates, { ...input, region: "US" }).status).toBe("unknown");
    expect(estimateCharge(rates, input).missing).toContain("region");
    expect(estimateCharge(rates, { ...input, region: "CN" }).subtotal).toBe("2");
    expect(
      estimateCharge(rates, { ...input, region: "CN", time: "2027-01-01T00:00:00Z" }).status,
    ).toBe("unknown");
  });
  it("preserves included, blocked, unknown and cash zero states", () => {
    const rates: RateCard = {
      ...card,
      entitlements: [
        { meter: "requests", included: { quantity: 100, unit: "request" }, overagePolicy: "block" },
      ],
    };
    expect(
      estimateCharge(rates, { meters: { requests: 1 }, remaining: { requests: 1 } }).status,
    ).toBe("included");
    expect(
      estimateCharge(rates, { meters: { requests: 1 }, remaining: { requests: 0 } }).status,
    ).toBe("blocked");
    expect(estimateCharge(rates, { meters: { requests: 1 } }).status).toBe("unknown");
    expect(
      estimateCharge(
        { ...card, chargeLines: [line("requests", "0")] },
        { meters: { requests: 1 } },
      ),
    ).toMatchObject({ status: "estimated", subtotal: "0" });
    expect(() => parseRateCard({ ...card, chargeLines: [line("x", "-1")] })).toThrow();
  });
});
