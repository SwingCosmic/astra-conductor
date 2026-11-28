import type { AntigravityClientProfile } from "@omniroute/src/shared/constants/antigravityClientProfile.ts";
import { ANTIGRAVITY_GENERATION_BASE_URLS } from "../../config/antigravityUpstream.ts";
import {
  getAntigravityContentHeaders,
  getAntigravityLoadCodeAssistMetadata,
} from "../antigravityHeaders.ts";
import {
  resolveAntigravityModelId,
  isUserVisibleAntigravityQuotaModelId,
  toClientAntigravityQuotaModelId,
} from "../../config/antigravityModelAliases.ts";
import { extractCodeAssistSubscriptionTier } from "../codeAssistSubscription.ts";
import { ANTIGRAVITY_CONFIG } from "@omniroute/src/lib/oauth/constants/oauth.ts";

interface AntigravityQuota {
  key: string;
  displayName: string | null;
  /** 汇总窗口缺失时说明替代读数的来源。 */
  detail?: string;
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

const weekly = { bucketId: "weekly", displayName: "Weekly Limit Remaining", window: "weekly" };
const fiveHour = { bucketId: "five_hour", displayName: "Five Hour Limit Remaining", window: "5h" };
const otherModels = "其它";

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
  const normalized = label.replaceAll("_", " ");
  if (/\b(?:weekly|7d)\b|seven[\s-]*day/i.test(normalized)) return 604_800;
  if (/(?:5|five)[\s-]*(?:hours?|h)\b|\bsession\b/i.test(normalized)) return 18_000;
  return null;
}

function bucketWindow(bucket: Record<string, unknown>): number | null {
  return (
    windowSeconds(text(bucket.window) ?? "") ??
    windowSeconds([text(bucket.bucketId), text(bucket.displayName)].join(" "))
  );
}

function quota(bucket: Record<string, unknown>): AntigravityQuota {
  const displayName = text(bucket.displayName);
  const keySource = text(bucket.bucketId) ?? displayName ?? "quota";
  // OmniRoute PR #13739: retrieveUserQuotaSummary may nest remainingFraction/resetTime
  // under `bucket.remaining`, unlike retrieveUserQuota's flat bucket shape. Accept both.
  const remainingData = record(bucket.remaining);
  const rawFraction = remainingData.remainingFraction ?? bucket.remainingFraction;
  const fraction =
    typeof rawFraction === "number" && Number.isFinite(rawFraction)
      ? Math.max(0, Math.min(1, rawFraction))
      : null;
  const resetAt = resetTime(remainingData.resetTime ?? bucket.resetTime);
  const total = fraction === null ? 0 : 1000;
  const remaining = fraction === null ? null : Math.round(total * fraction);
  return {
    key: slug(keySource),
    displayName,
    windowSeconds: bucketWindow(bucket),
    used: remaining === null ? 0 : total - remaining,
    total,
    remaining,
    remainingPercentage: fraction === null ? null : fraction * 100,
    resetAt,
    unlimited: false,
  };
}

function isArgonGroupName(value: string): boolean {
  return /\bargon\b/i.test(value);
}

function familyName(value: string): string | null {
  if (/^gemini(?:$|[-_ ])/i.test(value)) return "Gemini Models";
  if (/^(?:claude|gpt)(?:$|[-_ ])/i.test(value)) return "Claude and GPT models";
  return null;
}

function modelMembership(groups: Record<string, unknown>[]): Map<string, string> {
  const membership = new Map<string, string>();
  for (const group of groups) {
    const name = text(group.displayName);
    if (!name) continue;
    const ids = Array.isArray(group.modelIds) ? group.modelIds : [];
    const description = text(group.description)?.match(/^Models within this group:\s*(.*)$/i);
    for (const member of [...ids, ...(description?.[1]?.split(",") ?? [])]) {
      const label = text(member);
      if (label) membership.set(label.toLowerCase(), name);
    }
  }
  return membership;
}

