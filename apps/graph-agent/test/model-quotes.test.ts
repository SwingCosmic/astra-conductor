import { expect, it } from "vitest";
import type { ModelEntryView, RateCard } from "@astra-conductor/contract/graph-agent";
import { entryQuotes } from "../src/server/model-quotes.js";
import { compareAmount } from "../ui/src/pages/amounts.js";

const card: RateCard = {
  rateCardId: "media",
  revision: "1",
  currency: "USD",
  chargeLines: [
    { lineId: "video", meter: "videoSeconds", per: { quantity: 1, unit: "s" }, amount: "0.06" },
  ],
  overrides: [
    {
      ruleId: "hd",
      mode: "replace",
      when: { quality: "HD", region: "CN" },
      setAmounts: { video: "0.10" },
    },
  ],
  entitlements: [],
};
const prepaid: RateCard = {
  ...card,
  currency: "CNY",
  scope: {
    providerId: "relay",
    offeringId: "CN",
    operation: "video-generation",
    access: "subscription",
    planKey: "prepaid",
  },
  entitlements: [
    { meter: "videoSeconds", included: { quantity: 5, unit: "s" }, overagePolicy: "charge" },
  ],
};

it("expands every plan with stable meter keys, scope conditions and access", () => {
  const entry = {
    prices: [],
    rateCard: card,
    rateCards: { default: card, prepaid },
  } as Pick<ModelEntryView, "prices" | "rateCard" | "rateCards">;
  const rates = entryQuotes(entry);
  expect(rates.filter((r) => r.planKey === "default").map((r) => r.amount)).toEqual([
    "0.06",
    "0.10",
  ]);
  const [base, override] = rates.filter((r) => r.planKey === "default");
  expect(base!.condition).not.toBe(override!.condition);
  expect(base!.condition).toBe("基础费率");
  expect(rates.filter((r) => r.planKey === "prepaid")).toMatchObject([
    { currency: "CNY", access: "subscription" },
    { currency: "CNY", access: "subscription" },
  ]);
});
it("quotes flat prices only when no effective card covers them", () => {
  const prices = [
    {
      key: {
        kind: "input" as const,
        currency: "USD",
        unit: "1M tokens",
        tier: null,
        durationSeconds: null,
      },
      amount: { value: "2", source: null },
    },
  ];
  const bare = { prices, rateCard: null, rateCards: {} } as Pick<
    ModelEntryView,
    "prices" | "rateCard" | "rateCards"
  >;
  expect(entryQuotes(bare)).toMatchObject([{ meterLabel: "input / 1M tokens", amount: "2" }]);
  const covered = { prices, rateCard: card, rateCards: { default: card } } as Pick<
    ModelEntryView,
    "prices" | "rateCard" | "rateCards"
  >;
  expect(entryQuotes(covered).every((r) => r.planKey === "default")).toBe(true);
});
it("orders exact decimal amounts including zero without IEEE-754 rounding", () => {
  expect(compareAmount("000.10", "0.1")).toBe(0);
  expect(compareAmount("0", "0.00000000000000000001")).toBeLessThan(0);
  expect(compareAmount("10000000000000000000000.11", "10000000000000000000000.10")).toBeGreaterThan(
    0,
  );
});
