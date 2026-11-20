import { Decimal } from "decimal.js";
import {
  ContractValidationError,
  type BillingEstimate,
  type BillingWorkload,
  type RateCard,
  type RateCondition,
  type RateRule,
  type ChargeLine,
} from "@astra-conductor/contract/common";

const Money = Decimal.clone({ precision: 80 });
const invalid = (field: string): never => {
  throw new ContractValidationError("计费字段无效：" + field, field);
};
function record(value: unknown, field: string): Record<string, unknown> {
  if (value == null || Array.isArray(value) || typeof value !== "object") return invalid(field);
  return value as Record<string, unknown>;
}
function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > 500) return invalid(field);
  return value;
}
function word(v: unknown, field: string, max = 128): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /[\x00-\x1f]/.test(v) ||
    Object.hasOwn(Object.prototype, v) ||
    v === "prototype"
  )
    return invalid(field);
  return v;
}
function quantity(v: unknown, field: string, positive = false): number {
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < 0 ||
    v > Number.MAX_SAFE_INTEGER ||
    (positive && v === 0)
  )
    return invalid(field);
  return v;
}
function amount(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !/^\d{1,28}(?:\.\d{1,24})?$/.test(v)) return invalid("amount");
  return v;
}
function unique(values: string[], field: string) {
  if (new Set(values).size !== values.length) return invalid(field);
}
function time(v: unknown, key: string): string {
  const s = word(v, key);
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s) || !Number.isFinite(Date.parse(s)))
    return invalid(key);
  return s;
}
function meterValues(v: unknown, key: string): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record(v, key)).map(([k, n]) => [word(k, key), quantity(n, key)]),
  );
}
function parseCondition(v: unknown): RateCondition {
  const r = { ...record(v, "when") },
    out: RateCondition = {};
  if ("metric" in r || "op" in r || "value" in r) {
    if ("meter" in r || "above" in r || "atLeast" in r || (r.op !== "gt" && r.op !== "gte"))
      return invalid("when");
    r.meter = word(r.metric, "metric");
    r[r.op === "gt" ? "above" : "atLeast"] = quantity(r.value, "value");
    delete r.metric;
    delete r.op;
    delete r.value;
  }
  const supported = [
    "meter",
    "above",
    "atLeast",
    "quality",
    "region",
    "timeZone",
    "weekdays",
    "windows",
    "excludeCalendarRef",
  ];
  if (Object.keys(r).some((k) => !supported.includes(k))) return invalid("when");
  for (const key of ["meter", "quality", "region", "timeZone", "excludeCalendarRef"] as const)
    if (r[key] !== undefined) out[key] = word(r[key], key);
  for (const key of ["above", "atLeast"] as const)
    if (r[key] !== undefined) out[key] = quantity(r[key], key);
  if ((out.above !== undefined || out.atLeast !== undefined) !== Boolean(out.meter))
    return invalid("when.meter");
  if (out.timeZone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: out.timeZone });
    } catch {
      return invalid("timeZone");
    }
  }
  if (r.weekdays !== undefined)
    out.weekdays = list(r.weekdays, "weekdays").map((n) => {
      if (!Number.isInteger(n) || Number(n) < 1 || Number(n) > 7) return invalid("weekdays");
      return Number(n);
    });
  if (r.windows !== undefined)
    out.windows = list(r.windows, "windows").map((pair) => {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        pair.some((x) => typeof x !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) ||
        pair[0] === pair[1]
      )
        return invalid("windows");
      return [pair[0], pair[1]];
    });
  if ((out.windows || out.weekdays || out.excludeCalendarRef) && !out.timeZone)
    return invalid("timeZone");
  return out;
}
export function parseBillingWorkload(value: unknown): BillingWorkload {
  const r = record(value, "workload");
  const out: BillingWorkload = { meters: meterValues(r.meters, "meters") };
  if (r.time !== undefined) out.time = time(r.time, "time");
  if (r.quality !== undefined) out.quality = word(r.quality, "quality");
  if (r.region !== undefined) out.region = word(r.region, "region");
  if (r.remaining !== undefined) out.remaining = meterValues(r.remaining, "remaining");
  if (r.usageBefore !== undefined) out.usageBefore = meterValues(r.usageBefore, "usageBefore");
  if (r.items !== undefined)
    out.items = Object.fromEntries(
      Object.entries(record(r.items, "items")).map(([k, v]) => [
        word(k, "items"),
        list(v, "items").map((n) => quantity(n, "items")),
      ]),
    );
  if (r.calendars !== undefined)
    out.calendars = Object.fromEntries(
      Object.entries(record(r.calendars, "calendars")).map(([ref, years]) => [
        word(ref, "calendar"),
        Object.fromEntries(
          Object.entries(record(years, "years")).map(([year, dates]) => {
            if (!/^\d{4}$/.test(year)) return invalid("year");
            return [
              year,
              list(dates, "dates").map((d) => {
                if (
                  typeof d !== "string" ||
                  !/^\d{4}-\d\d-\d\d$/.test(d) ||
                  !d.startsWith(year + "-")
                )
                  return invalid("date");
                return d;
              }),
            ];
          }),
        ),
      ]),
    );
  return out;
}
function parseReset(value: unknown): { period: "account-billing-month"; timeZone: string } {
  const r = record(value, "reset");
  if (r.period !== "account-billing-month") return invalid("reset.period");
  const timeZone = word(r.timeZone, "reset.timeZone");
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    return invalid("reset.timeZone");
  }
  return { period: r.period, timeZone };
}
export function parseRateCard(value: unknown): RateCard {
  const r = record(value, "rateCard");
  const chargeLines = list(r.chargeLines, "chargeLines").map((entry): ChargeLine => {
    const l = record(entry, "line"),
      per = record(l.per, "per");
    const line: ChargeLine = {
      lineId: word(l.lineId, "lineId"),
      meter: word(l.meter, "meter"),
      per: { quantity: quantity(per.quantity, "per.quantity", true), unit: word(per.unit, "unit") },
      amount: amount(l.amount),
    };
    if (l.rounding !== undefined) {
      const rule = record(l.rounding, "rounding");
      if (rule.scope !== undefined && rule.scope !== "total" && rule.scope !== "per-item")
        return invalid("rounding.scope");
      if (rule.mode !== "exact" && rule.mode !== "ceil") return invalid("rounding.mode");
      line.rounding = {
        mode: rule.mode,
        ...(rule.scope === "per-item" ? { scope: "per-item" as const } : {}),
        ...(rule.step === undefined ? {} : { step: quantity(rule.step, "step", true) }),
      };
    }
    return line;
  });
  const ids = chargeLines.map((x) => x.lineId);
  unique(ids, "lineId");
  const overrides = list(r.overrides ?? [], "overrides").map((entry): RateRule => {
    const rule = record(entry, "rule"),
      ruleId = word(rule.ruleId, "ruleId");
    if (rule.mode === "replace") {
      const sets = Object.entries(record(rule.setAmounts, "setAmounts"));
      if (!sets.length || sets.some(([id]) => !ids.includes(id))) return invalid("setAmounts");
      return {
        ruleId,
        mode: "replace",
        when: parseCondition(rule.when),
        setAmounts: Object.fromEntries(sets.map(([k, v]) => [k, amount(v)])),
      };
    }
    if (rule.mode !== "graduated") return invalid("rule.mode");
    const lineId = word(rule.lineId, "lineId");
    if (!ids.includes(lineId)) return invalid("lineId");
    const bands = list(rule.bands, "bands").map((entry) => {
      const b = record(entry, "band");
      return {
        upToInclusive:
          b.upToInclusive === null ? null : quantity(b.upToInclusive, "upToInclusive", true),
        amount: amount(b.amount),
      };
    });
    if (
      !bands.length ||
      bands.at(-1)?.upToInclusive !== null ||
      bands
        .slice(0, -1)
        .some(
          (b, i) =>
            b.upToInclusive === null || (i > 0 && b.upToInclusive <= bands[i - 1].upToInclusive!),
        )
    )
      return invalid("bands");
    return {
      ruleId,
      mode: "graduated",
      lineId,
      bands,
      ...(rule.applyTo === "accountBillingCycle"
        ? { applyTo: "accountBillingCycle" as const }
        : {}),
    };
  });
  unique(
    overrides.map((r) => r.ruleId),
    "ruleId",
  );
  unique(
    overrides.flatMap((r) => (r.mode === "graduated" ? [r.lineId] : [])),
    "graduated.lineId",
  );
  const entitlements = list(r.entitlements ?? [], "entitlements").map((entry) => {
    const e = record(entry, "entitlement"),
      inc = record(e.included, "included");
    if (e.overagePolicy !== "block" && e.overagePolicy !== "charge")
      return invalid("overagePolicy");
    return {
      meter: word(e.meter, "meter"),
      included: {
        quantity: quantity(inc.quantity, "included.quantity"),
        unit: word(inc.unit, "included.unit"),
      },
      overagePolicy: e.overagePolicy as "block" | "charge",
      ...(e.reset === undefined ? {} : { reset: parseReset(e.reset) }),
    };
  });
  unique(
    entitlements.map((e) => e.meter),
    "entitlements",
  );
  const currency = word(r.currency, "currency");
  if (!/^[A-Z]{3}$/.test(currency)) return invalid("currency");
  const out: RateCard = {
    rateCardId: word(r.rateCardId, "rateCardId"),
    revision: word(r.revision, "revision"),
    currency,
    chargeLines,
    overrides,
    entitlements,
  };
  if (r.effectiveFrom !== undefined) out.effectiveFrom = time(r.effectiveFrom, "effectiveFrom");
  if (r.effectiveUntil != null) out.effectiveUntil = time(r.effectiveUntil, "effectiveUntil");
  if (
    out.effectiveFrom &&
    out.effectiveUntil &&
    Date.parse(out.effectiveUntil) <= Date.parse(out.effectiveFrom)
  )
    return invalid("effectiveUntil");
  if (typeof r.source === "string") out.source = word(r.source, "source", 2048);
  else if (r.source !== undefined) {
    const source = record(r.source, "source");
    out.source = { kind: word(source.kind, "source.kind") };
    if (source.referenceUrl !== undefined)
      out.source.referenceUrl = word(source.referenceUrl, "source.referenceUrl", 2048);
    if (source.checkedAt !== undefined)
      out.source.checkedAt = word(source.checkedAt, "source.checkedAt");
  }
  if (r.scope !== undefined) {
    const scope = record(r.scope, "scope");
    out.scope = {
      providerId: word(scope.providerId, "scope.providerId"),
      offeringId: word(scope.offeringId, "scope.offeringId"),
      operation: word(scope.operation, "scope.operation"),
    };
    if (scope.access !== undefined) {
      if (scope.access !== "api" && scope.access !== "subscription") return invalid("scope.access");
      out.scope.access = scope.access;
    }
    for (const key of ["planKey", "region", "protocol", "upstreamModelId"] as const)
      if (scope[key] !== undefined) out.scope[key] = word(scope[key], "scope." + key);
  }
  if (r.subscriptionFee !== undefined) {
    const fee = record(r.subscriptionFee, "subscriptionFee"),
      cost = amount(fee.amount);
    if (!cost || (fee.period !== "month" && fee.period !== "year"))
      return invalid("subscriptionFee");
    out.subscriptionFee = { amount: cost, period: fee.period };
  }
  return out;
}