// [astra] Use the live bucket before its catalog reading. An opaque id alone
// does not establish a model family, a completion surface, or a quota window.
function modelMinima(modelsData: unknown, userQuotaData: unknown, membership: Map<string, string>) {
  const catalog = record(record(modelsData).models);
  const buckets = new Map<string, Record<string, unknown>>();
  for (const [id, model] of Object.entries(catalog))
    buckets.set(id, record(record(model).quotaInfo));
  const live = record(userQuotaData).buckets;
  if (Array.isArray(live)) {
    for (const value of live) {
      const bucket = record(value);
      const id = text(bucket.modelId);
      if (id && typeof bucket.remainingFraction === "number") buckets.set(id, bucket);
    }
  }
  const minima = new Map<string, AntigravityQuota>();
  for (const [rawId, bucket] of buckets) {
    const id = toClientAntigravityQuotaModelId(rawId);
    const info = record(catalog[rawId]);
    if (
      !id ||
      info.isInternal === true ||
      bucket.disabled === true ||
      !isUserVisibleAntigravityQuotaModelId(id)
    )
      continue;
    const label = text(info.displayName) ?? text(info.name) ?? "";
    const family =
      membership.get(rawId.toLowerCase()) ??
      membership.get(label.toLowerCase()) ??
      familyName(resolveAntigravityModelId(id)) ??
      familyName(label) ??
      otherModels;
    const item = quota({
      ...bucket,
      ...(family === otherModels
        ? { bucketId: "remaining", displayName: "模型最低剩余额度", window: null }
        : fiveHour),
    });
    if (item.remainingPercentage === null) continue;
    if (item.remainingPercentage < (minima.get(family)?.remainingPercentage ?? Infinity))
      minima.set(family, item);
  }
  return minima;
}

// [astra] Keep official weekly/5h windows, including unknown readings.
// Missing family summaries can only be estimated from short-window model data.
export function parseAntigravityQuotaGroups(
  value: unknown,
  models?: unknown,
  userQuota?: unknown,
): AntigravityQuotaGroup[] {
  const root = record(value);
  const rawGroups = root.groups ?? record(root.quotaSummary).groups;
  const summary = Array.isArray(rawGroups) ? rawGroups.map(record) : [];
  const minima = modelMinima(models, userQuota, modelMembership(summary));
  const result: AntigravityQuotaGroup[] = [];
  function append(name: string, buckets: Record<string, unknown>[]) {
    const family = isArgonGroupName(name) ? null : familyName(name);
    if (!family) {
      // Dedicated upstream pools (e.g. Gemini 4 Argon) keep only the buckets upstream reported.
      const quotas = buckets
        .filter((bucket) => bucket.disabled !== true)
        .map((bucket) => quota(bucket));
      if (quotas.length) result.push({ key: slug(name), displayName: name, quotas });
      return;
    }
    const estimate = minima.get(name) ?? minima.get(family);
    minima.delete(name);
    minima.delete(family);
    const quotas = [weekly, fiveHour].flatMap((window) => {
      const bucket = buckets.find((b) => bucketWindow(b) === windowSeconds(window.window));
      if (bucket) return bucket.disabled === true ? [] : [quota({ ...window, ...bucket })];
      if (window === fiveHour && estimate)
        return [{ ...estimate, detail: "按组内模型最低剩余量估算" }];
      return [quota(window)];
    });
    if (quotas.length) result.push({ key: slug(name), displayName: name, quotas });
  }
  for (const group of summary) {
    const name = text(group.displayName);
    if (name && Array.isArray(group.buckets) && group.buckets.length)
      append(name, group.buckets.map(record));
  }
  for (const name of ["Gemini Models", "Claude and GPT models"]) {
    if (minima.has(name)) append(name, []);
  }
  const other = minima.get(otherModels);
  if (other)
    result.push({
      key: "other_models",
      displayName: otherModels,
      quotas: [{ ...other, detail: "上游未提供模型分组或额度周期" }],
    });
  // Keep Gemini Models first even when its windows came from the fallback source.
  return result.sort(
    (a, b) =>
      Number(!isArgonGroupName(b.displayName) && familyName(b.displayName) === "Gemini Models") -
      Number(!isArgonGroupName(a.displayName) && familyName(a.displayName) === "Gemini Models"),
  );
}

