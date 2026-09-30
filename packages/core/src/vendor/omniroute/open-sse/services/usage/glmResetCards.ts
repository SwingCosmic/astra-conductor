import { buildGlmResetCardFetch } from "../../config/glmProvider.ts";
import { toNumber, toRecord } from "./scalars.ts";

type JsonRecord = Record<string, unknown>;

const GLM_RESET_CARD_TIMEOUT_MS = 15_000;
const ZAI_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

export type GlmResetWindow = "FIVE_HOUR" | "WEEK";

const resetCardBuckets: ReadonlyArray<{ key: string; resetType: GlmResetWindow }> = [
  { key: "fiveHourResets", resetType: "FIVE_HOUR" },
  { key: "weekResets", resetType: "WEEK" },
];

export interface GlmResetCard {
  id: string;
  resetType: GlmResetWindow;
  expiresAt: string | null;
}

export interface GlmResetCardList {
  cards: GlmResetCard[];
  availableCount: number;
}

function firstString(record: JsonRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function unavailable(record: JsonRecord): boolean {
  const status =
    typeof (record.status ?? record.state) === "string"
      ? String(record.status ?? record.state)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
      : "";
  return (
    ["consumed", "redeeming", "redeemed", "used", "expired", "unavailable"].includes(status) ||
    record.available === false ||
    record.consumed === true ||
    record.redeemed === true
  );
}

export function parseGlmResetCardTimestamp(value: string): number | null {
  const trimmed = value.trim();
  const match = ZAI_TIMESTAMP_PATTERN.exec(trimmed);
  if (match) {
    const [, year, month, day, hour, minute, second, fraction = "0"] = match;
    const parts = [year, month, day, hour, minute, second].map(Number);
    const timestamp = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
    const date = new Date(timestamp);
    if (
      date.getUTCFullYear() !== parts[0] ||
      date.getUTCMonth() + 1 !== parts[1] ||
      date.getUTCDate() !== parts[2] ||
      date.getUTCHours() !== parts[3] ||
      date.getUTCMinutes() !== parts[4] ||
      date.getUTCSeconds() !== parts[5]
    ) {
      return null;
    }
    return timestamp + Number(fraction.padEnd(3, "0"));
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseCard(value: unknown, fallbackType: GlmResetWindow): GlmResetCard | null {
  const record = toRecord(value);
  if (Object.keys(record).length === 0 || unavailable(record)) return null;
  const id = firstString(record, ["recordId", "id", "packageResetId", "resetId"]);
  if (!id) return null;
  const expiresAt = firstString(record, ["expireTime", "expiredTime", "expiresAt", "endTime"]);
  if (expiresAt) {
    const expiry = parseGlmResetCardTimestamp(expiresAt);
    if (expiry !== null && expiry <= Date.now()) return null;
  }
  const rawType = typeof (record.resetType ?? record.type) === "string"
    ? String(record.resetType ?? record.type).trim().toUpperCase()
    : "";
  return {
    id,
    resetType: rawType === "WEEK" || rawType === "FIVE_HOUR" ? rawType : fallbackType,
    expiresAt,
  };
}

export function parseGlmResetCards(payload: unknown): GlmResetCardList {
  const data = toRecord(toRecord(payload).data);
  const cards: GlmResetCard[] = [];
  for (const bucket of resetCardBuckets) {
    const entries = data[bucket.key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const card = parseCard(entry, bucket.resetType);
      if (card) cards.push(card);
    }
  }
  cards.sort((left, right) => {
    const leftExpiry = left.expiresAt
      ? (parseGlmResetCardTimestamp(left.expiresAt) ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
    const rightExpiry = right.expiresAt
      ? (parseGlmResetCardTimestamp(right.expiresAt) ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
    return leftExpiry - rightExpiry;
  });
  return { cards, availableCount: cards.length };
}

function validEnvelope(payload: unknown): boolean {
  const record = toRecord(payload);
  const code = toNumber(record.code, Number.NaN);
  if (record.success !== true || (code !== 0 && code !== 200)) return false;
  const data = toRecord(record.data);
  return resetCardBuckets.every((bucket) => Array.isArray(data[bucket.key]));
}

export async function fetchGlmResetCardList(
  apiKey: string,
  providerSpecificData: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<GlmResetCardList | null> {
  try {
    const { url, headers } = buildGlmResetCardFetch(apiKey, providerSpecificData, "list");
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(GLM_RESET_CARD_TIMEOUT_MS),
    });
    const payload: unknown = await response.json();
    if (!response.ok || !validEnvelope(payload)) return null;
    return parseGlmResetCards(payload);
  } catch {
    return null;
  }
}