function matches(c: RateCondition, w: BillingWorkload): boolean | string {
  let missing = "";
  if (c.meter) {
    const value = w.meters[c.meter];
    if (value === undefined) missing = c.meter;
    else if (
      (c.above !== undefined && value <= c.above) ||
      (c.atLeast !== undefined && value < c.atLeast)
    )
      return false;
  }
  for (const key of ["region", "quality"] as const) {
    if (!c[key]) continue;
    if (w[key] === undefined) missing = key;
    else if (w[key] !== c[key]) return false;
  }
  if (!c.timeZone) return missing || true;
  if (!w.time) return "time";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: c.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(new Date(w.time))
      .map((p) => [p.type, p.value]),
  );
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  if (c.weekdays && !c.weekdays.includes(day)) return false;
  const clock = parts.hour + ":" + parts.minute;
  if (
    c.windows &&
    !c.windows.some(([a, b]) => (a < b ? clock >= a && clock < b : clock >= a || clock < b))
  )
    return false;
  if (c.excludeCalendarRef) {
    const calendar = w.calendars?.[c.excludeCalendarRef]?.[parts.year];
    if (!calendar) return "calendar:" + c.excludeCalendarRef + "/" + parts.year;
    if (calendar.includes([parts.year, parts.month, parts.day].join("-"))) return false;
  }
  return missing || true;
}

