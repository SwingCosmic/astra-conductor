import {
  ANTIGRAVITY_RUNTIME_BASE_URLS,
  getAntigravityFetchAvailableModelsUrls,
} from "../../config/antigravityUpstream.ts";
import {
  getAntigravityContentHeaders,
  getAntigravityLoadCodeAssistMetadata,
} from "../antigravityHeaders.ts";
import {
  getClientVisibleAntigravityModelName,
  isUserVisibleAntigravityQuotaModelId,
  toClientAntigravityQuotaModelId,
} from "../../config/antigravityModelAliases.ts";
import { extractCodeAssistSubscriptionTier } from "../codeAssistSubscription.ts";
import { ANTIGRAVITY_CONFIG } from "@omniroute/src/lib/oauth/constants/oauth.ts";

interface AntigravityQuota {
  key: string;
  displayName: string | null;
  /** 上游原始模型/桶标识（改版前的旧 id 也保留原文），供 UI 核对改名漂移。 */
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

/** 按模型原始额度的模型族键：gemini 独立成族，其余（claude/gpt 等）归一族。 */
export type AntigravityModelFamily = "gemini" | "other";

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

// [astra] deviation from upstream: the per-model quota assembly mirrors upstream
// `getAntigravityUsage` (fetchAvailableModels catalog view + retrieveUserQuota live
// buckets, live preferred over catalog) but the host-specific parts are dropped —
// no local-usage-history fallback, no credit-balance probe (it spends credits), no
// module-level caches (the host refresh cycle owns cadence). Model display names
// resolve live-first — the fetchAvailableModels entry's own displayName/name beats
// the ported static catalog (Google renames model families and re-points old
// marketing names at new engine ids, e.g. "Gemini 3.1 Flash Lite" served by
// `gemini-3.8-flash-tiered`, faster than any vendored catalog snapshot can track);
// the static catalog only fills models the live view names by bare id. The raw
// upstream bucket id rides along as `detail` so a drifted name is always checkable.
/** 模型族聚合桶（summary）没有模型 id，detail 恒空。 */
function modelQuota(
  modelId: string,
  bucketValue: unknown,
  detailId: string | null,
  liveName: string | null,
): AntigravityQuota | null {
  const bucket = record(bucketValue);
  const rawFraction = bucket.remainingFraction;
  const fraction =
    typeof rawFraction === "number" && Number.isFinite(rawFraction)
      ? Math.max(0, Math.min(1, rawFraction))
      : null;
  if (fraction === null) return null;
  const resetAt = resetTime(bucket.resetTime);
  const unlimited = fraction >= 1 && !resetAt;
  const total = unlimited ? 0 : 1000;
  const remaining = unlimited ? 0 : Math.round(total * fraction);
  return {
    key: slug(modelId),
    displayName: liveName ?? getClientVisibleAntigravityModelName(modelId),
    ...(detailId ? { detail: detailId } : {}),
    windowSeconds: 18_000,
    used: unlimited ? 0 : total - remaining,
    total,
    remaining,
    remainingPercentage: fraction * 100,
    resetAt,
    unlimited,
  };
}

/** live 目录条目自带的展示名：displayName 优先，name 与 id 相同时不算真名。 */
function liveModelName(info: Record<string, unknown>, rawKey: string): string | null {
  const displayName = text(info.displayName);
  if (displayName) return displayName;
  const name = text(info.name);
  return name && name !== rawKey ? name : null;
}

/**
 * 按模型原始额度（5 小时窗口），按模型族（gemini / 其余）分桶返回。
 * 第一遍扫 fetchAvailableModels 的目录视图（跳过 internal、无 quotaInfo、
 * 不可见模型），顺带收集条目自带展示名；实时桶（retrieveUserQuota）优先
 * 覆盖目录刻度并带上桶的原始 modelId；第二遍收目录外新增模型的实时桶——
 * 名字退回静态目录，再退回原始 id。未上报 remainingFraction 的桶不展示。
 */
export function parseAntigravityModelQuotas(
  modelsData: unknown,
  userQuotaData: unknown,
): Map<AntigravityModelFamily, AntigravityQuota[]> {
  const families = new Map<AntigravityModelFamily, AntigravityQuota[]>();
  const liveBuckets = new Map<string, { bucket: unknown; rawId: string }>();
  const userQuotaBuckets = record(userQuotaData).buckets;
  if (Array.isArray(userQuotaBuckets)) {
    for (const bucketValue of userQuotaBuckets) {
      const rawId = String(record(bucketValue).modelId ?? "").trim();
      const modelId = toClientAntigravityQuotaModelId(rawId);
      if (modelId) liveBuckets.set(modelId, { bucket: bucketValue, rawId });
    }
  }
  const liveNames = new Map<string, string>();
  const push = (
    modelId: string,
    bucketValue: unknown,
    detailId: string | null,
    liveName: string | null,
  ): void => {
    const parsed = modelQuota(modelId, bucketValue, detailId, liveName);
    if (!parsed) return;
    const family: AntigravityModelFamily = modelId.startsWith("gemini") ? "gemini" : "other";
    const list = families.get(family) ?? [];
    list.push(parsed);
    families.set(family, list);
  };

  const seen = new Set<string>();
  for (const [rawModelKey, infoValue] of Object.entries(record(record(modelsData).models))) {
    const info = record(infoValue);
    if (info.isInternal === true) continue;
    const modelKey = toClientAntigravityQuotaModelId(rawModelKey);
    if (!modelKey || !isUserVisibleAntigravityQuotaModelId(modelKey)) continue;
    const quotaInfo = record(info.quotaInfo);
    if (!Object.keys(quotaInfo).length) continue;
    const name = liveModelName(info, rawModelKey);
    if (name) liveNames.set(modelKey, name);
    seen.add(modelKey);
    const live = liveBuckets.get(modelKey);
    push(modelKey, live?.bucket ?? quotaInfo, live?.rawId ?? rawModelKey, name);
  }
  for (const [modelKey, { bucket, rawId }] of liveBuckets) {
    if (seen.has(modelKey) || !isUserVisibleAntigravityQuotaModelId(modelKey)) continue;
    push(modelKey, bucket, rawId, liveNames.get(modelKey) ?? null);
  }
  return families;
}

/** summary 组名 → 模型族：组名含 gemini 归 gemini 族，其余归 claude/gpt 族。 */
function familyOfGroupName(displayName: string): AntigravityModelFamily {
  return /gemini/i.test(displayName) ? "gemini" : "other";
}

// [astra] deviation from upstream: stop folding tier names into coarse labels
// (ULTRA → "Ultra", PRO/PREMIUM → "Pro", …). The fold collapsed Ultra 5x /
// Ultra 20x into one value and overwrote every keyword-matching tier with a
// synthesized label, so the raw upstream identifier never reached the snapshot.
// The tier name now passes through verbatim as the data-layer identifier; tier
// distinction and display resolution live in the core plan catalog. Only the
// locally synthesized "(Restricted)" marker (added by
// extractCodeAssistSubscriptionTier for ineligible default tiers) is stripped.
function planLabel(subscription: unknown, fallbackTier: string | null): string {
  const source = extractCodeAssistSubscriptionTier(subscription) ?? fallbackTier ?? "Free";
  return source.replace(/\s*\(Restricted\)\s*$/i, "").trim() || "Free";
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
      if (response.ok) return response.json();
    } catch {
      // Try the next configured endpoint.
    }
  }
  return null;
}

