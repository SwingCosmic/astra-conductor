import type { ModelRoute } from "@astra-conductor/contract/common";
import type { Account, CredentialEnvelope } from "../models.js";
import type { HttpPort } from "../ports.js";
import { AppError } from "../errors.js";
import { readModelJson } from "./model-response.js";
import { modelAuthorization, type ConnectionProviderSource } from "./model-routes.js";
import type { ModelChatResult } from "./model-chat.js";

// The OpenRouter generation endpoint is the only upstream that exposes a per-request
// charge receipt today; keep its wire knowledge out of the generic chat paths.
const openRouterBase = "https://openrouter.ai/api/v1";

export function openRouterReceiptRoute(route: ModelRoute): boolean {
  return (
    route.baseUrl === openRouterBase &&
    (route.protocolRouteId === "openai-chat" || route.protocolRouteId === "openai-responses")
  );
}

export function receiptCurrency(route: ModelRoute): string | undefined {
  return openRouterReceiptRoute(route) ? "USD" : undefined;
}

export function isGenerationId(id: unknown): id is string {
  return typeof id === "string" && /^gen-[a-zA-Z0-9_-]{1,120}$/.test(id);
}

/** Quoted prices are nonnegative decimal strings, possibly longer than double precision. */
export function decimalAmount(value: unknown): string | undefined {
  let amount =
    typeof value === "string"
      ? value
      : typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= Number.MAX_SAFE_INTEGER
        ? String(value)
        : "";
  // JSON numbers below 1e-6 are emitted in exponential notation by JS.
  if (typeof value === "number" && amount.includes("e-")) {
    const [digits, exponent] = amount.split("e-");
    if (Number(exponent) > 32) return;
    amount = "0." + "0".repeat(Number(exponent) - 1) + digits.replace(".", "");
  }
  return /^\d{1,32}(?:\.\d{1,32})?$/.test(amount) ? amount : undefined;
}

/** Read a charge only for the original authorized official OpenRouter destination. */
export async function lookupModelChatCharge(
  http: HttpPort,
  account: Account,
  envelope: CredentialEnvelope,
  route: ModelRoute,
  modelId: string,
  generationId: string,
  signal: AbortSignal,
  source?: ConnectionProviderSource,
): Promise<NonNullable<ModelChatResult["actualCharge"]> | null> {
  if (!openRouterReceiptRoute(route) || !isGenerationId(generationId)) return null;
  const headers = modelAuthorization(account, envelope, route, modelId, "chat", source);
  const url = new URL(openRouterBase + "/generation");
  url.searchParams.set("id", generationId);
  const response = await http.fetch(url, {
    method: "GET",
    headers,
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) return null;
    rejectStatus(response.status);
  }
  const body = object(
    await readModelJson(response, 256 * 1024, () => replyError("模型服务返回了无效的费用回执")),
  );
  const data = object(body.data);
  const amount = decimalAmount(data.total_cost);
  return data.id === generationId && amount !== undefined
    ? { amount, currency: "USD", eventId: generationId }
    : null;
}

function replyError(message: string): never {
  throw new AppError("upstream", message);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rejectStatus(status: number): never {
  const message = `模型请求失败（HTTP ${status}）`;
  if (status === 401) throw new AppError("authentication", message);
  if (status === 403) throw new AppError("permission", message);
  if (status === 429) throw new AppError("rate-limit", message, true);
  throw new AppError("upstream", message, status >= 500);
}
