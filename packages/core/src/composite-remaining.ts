import type { ProviderId } from "./models.js";
import { planMultiplier } from "./providers/catalog.js";

export const SESSION_MAX_SECONDS = 24 * 3600;
export const WEEKLY_MAX_SECONDS = 14 * 24 * 3600;
export const WEEK_TO_SESSION_RATIO = 5;
export const MONTH_TO_WEEK_RATIO = 4;
export const DEFAULT_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
export const MODEL_LIMITS_GROUP_KEY = "model-limits";

export type WindowFamily = "session" | "week" | "month";
export type RemainingBand = "healthy" | "attention" | "critical" | "unknown";
export type CompositeRemainingStatus = "empty" | "complete" | "incomplete";

export interface CompositeRemainingQuota {
  key: string;
  displayName: string | null;
  windowSeconds: number | null;
  remainingPercentage: number | null;
  unlimited: boolean;
}

export interface CompositeRemainingSnapshot {
  plan: string;
  fetchedAt: string;
  groups: readonly {
    key: string;
    quotas: readonly CompositeRemainingQuota[];
  }[];
}

export interface CompositeRemainingAccountInput {
  enabled: boolean;
  provider: ProviderId;
  snapshot: CompositeRemainingSnapshot | null;
}

export interface CompositeRemaining {
  status: CompositeRemainingStatus;
  sessionScore: number | null;
  weeklyScore: number | null;
  remaining: number | null;
  band: RemainingBand;
  sessionBand: RemainingBand;
  weeklyBand: RemainingBand;
  enabledAccountCount: number;
  scoredAccountCount: number;
}

const emptyRemaining = {
  status: "empty",
  sessionScore: null,
  weeklyScore: null,
  remaining: null,
  band: "unknown",
  sessionBand: "unknown",
  weeklyBand: "unknown",
} as const;

export function snapshotFreshnessLimitMs(
  pollingEnabled: boolean,
  pollingIntervalMinutes: number,
): number {
  if (!pollingEnabled) return DEFAULT_SNAPSHOT_TTL_MS;
  if (!Number.isFinite(pollingIntervalMinutes) || pollingIntervalMinutes <= 0) {
    return DEFAULT_SNAPSHOT_TTL_MS;
  }
  return pollingIntervalMinutes * 2 * 60 * 1000;
}

export function remainingBand(score: number | null | undefined): RemainingBand {
  if (typeof score !== "number" || !Number.isFinite(score)) return "unknown";
  if (score > 50) return "healthy";
  if (score > 20) return "attention";
  return "critical";
}

export function inferWindowFamily(quota: CompositeRemainingQuota): WindowFamily | null {
  const seconds = quota.windowSeconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    if (seconds <= SESSION_MAX_SECONDS) return "session";
    if (seconds <= WEEKLY_MAX_SECONDS) return "week";
    return "month";
  }
  const text = normalizeWindowText(`${quota.key} ${quota.displayName ?? ""}`);
  if (!text) return null;
  if (/\bmonth(ly)?\b/.test(text) || /\bmcp monthly\b/.test(text)) return "month";
  if (/\bweek(ly)?\b/.test(text)) return "week";
  if (/\bsession\b/.test(text) || /\bfive hour\b/.test(text) || /\b5 ?h(our)?s?\b/.test(text)) {
    return "session";
  }
  return null;
}

/** Pure derivation of R from current enabled-account usage. No I/O, clock, or stored score. */
export function computeCompositeRemaining(
  accounts: readonly CompositeRemainingAccountInput[],
): CompositeRemaining {
  const enabled = accounts.filter((account) => account.enabled);
  if (!enabled.length) {
    return { ...emptyRemaining, enabledAccountCount: 0, scoredAccountCount: 0 };
  }

  const scored: { weight: number; session: number | null; weekly: number | null }[] = [];
  for (const account of enabled) {
    if (!account.snapshot) continue;
    const rates = accountWindowRates(account.snapshot);
    if (rates.session === null && rates.weekly === null) continue;
    scored.push({
      weight: planMultiplier(account.provider, account.snapshot.plan),
      session: rates.session,
      weekly: rates.weekly,
    });
  }

  const sessionScore = clampScore(weightedScore(scored, "session"));
  const weeklyScore = clampScore(weightedScore(scored, "weekly"));
  const remaining =
    sessionScore !== null && weeklyScore !== null
      ? clampScore(Math.min(sessionScore, weeklyScore))
      : (sessionScore ?? weeklyScore);
  const complete =
    scored.length === enabled.length && sessionScore !== null && weeklyScore !== null;
  return {
    status: complete ? "complete" : "incomplete",
    sessionScore,
    weeklyScore,
    remaining,
    band: remainingBand(remaining),
    sessionBand: remainingBand(sessionScore),
    weeklyBand: remainingBand(weeklyScore),
    enabledAccountCount: enabled.length,
    scoredAccountCount: scored.length,
  };
}

function weightedScore(
  scored: readonly { weight: number; session: number | null; weekly: number | null }[],
  family: "session" | "weekly",
): number | null {
  const parts = scored.flatMap((item) => {
    const ratio = item[family];
    if (ratio === null || item.weight <= 0) return [];
    return [{ weight: item.weight, ratio }];
  });
  const totalWeight = parts.reduce((sum, item) => sum + item.weight, 0);
  if (!parts.length || totalWeight <= 0) return null;
  return parts.reduce((sum, item) => sum + item.ratio * 100 * (item.weight / totalWeight), 0);
}

function accountWindowRates(snapshot: CompositeRemainingSnapshot): {
  session: number | null;
  weekly: number | null;
} {
  const quotas = snapshot.groups
    .filter((group) => group.key !== MODEL_LIMITS_GROUP_KEY)
    .flatMap((group) => group.quotas);
  const session = familyState(quotas, "session");
  const week = familyState(quotas, "week");
  const month = familyState(quotas, "month");

  if (session.present && week.present) {
    return { session: session.r, weekly: week.r };
  }
  if (week.present && !session.present) {
    return { session: convertWeekToSession(week.r), weekly: week.r };
  }
  if (session.present && !week.present) {
    return { session: session.r, weekly: 1 };
  }
  if (month.present) {
    if (month.r === null) return { session: null, weekly: null };
    const rawWeekly = month.r * MONTH_TO_WEEK_RATIO;
    return {
      session: Math.min(1, rawWeekly * WEEK_TO_SESSION_RATIO),
      weekly: Math.min(1, rawWeekly),
    };
  }
  return { session: null, weekly: null };
}

function familyState(
  quotas: readonly CompositeRemainingQuota[],
  family: WindowFamily,
): { present: boolean; r: number | null } {
  const members = quotas.filter((quota) => inferWindowFamily(quota) === family);
  if (!members.length) return { present: false, r: null };
  const ratios = members.flatMap((quota) => {
    const ratio = quotaRatio(quota);
    return ratio === null ? [] : [ratio];
  });
  return { present: true, r: ratios.length ? Math.min(...ratios) : null };
}

function quotaRatio(quota: CompositeRemainingQuota): number | null {
  if (quota.unlimited) return 1;
  const percentage = quota.remainingPercentage;
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) return null;
  if (percentage < 0 || percentage > 100) return null;
  return percentage / 100;
}

function clampScore(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function convertWeekToSession(weekly: number | null): number | null {
  if (weekly === null) return null;
  return Math.min(1, weekly * WEEK_TO_SESSION_RATIO);
}

function normalizeWindowText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}
