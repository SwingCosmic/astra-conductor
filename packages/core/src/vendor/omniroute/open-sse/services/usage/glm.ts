import { buildGlmQuotaFetch, getGlmTeamQuotaConfig } from "../../config/glmProvider.ts";
import { fetchGlmResetCardList } from "./glmResetCards.ts";
import { type UsageQuota } from "./quota.ts";
import { toNumber, toPercentage, toRecord, toTitleCase } from "./scalars.ts";

type JsonRecord = Record<string, unknown>;

function quotaName(limit: JsonRecord, quotas: Record<string, UsageQuota>): string {
  const unit = toNumber(limit.unit, 0);
  const number = toNumber(limit.number, 0);
  if (unit === 3 && number === 5) return "session";
  if (unit === 6 && number === 1) return "weekly";
  if ((unit === 4 && number === 7) || (unit === 3 && number >= 168)) return "weekly";
  return quotas.session ? "weekly" : "session";
}

function quotaDisplayName(key: string): string {
  if (key === "session") return "5 Hours Quota";
  if (key === "weekly") return "Weekly Quota";
  return key;
}

function orderedQuotas(quotas: Record<string, UsageQuota>): Record<string, UsageQuota> {
  const result: Record<string, UsageQuota> = {};
  for (const key of ["session", "weekly", "mcp_monthly"]) {
    if (quotas[key]) result[key] = quotas[key];
  }
  for (const [key, quota] of Object.entries(quotas)) {
    if (!result[key]) result[key] = quota;
  }
  return result;
}

export async function getGlmUsage(
  apiKey: string,
  providerSpecificData: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
) {
  if (!apiKey) return { message: "API key not available." };
  const team = getGlmTeamQuotaConfig(providerSpecificData);
  if (team.state === "incomplete") {
    return { message: `GLM team plan quota is missing ${team.missing}.` };
  }
  const { url, headers } = buildGlmQuotaFetch(apiKey, providerSpecificData);
  const response = await fetchImpl(url, { method: "GET", headers });
  if (response.status === 401 || response.status === 403) return { message: "Invalid API key" };
  if (!response.ok) throw new Error(`GLM quota API error (${response.status})`);
  const payload: unknown = await response.json();
  const root = toRecord(payload);
  if (toNumber(root.code, 200) === 401) return { message: "Invalid API key" };
  if (root.success === false) {
    const message = root.msg ?? root.message;
    return { message: typeof message === "string" && message.trim() ? message.trim() : "Unable to fetch GLM quota." };
  }
  const data = toRecord(root.data);
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const quotas: Record<string, UsageQuota> = {};
  for (const value of limits) {
    const limit = toRecord(value);
    const type = String(limit.type ?? "").toUpperCase();
    const resetMs = toNumber(limit.nextResetTime, 0);
    const resetAt = resetMs > 0 ? new Date(resetMs).toISOString() : null;
    if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") {
      const key = quotaName(limit, quotas);
      const usedPercentage = toPercentage(limit.percentage);
      const totalCredits = toNumber(limit.usage, 0);
      const total = totalCredits > 0 ? totalCredits : 100;
      const used = totalCredits > 0 ? toNumber(limit.currentValue, usedPercentage) : usedPercentage;
      const remaining = totalCredits > 0
        ? toNumber(limit.remaining, Math.max(0, total - used))
        : Math.max(0, 100 - usedPercentage);
      quotas[key] = {
        used,
        total,
        remaining,
        remainingPercentage: Math.max(0, 100 - usedPercentage),
        resetAt,
        unlimited: false,
        displayName: quotaDisplayName(key),
      };
    } else if (type === "TIME_LIMIT") {
      const total = toNumber(limit.usage, toNumber(limit.total, 0));
      const remaining = toNumber(limit.remaining, Math.max(0, 100 - toPercentage(limit.percentage)));
      const used = toNumber(limit.currentValue, Math.max(0, total - remaining));
      quotas.mcp_monthly = {
        used,
        total,
        remaining,
        remainingPercentage:
          total > 0
            ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100)))
            : Math.max(0, Math.min(100, Math.round(remaining))),
        resetAt,
        unlimited: false,
        displayName: "Monthly",
      };
    }
  }
  const rawPlan =
    typeof data.planName === "string"
      ? data.planName
      : typeof data.level === "string"
        ? data.level
        : "unknown";
  const result = orderedQuotas(quotas);
  const resetCards =
    result.session || result.weekly
      ? await fetchGlmResetCardList(apiKey, providerSpecificData, fetchImpl)
      : { cards: [], availableCount: 0 };
  return {
    plan: toTitleCase(rawPlan.replace(/\s*plan$/i, "")),
    quotas: result,
    ...(resetCards ? { resetCards } : {}),
  };
}