async function postFirstOk(
  urls: readonly string[],
  accessToken: string,
  projectId: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: getAntigravityContentHeaders("ide", accessToken),
        body: JSON.stringify({ project: projectId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return response.json();
    } catch {
      // Try the next configured endpoint.
    }
  }
  return null;
}

function quotaSummary(
  accessToken: string,
  projectId: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  return postFirstOk(
    ANTIGRAVITY_RUNTIME_BASE_URLS.map((baseUrl) => `${baseUrl}/v1internal:retrieveUserQuotaSummary`),
    accessToken,
    projectId,
    fetchImpl,
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
    // [astra] deviation: per-model sources (catalog view + live buckets) join the
    // summary family groups so the card shows the raw per-model quotas upstream
    // displays, grouped under their model family ("Gemini Models" /
    // "Claude and GPT models").
    postFirstOk(getAntigravityFetchAvailableModelsUrls(), accessToken, projectId, fetchImpl),
    postFirstOk(
      ANTIGRAVITY_RUNTIME_BASE_URLS.map((baseUrl) => `${baseUrl}/v1internal:retrieveUserQuota`),
      accessToken,
      projectId,
      fetchImpl,
    ),
  ]);
  const modelQuotas = parseAntigravityModelQuotas(models, userQuota);
  const groups: AntigravityQuotaGroup[] = [];
  const coveredFamilies = new Set<AntigravityModelFamily>();
  for (const group of parseAntigravityQuotaGroups(summary)) {
    const family = familyOfGroupName(group.displayName);
    coveredFamilies.add(family);
    const modelList = modelQuotas.get(family) ?? [];
    // 有按模型 5 小时数据时不再重复展示族级 5 小时聚合桶，周配额保留。
    const quotas = modelList.length
      ? [...group.quotas.filter((item) => item.windowSeconds === 604_800), ...modelList]
      : group.quotas;
    if (quotas.length) groups.push({ ...group, quotas });
  }
  for (const family of ["gemini", "other"] as const) {
    if (coveredFamilies.has(family)) continue;
    const modelList = modelQuotas.get(family) ?? [];
    if (!modelList.length) continue;
    groups.push({
      key: family === "gemini" ? "gemini_models" : "claude_gpt_models",
      displayName: family === "gemini" ? "Gemini Models" : "Claude and GPT Models",
      quotas: modelList,
    });
  }
  if (!groups.length) {
    return {
      plan: planLabel(subscription, fallbackTier),
      message: "Antigravity quota summary is unavailable",
    } as const;
  }
  return { plan: planLabel(subscription, fallbackTier), groups } as const;
}
