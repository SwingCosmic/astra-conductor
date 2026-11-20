import type { ModelRoute } from "@astra-conductor/contract/common";
import { AppError } from "../errors.js";
import type { ActualChargeReceipt, ProviderOfferingModelPolicy } from "./model-policy.js";
import { decimalAmount, readModelJson } from "./model-response.js";

const openRouterBase = "https://openrouter.ai/api/v1";

export function isOpenRouterReceiptRoute(route: ModelRoute): boolean {
  return (
    route.baseUrl === openRouterBase &&
    (route.protocol === "openai-chat" || route.protocol === "openai-responses")
  );
}

export function isOpenRouterGenerationId(id: unknown): id is string {
  return typeof id === "string" && /^gen-[a-zA-Z0-9_-]{1,120}$/.test(id);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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

export const openRouterReceiptPolicy: ProviderOfferingModelPolicy = {
  offeringId: "openrouter-receipt",

  async transformReceipt(current, ctx): Promise<ActualChargeReceipt | null> {
    if (current !== null) return current;
    if (!isOpenRouterReceiptRoute(ctx.route)) return null;

    const rawResponse = record(ctx.rawResponse);
    const usage = record(rawResponse.usage);
    const inlineAmount = decimalAmount(usage.cost);
    if (inlineAmount !== undefined) {
      const eventId = isOpenRouterGenerationId(rawResponse.id) ? rawResponse.id : undefined;
      return {
        amount: inlineAmount,
        currency:
          typeof usage.currency === "string" && /^[A-Z]{3}$/.test(usage.currency)
            ? usage.currency
            : "USD",
        ...(eventId ? { eventId } : {}),
      };
    }

    const generationId = ctx.generationId ?? rawResponse.id;
    if (!isOpenRouterGenerationId(generationId)) return null;

    const url = new URL(openRouterBase + "/generation");
    url.searchParams.set("id", generationId);
    const response = await ctx.http.fetch(url, {
      method: "GET",
      headers: ctx.headers,
      credentials: "omit",
      redirect: "error",
      signal: ctx.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) return null;
      rejectStatus(response.status);
    }
    const body = record(
      await readModelJson(response, 256 * 1024, () => {
        throw new AppError("upstream", "模型服务返回了无效的费用回执");
      }),
    );
    const data = record(body.data);
    const amount = decimalAmount(data.total_cost);
    return data.id === generationId && amount !== undefined
      ? { amount, currency: "USD", eventId: generationId }
      : null;
  },
};
