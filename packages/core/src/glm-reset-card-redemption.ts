import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import {
  GLM_RESET_CARD_URLS,
  getGlmApiRegion,
  getGlmTeamQuotaConfig,
} from "./vendor/omniroute/open-sse/config/glmProvider.js";
import {
  fetchGlmResetCardList,
  type GlmResetCard,
} from "./vendor/omniroute/open-sse/services/usage/glmResetCards.js";

const GLM_RESET_CARD_TIMEOUT_MS = 15_000;

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function envelopeAccepted(payload: unknown): boolean {
  const record = toRecord(payload);
  return record.success === true && (record.code === 0 || record.code === 200);
}

function envelopeMessage(payload: unknown): string | null {
  const record = toRecord(payload);
  const message = record.msg ?? record.message;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 240) : null;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

export async function redeemGlmResetCard(
  apiKey: string,
  providerSpecificData: unknown,
  selectionToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GlmResetCard> {
  const listed = await fetchGlmResetCardList(apiKey, providerSpecificData, fetchImpl);
  if (!listed) {
    throw new AppError("upstream", "使用前无法确认 GLM 重置卡列表，请稍后重试", true);
  }
  const card = listed.cards.find((candidate) => candidate.id === selectionToken);
  if (!card) {
    throw new AppError("validation", "所选 GLM 重置卡已不可用，请刷新后确认列表");
  }

  const baseUrl = GLM_RESET_CARD_URLS[getGlmApiRegion(providerSpecificData)];
  const team = getGlmTeamQuotaConfig(providerSpecificData);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (team.state === "configured") {
    headers["bigmodel-organization"] = team.organizationId;
    headers["bigmodel-project"] = team.projectId;
  }
  const numericId = Number(card.id);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/use`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        targetType: "PERSONAL",
        resetType: card.resetType,
        recordId: Number.isFinite(numericId) ? numericId : card.id,
        requestId: randomUUID(),
      }),
      signal: AbortSignal.timeout(GLM_RESET_CARD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError("network", "GLM 使用请求结果未知，请先刷新列表再决定是否重试", true, {
      cause: error,
    });
  }

  let payload: unknown;
  try {
    payload = await parseResponse(response);
  } catch (error) {
    throw new AppError("network", "GLM 使用请求结果未知，请先刷新列表再决定是否重试", true, {
      cause: error,
    });
  }
  if (response.ok && envelopeAccepted(payload)) return card;
  if (response.status === 401 || response.status === 403) {
    throw new AppError("authentication", "GLM 重置卡接口拒绝了当前 API Key");
  }
  if (response.status === 429) {
    throw new AppError("rate-limit", "GLM 重置卡使用请求过于频繁，请稍后重试", true);
  }
  const reason = envelopeMessage(payload);
  throw new AppError(
    "upstream",
    reason ? `GLM 重置卡使用失败：${reason}` : "GLM 重置卡使用被上游拒绝",
  );
}
