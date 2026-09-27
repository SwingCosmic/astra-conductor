import { ANTIGRAVITY_RUNTIME_BASE_URLS } from "../../config/antigravityUpstream.ts";
import {
  getAntigravityContentHeaders,
  getAntigravityLoadCodeAssistMetadata,
} from "../antigravityHeaders.ts";
import { extractCodeAssistSubscriptionTier } from "../codeAssistSubscription.ts";
import { ANTIGRAVITY_CONFIG } from "@omniroute/src/lib/oauth/constants/stage7.ts";

interface AntigravityQuota {
  key: string;
  displayName: string | null;
  windowSeconds: number | null;
  used: number;
  total: number;
  remaining: number | null;
  remainingPercentage: number | null;
  resetAt: string | null;
  unlimited: boolean;
}

export interface AntigravityQuotaGroup {
  key: string;
  displayName: string;
  quotas: AntigravityQuota[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "quota"
  );
}

function resetTime(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const seconds = record(value).seconds;
  const numeric = typeof seconds === "string" ? Number(seconds) : seconds;
  return typeof numeric === "number" && Number.isFinite(numeric)
    ? new Date(numeric * 1000).toISOString()
    : null;
}

function windowSeconds(label: string): number | null {
  if (/weekly/i.test(label)) return 604_800;
  if (/5\s*[- ]?hour|five\s*[- ]?hour/i.test(label)) return 18_000;
  return null;
}

function quota(bucketValue: unknown, index: number): AntigravityQuota | null {
  const bucket = record(bucketValue);
  if (bucket.disabled === true) return null;
  const displayName = text(bucket.displayName);
  const keySource = text(bucket.bucketId) ?? displayName ?? `quota_${index + 1}`;
  const rawFraction = bucket.remainingFraction;
  const fraction =
    typeof rawFraction === "number" && Number.isFinite(rawFraction)
      ? Math.max(0, Math.min(1, rawFraction))
      : null;
  const resetAt = resetTime(bucket.resetTime);
  const unlimited = fraction !== null && fraction >= 1 && !resetAt;
  const total = fraction === null || unlimited ? 0 : 1000;
  const remaining = fraction === null ? null : unlimited ? 0 : Math.round(total * fraction);
  return {
    key: slug(keySource),
    displayName,
    windowSeconds: windowSeconds(`${keySource} ${displayName ?? ""}`),
    used: remaining === null || unlimited ? 0 : total - remaining,
    total,
    remaining,
    remainingPercentage: fraction === null ? null : fraction * 100,
    resetAt,
    unlimited,
  };
}

export function parseAntigravityQuotaGroups(value: unknown): AntigravityQuotaGroup[] {
  const root = record(value);
  const groups = Array.isArray(root.groups)
    ? root.groups
    : Array.isArray(record(root.quotaSummary).groups)
      ? (record(root.quotaSummary).groups as unknown[])
      : [];
  return groups.flatMap((groupValue, groupIndex) => {
    const group = record(groupValue);
    const displayName = text(group.displayName);
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    const quotas = buckets.flatMap((value, index) => {
      const parsed = quota(value, index);
      return parsed ? [parsed] : [];
    });
    return displayName && quotas.length
      ? [{ key: slug(displayName) || `group_${groupIndex + 1}`, displayName, quotas }]
      : [];
  });
}

function planLabel(subscription: unknown, fallbackTier: string | null): string {
  const source = extractCodeAssistSubscriptionTier(subscription) ?? fallbackTier ?? "Free";
  const upper = source.toUpperCase();
  if (upper.includes("ULTRA")) return "Ultra";
  if (upper.includes("PRO") || upper.includes("PREMIUM") || upper.includes("GOOGLE ONE")) {
    return "Pro";
  }
  if (upper.includes("ENTERPRISE")) return "Enterprise";
  if (upper.includes("STANDARD") || upper.includes("BUSINESS")) return "Business";
  if (upper.includes("PLUS")) return "Plus";
  if (upper.includes("LITE")) return "Lite";
  if (upper.includes("INDIVIDUAL") || upper.includes("FREE") || upper.includes("LEGACY")) {
    return "Free";
  }
  return source.replace(/\s*\(Restricted\)\s*$/i, "").trim();
}

async function subscriptionInfo(accessToken: string, fetchImpl: typeof fetch): Promise<unknown> {
  for (const url of ANTIGRAVITY_CONFIG.loadCodeAssistEndpoints) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: getAntigravityContentHeaders(accessToken),
        body: JSON.stringify({ metadata: getAntigravityLoadCodeAssistMetadata() }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return response.json();
    } catch {
      // Try the next configured endpoint.
    }
  }
  return null;
}

async function quotaSummary(
  accessToken: string,
  projectId: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  for (const baseUrl of ANTIGRAVITY_RUNTIME_BASE_URLS) {
    try {
      const response = await fetchImpl(`${baseUrl}/v1internal:retrieveUserQuotaSummary`, {
        method: "POST",
        headers: getAntigravityContentHeaders(accessToken),
        body: JSON.stringify({ project: projectId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return response.json();
    } catch {
      // Try the fallback runtime endpoint.
    }
  }
  return null;
}

export async function getAntigravityUsage(
  accessToken: string | undefined,
  projectId: string | undefined,
  fallbackTier: string | null,
  fetchImpl: typeof fetch = fetch,
) {
  if (!accessToken) return { message: "Antigravity access token is not available" } as const;
  if (!projectId) return { message: "Antigravity Cloud Code project is not available" } as const;
  const [subscription, summary] = await Promise.all([
    subscriptionInfo(accessToken, fetchImpl),
    quotaSummary(accessToken, projectId, fetchImpl),
  ]);
  const groups = parseAntigravityQuotaGroups(summary);
  if (!groups.length) {
    return {
      plan: planLabel(subscription, fallbackTier),
      message: "Antigravity quota summary is unavailable",
    } as const;
  }
  return { plan: planLabel(subscription, fallbackTier), groups } as const;
}
