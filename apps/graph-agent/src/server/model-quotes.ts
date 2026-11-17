import type {
  CatalogQuote,
  ModelEntryView,
  RateCard,
  RateCondition,
} from "@astra-conductor/contract/graph-agent";
import { modelMeterLabels } from "@astra-conductor/contract/graph-agent";

const normal = "无条件";

function scopeLabel(c: RateCondition) {
  const meter = c.meter ? (modelMeterLabels[c.meter] ?? c.meter) : "";
  return (
    [
      c.above !== undefined ? meter + " > " + c.above : null,
      c.atLeast !== undefined ? meter + " ≥ " + c.atLeast : null,
      c.region,
      c.quality,
      c.timeZone,
      c.weekdays?.length ? "星期 " + [...c.weekdays].sort().join(",") : null,
      c.windows
        ?.map((w) => w.join("–"))
        .sort()
        .join(" / "),
      c.excludeCalendarRef ? "排除日历 " + c.excludeCalendarRef : null,
    ]
      .filter(Boolean)
      .join(" · ") || normal
  );
}

function cardQuotes(card: RateCard, planKey: string): CatalogQuote[] {
  const values: CatalogQuote[] = [];
  const current = Date.now();
  if (
    (card.effectiveFrom && Date.parse(card.effectiveFrom) > current) ||
    (card.effectiveUntil && Date.parse(card.effectiveUntil) <= current)
  )
    return values;
  const access =
    card.scope?.access ?? (card.subscriptionFee || card.entitlements.length ? "subscription" : "");
  for (const line of card.chargeLines) {
    const entitlement = card.entitlements.find((e) => e.meter === line.meter);
    const basis = [
      card.scope?.region,
      card.scope?.planId,
      entitlement
        ? "权益 " +
          entitlement.included.quantity +
          " " +
          entitlement.included.unit +
          " · " +
          entitlement.overagePolicy
        : null,
    ].filter(Boolean);
    const meter = JSON.stringify([
      line.meter,
      line.per.quantity,
      line.per.unit,
      line.rounding?.mode ?? "exact",
      line.rounding?.scope ?? "total",
      line.rounding?.step ?? null,
    ]);
    const meterLabel =
      (modelMeterLabels[line.meter] ?? line.meter) +
      " / " +
      line.per.quantity +
      " " +
      line.per.unit;
    const rules = card.overrides.filter((rule) =>
      rule.mode === "replace"
        ? Object.hasOwn(rule.setAmounts, line.lineId)
        : rule.lineId === line.lineId,
    );
    const add = (condition: string, amount: string | null) => {
      const full = [...basis, condition].join(" · ");
      values.push({
        meter,
        meterLabel,
        condition: full,
        currency: card.currency,
        amount,
        access,
        planKey,
      });
    };
    if (!rules.some((r) => r.mode === "graduated"))
      add(rules.length ? "基础费率" : normal, line.amount);
    for (const r of rules) {
      if (r.mode === "replace") {
        add("条件覆盖 · " + scopeLabel(r.when), r.setAmounts[line.lineId] ?? null);
        continue;
      }
      let from = 0;
      for (const band of r.bands) {
        add(
          (r.applyTo === "accountBillingCycle" ? "账期累进" : "单次累进") +
            " · " +
            from +
            "–" +
            (band.upToInclusive ?? "不限"),
          band.amount,
        );
        if (band.upToInclusive !== null) from = band.upToInclusive;
      }
    }
  }
  return values;
}

/**
 * Expand an entry's base prices and every rate card into selectable quote rows.
 * Base prices are only quoted when no effective card covers them; cards that have
 * merged basic prices already contain those rows.
 */
export function entryQuotes(
  input: Pick<ModelEntryView, "prices" | "rateCard" | "rateCards">,
): CatalogQuote[] {
  const rows = Object.entries(input.rateCards).flatMap(([planKey, card]) =>
    cardQuotes(card, planKey),
  );
  if (input.rateCard) return rows;
  const fallback = input.prices.map(({ key, amount }) => {
    const condition =
      [key.tier, key.durationSeconds != null ? key.durationSeconds + " 秒" : null]
        .filter(Boolean)
        .join(" · ") || normal;
    return {
      meter: JSON.stringify([key.kind, key.unit]),
      meterLabel: key.kind + " / " + key.unit,
      condition,
      currency: key.currency,
      amount: amount.value,
      access: "",
      planKey: null,
    };
  });
  return [...fallback, ...rows];
}