// free-tier is also the onboarding tier of paid Pro accounts.
export function antigravitySubscriptionPlan(value: string | null): string | null {
  const plan = value?.replace(/\s*\(Restricted\)\s*$/i, "").trim();
  return plan && !/^(?:antigravity|free-tier|legacy-tier|standard-tier)$/i.test(plan) ? plan : null;
}

async function subscriptionInfo(accessToken: string, fetchImpl: typeof fetch): Promise<unknown> {
  for (const url of ANTIGRAVITY_CONFIG.loadCodeAssistEndpoints) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: getAntigravityContentHeaders("ide", accessToken),
        body: JSON.stringify({ metadata: getAntigravityLoadCodeAssistMetadata() }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return await response.json();
    } catch {
      // Try the next configured endpoint.
    }
  }
  return null;
}

const DAILY_RETRY_DELAY_MS = 150;

function isTransientQuotaStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function postFirstOk(
  urls: readonly string[],
  accessToken: string,
  projectId: string,
  fetchImpl: typeof fetch,
  profile: AntigravityClientProfile = "ide",
): Promise<unknown> {
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: getAntigravityContentHeaders(profile, accessToken),
          body: JSON.stringify({ project: projectId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return await response.json();
        if (attempt === 0 && isTransientQuotaStatus(response.status)) {
          await new Promise((resolve) => setTimeout(resolve, DAILY_RETRY_DELAY_MS));
          continue;
        }
        break;
      } catch {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, DAILY_RETRY_DELAY_MS));
          continue;
        }
      }
    }
  }
  return null;
}

// OmniRoute PR #18026: retrieveUserQuotaSummary uses the `cli` fingerprint so Cloud Code
// returns the full Gemini Models group (and dedicated Argon pools when entitled).
// [astra] Never fall back to prod cloudcode-pa.googleapis.com for Antigravity quota RPCs:
// prod returns HTTP 200 with fake 100% (remainingFraction: 1) and rolling now+window resets.
function quotaSummary(
  accessToken: string,
  projectId: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  return postFirstOk(
    ANTIGRAVITY_GENERATION_BASE_URLS.map(
      (baseUrl) => `${baseUrl}/v1internal:retrieveUserQuotaSummary`,
    ),
    accessToken,
    projectId,
    fetchImpl,
    "cli",
  );
}

export async function getAntigravityUsage(
  accessToken: string | undefined,
  projectId: string | undefined,
  fallbackTier: string | null,
  fetchImpl: typeof fetch = fetch,
) {
  if (!accessToken) return { message: "Antigravity access token is not available" } as const;
  if (!projectId) return { message: "Antigravity Cloud Code project is not available" } as const;
  const [subscription, summary, models, userQuota] = await Promise.all([
    subscriptionInfo(accessToken, fetchImpl),
    quotaSummary(accessToken, projectId, fetchImpl),
    postFirstOk(
      ANTIGRAVITY_GENERATION_BASE_URLS.map(
        (baseUrl) => `${baseUrl}/v1internal:fetchAvailableModels`,
      ),
      accessToken,
      projectId,
      fetchImpl,
    ),
    postFirstOk(
      ANTIGRAVITY_GENERATION_BASE_URLS.map((baseUrl) => `${baseUrl}/v1internal:retrieveUserQuota`),
      accessToken,
      projectId,
      fetchImpl,
    ),
  ]);
  const groups = parseAntigravityQuotaGroups(summary, models, userQuota);
  const paidTierId = text(record(record(subscription).paidTier).id);
  const plan =
    antigravitySubscriptionPlan(extractCodeAssistSubscriptionTier(subscription)) ??
    antigravitySubscriptionPlan(paidTierId) ??
    fallbackTier ??
    "";
  if (!groups.length) {
    return {
      plan,
      message: "Antigravity quota summary is unavailable",
    } as const;
  }
  return { plan, paidTierId, groups } as const;
}
