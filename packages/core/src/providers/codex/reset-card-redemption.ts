import { randomUUID } from "node:crypto";
import { AppError } from "../../errors.js";
import { getCodexBackendIdentityHeaders } from "../../vendor/omniroute/open-sse/config/codexClient.js";

/**
 * Codex "banked reset credits" 兑换（写操作，项目代码，不进 vendor 子集）。
 * 协议移植自上游 OmniRoute 宿主层的 codexResetCredits 模块
 * （commit 3ee283b，issue #5199：用量侧只展示计数，兑换是独立的
 * 非官方变更端点）。上游的连接库、代理上下文、独占锁、缓存失效与用量
 * 回写等宿主关注点在此剔除：令牌与 workspace 由 adapter 提供，兑换后的
 * 用量刷新由应用服务统一执行。
 */

const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_RESET_CREDIT_CONSUME_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const CODEX_RESET_CREDIT_TIMEOUT_MS = 15_000;

export type CodexResetCreditOutcome = "reset" | "alreadyRedeemed";

export interface CodexResetCredit {
  id: string;
  resetType?: string;
  status?: string;
  grantedAt?: string | null;
  expiresAt?: string | null;
  title?: string;
  description?: string;
}

export interface RedeemCodexResetCreditOptions {
  accessToken: string;
  workspaceId?: string;
  /** 可选的指定额度 id；缺省时按上游语义选择最先过期的一张。 */
  creditId?: string;
  fetchImpl?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function normalizeOutcome(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return normalized || null;
}

function extractOutcome(payload: unknown): string | null {
  const direct = normalizeOutcome(payload);
  if (direct) return direct;
  const record = toRecord(payload);
  for (const key of ["code", "outcome", "status", "result", "type"]) {
    const normalized = normalizeOutcome(record[key]);
    if (normalized) return normalized;
  }
  return null;
}

function extractStringField(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function parseOptionalTimestamp(record: JsonRecord, keys: string[]): string | null | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === null) return null;
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function isUnavailableResetCredit(record: JsonRecord): boolean {
  const status = normalizeOutcome(
    record.status ?? record.state ?? record.outcome ?? record.result ?? record.code,
  );
  if (
    status &&
    ["consumed", "redeeming", "redeemed", "used", "expired", "unavailable"].includes(status)
  ) {
    return true;
  }
  return record.consumed === true || record.redeemed === true || record.available === false;
}

function parseResetCredit(value: unknown): CodexResetCredit | null {
  const record = toRecord(value);
  if (!record || Object.keys(record).length === 0 || isUnavailableResetCredit(record)) return null;
  const id = extractStringField(record, ["credit_id", "creditId", "id"]);
  if (!id) return null;
  const expiresAt = parseOptionalTimestamp(record, [
    "expires_at",
    "expiresAt",
    "expiration_at",
    "expirationAt",
  ]);
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) return null;
  }
  const resetType = extractStringField(record, ["reset_type", "resetType"]);
  const status = extractStringField(record, ["status", "state"]);
  const grantedAt = parseOptionalTimestamp(record, ["granted_at", "grantedAt"]);
  const title = extractStringField(record, ["title"]);
  const description = extractStringField(record, ["description"]);
  return {
    id,
    ...(resetType ? { resetType } : {}),
    ...(status ? { status } : {}),
    ...(grantedAt !== undefined ? { grantedAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

function getResetCreditCandidates(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = toRecord(payload);
  for (const key of [
    "credits",
    "reset_credits",
    "resetCredits",
    "rate_limit_reset_credits",
    "rateLimitResetCredits",
    "items",
    "data",
  ]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function expirySortValue(credit: CodexResetCredit): number {
  if (!credit.expiresAt) return Number.POSITIVE_INFINITY;
  const expiresAtMs = Date.parse(credit.expiresAt);
  return Number.isFinite(expiresAtMs) ? expiresAtMs : Number.POSITIVE_INFINITY;
}

function parseAvailableResetCredits(payload: unknown): CodexResetCredit[] {
  return getResetCreditCandidates(payload)
    .map(parseResetCredit)
    .filter((credit): credit is CodexResetCredit => credit !== null)
    .map((credit, index) => ({ credit, index }))
    .sort((a, b) => expirySortValue(a.credit) - expirySortValue(b.credit) || a.index - b.index)
    .map(({ credit }) => credit);
}

function selectResetCredit(payload: unknown, requestedCreditId?: string): CodexResetCredit {
  const credits = parseAvailableResetCredits(payload);
  if (requestedCreditId) {
    const selected = credits.find((credit) => credit.id === requestedCreditId);
    if (selected) return selected;
    throw new AppError("validation", "所选 Codex 重置额度已不可用，请刷新后确认");
  }
  if (credits[0]) return credits[0];
  throw new AppError("validation", "没有可用的 Codex 重置额度");
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function buildHeaders(accessToken: string, workspaceId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...getCodexBackendIdentityHeaders(),
  };
  if (workspaceId) headers["chatgpt-account-id"] = workspaceId;
  return headers;
}

async function request(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  fallbackMessage: string,
): Promise<{ response: Response; payload: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new AppError("network", fallbackMessage, true, { cause: error });
  }
  let payload: unknown;
  try {
    payload = await readResponsePayload(response);
  } catch (error) {
    throw new AppError("network", fallbackMessage, true, { cause: error });
  }
  return { response, payload };
}

function outcomeValidationError(payload: unknown): AppError | null {
  const outcome = extractOutcome(payload);
  if (outcome === "nocredit" || outcome === "nocredits") {
    return new AppError("validation", "没有可用的 Codex 重置额度");
  }
  if (outcome === "nothingtoreset") {
    return new AppError("validation", "当前没有已耗尽、可重置的 Codex 限额");
  }
  return null;
}

function mapUpstreamFailure(response: Response, payload: unknown): AppError {
  const validation = outcomeValidationError(payload);
  if (validation) return validation;
  if (response.status === 401 || response.status === 403) {
    return new AppError("authentication", "Codex 重置额度接口拒绝了当前令牌");
  }
  if (response.status === 429) {
    return new AppError("rate-limit", "Codex 重置额度请求过于频繁，请稍后重试", true);
  }
  return new AppError("upstream", `Codex 重置额度接口返回 HTTP ${response.status}`, true);
}

function parseConsumeOutcome(payload: unknown): CodexResetCreditOutcome {
  const outcome = extractOutcome(payload);
  if (outcome === "reset") return "reset";
  if (outcome === "alreadyredeemed") return "alreadyRedeemed";
  const validation = outcomeValidationError(payload);
  if (validation) throw validation;
  throw new AppError("upstream", "Codex 返回了未知的重置结果");
}

export async function redeemCodexResetCredit(
  options: RedeemCodexResetCreditOptions,
): Promise<CodexResetCreditOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = buildHeaders(options.accessToken, options.workspaceId);

  const listed = await request(
    CODEX_RESET_CREDITS_URL,
    { method: "GET", headers, signal: AbortSignal.timeout(CODEX_RESET_CREDIT_TIMEOUT_MS) },
    fetchImpl,
    "使用前无法确认 Codex 重置额度列表，请稍后重试",
  );
  if (!listed.response.ok) throw mapUpstreamFailure(listed.response, listed.payload);

  const credit = selectResetCredit(listed.payload, options.creditId);

  const consumed = await request(
    CODEX_RESET_CREDIT_CONSUME_URL,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ redeem_request_id: randomUUID(), credit_id: credit.id }),
      signal: AbortSignal.timeout(CODEX_RESET_CREDIT_TIMEOUT_MS),
    },
    fetchImpl,
    "Codex 使用请求结果未知，请刷新后确认是否已消耗",
  );
  if (!consumed.response.ok) throw mapUpstreamFailure(consumed.response, consumed.payload);

  return parseConsumeOutcome(consumed.payload);
}