/** Uses the same immutable quote for editor previews and reported call usage. */
export function estimateCharge(card: RateCard, input: BillingWorkload): BillingEstimate {
  card = parseRateCard(card);
  const w = parseBillingWorkload(input),
    meters = w.meters;
  if (meters.promptTotalTokens === undefined && meters.inputTokens !== undefined)
    meters.promptTotalTokens = meters.inputTokens;
  if (meters.inputTokens !== undefined && meters.uncachedInputTokens === undefined) {
    const cacheMeters = ["cachedInputTokens", "cacheWriteTokens"];
    const missingSplit = cacheMeters.some(
      (meter) =>
        card.chargeLines.some((line) => line.meter === meter) && meters[meter] === undefined,
    );
    const used = (meters.cachedInputTokens ?? 0) + (meters.cacheWriteTokens ?? 0);
    if (!missingSplit && used <= meters.inputTokens)
      meters.uncachedInputTokens = meters.inputTokens - used;
  }
  if (
    meters.outputTokens !== undefined &&
    meters.nonReasoningOutputTokens === undefined &&
    (meters.reasoningTokens ?? 0) <= meters.outputTokens
  )
    meters.nonReasoningOutputTokens = meters.outputTokens - (meters.reasoningTokens ?? 0);
  let total = new Money(0),
    covered = false,
    blocked = false;
  const missing = new Set<string>(),
    lines: BillingEstimate["lines"] = [];
  let effective = true;
  if (card.effectiveFrom || card.effectiveUntil) {
    const at = w.time ? Date.parse(w.time) : NaN;
    effective =
      Number.isFinite(at) &&
      (!card.effectiveFrom || at >= Date.parse(card.effectiveFrom)) &&
      (!card.effectiveUntil || at < Date.parse(card.effectiveUntil));
    if (!effective) missing.add(w.time ? "价卡有效期" : "time");
  }
  if (card.scope?.region && w.region !== card.scope.region) {
    effective = false;
    missing.add(w.region ? "价卡不适用于该地区" : "region");
  }
  const excluded = new Set<string>();
  for (const e of card.entitlements) {
    const count = meters[e.meter],
      remaining = w.remaining?.[e.meter];
    if (count === undefined || remaining === undefined) {
      missing.add(count === undefined ? e.meter : "remaining:" + e.meter);
      excluded.add(e.meter);
      continue;
    }
    if (count <= remaining) {
      covered = true;
      meters[e.meter] = 0;
    } else if (e.overagePolicy === "block") {
      blocked = true;
      excluded.add(e.meter);
    } else {
      meters[e.meter] = count - remaining;
      if (!card.chargeLines.some((l) => l.meter === e.meter)) missing.add("overage:" + e.meter);
    }
  }
  for (const l of card.chargeLines) {
    const items = w.items?.[l.meter];
    const count = meters[l.meter] ?? (items ? items.reduce((sum, n) => sum + n, 0) : undefined);
    let rate = l.amount,
      bandRule: Extract<RateRule, { mode: "graduated" }> | undefined,
      unknownRule = "";
    const rules: string[] = [];
    for (const rule of card.overrides) {
      if (rule.mode === "graduated") {
        if (rule.lineId === l.lineId) {
          bandRule = rule;
          rules.push(rule.ruleId);
          unknownRule = "";
        }
        continue;
      }
      if (!Object.hasOwn(rule.setAmounts, l.lineId)) continue;
      const hit = matches(rule.when, w);
      if (hit === true) {
        rate = rule.setAmounts[l.lineId];
        bandRule = undefined;
        unknownRule = "";
        rules.push(rule.ruleId);
      } else if (typeof hit === "string") unknownRule = hit;
    }
    const result: BillingEstimate["lines"][number] = {
      lineId: l.lineId,
      meter: l.meter,
      quantity: count ?? null,
      rate: bandRule ? null : rate,
      amount: null,
      rules,
    };
    lines.push(result);
    if (!effective || excluded.has(l.meter)) continue;
    if (count === undefined || unknownRule) {
      missing.add(unknownRule || l.meter);
      continue;
    }
    const step = l.rounding?.step ?? 1;
    let q =
      l.rounding?.mode === "ceil"
        ? new Money(count).div(step).ceil().times(step)
        : new Money(count);
    if (l.rounding?.mode === "ceil" && l.rounding.scope === "per-item") {
      if (!items) {
        missing.add("items:" + l.meter);
        continue;
      }
      if (!new Money(count).eq(items.reduce((sum, n) => sum.plus(n), new Money(0)))) {
        missing.add("items:" + l.meter);
        continue;
      }
      q = items.reduce(
        (sum, n) => sum.plus(new Money(n).div(step).ceil().times(step)),
        new Money(0),
      );
    }
    let cost = new Money(0);
    if (bandRule) {
      const start = bandRule.applyTo === "accountBillingCycle" ? w.usageBefore?.[l.meter] : 0;
      if (start === undefined) {
        missing.add("usageBefore:" + l.meter);
        continue;
      }
      const end = q.plus(start);
      let lower = 0,
        known = true;
      for (const band of bandRule.bands) {
        const upper = band.upToInclusive === null ? end : Money.min(band.upToInclusive, end);
        const units = upper.minus(Money.max(start, lower));
        if (units.gt(0)) {
          if (band.amount === null) {
            known = false;
            break;
          }
          cost = cost.plus(units.times(band.amount).div(l.per.quantity));
        }
        if (band.upToInclusive === null || upper.gte(end)) break;
        lower = band.upToInclusive;
      }
      if (!known) {
        missing.add("rate:" + l.lineId);
        continue;
      }
    } else {
      if (rate === null && !q.isZero()) {
        missing.add("rate:" + l.lineId);
        continue;
      }
      cost = q.times(rate ?? 0).div(l.per.quantity);
    }
    total = total.plus(cost);
    result.amount = cost.toFixed();
  }
  const known = lines.some((l) => l.amount !== null);
  const status: BillingEstimate["status"] = blocked
    ? "blocked"
    : missing.size
      ? known
        ? "partial"
        : "unknown"
      : covered && total.isZero()
        ? "included"
        : known
          ? "estimated"
          : "unknown";
  return {
    currency: card.currency,
    subtotal: total.toFixed(),
    status,
    lines,
    missing: [...missing],
  };
}
