import type { JsonValue, ModelParameters, ModelRoute } from "@astra-conductor/contract/common";
import { GROK_BUILD_REASONING_INCLUDE } from "@omniroute/open-sse/config/grokBuild.ts";
import { readModelJson } from "./model-response.js";
import { AppError } from "../errors.js";
import type { Account, CredentialEnvelope } from "../models.js";
import type { HttpPort } from "../ports.js";
import { modelAuthorization, type ConnectionProviderSource } from "./model-routes.js";
import { usesLegacyOutputLimitField } from "./model-destination.js";
import {
  rejectUnsupportedGrokEffort,
  grokBuildFallbackEffort,
} from "./grok-build/model-profile.js";
import {
  decimalAmount,
  isGenerationId,
  openRouterReceiptRoute,
  receiptCurrency,
} from "./model-chat-receipt.js";

const maxResponseBytes = 8 * 1024 * 1024;
const previewPrompt = "Hello from GraphAgent.";

function compile(
  account: Account,
  route: ModelRoute,
  modelId: string,
  parameters: ModelParameters,
  prompt: string,
) {
  const codex = account.provider === "codex" && account.offeringId === "codex";
  const grok = account.provider === "grok-build";
  const { effort, maxOutputTokens, temperature, topP } = parameters;
  const messages = [{ role: "user", content: prompt }];
  const body: Record<string, JsonValue> = { model: modelId };
  let relativePath: string;
  switch (route.protocolRouteId) {
    case "openai-chat":
      relativePath = "chat/completions";
      body.messages = messages;
      if (effort !== null) body.reasoning_effort = effort;
      if (maxOutputTokens !== null)
        body[usesLegacyOutputLimitField(account, route) ? "max_tokens" : "max_completion_tokens"] =
          maxOutputTokens;
      break;
    case "openai-responses":
      relativePath = "responses";
      body.input = [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
      body.store = false;
      if (effort !== null) body.reasoning = { effort };
      if (codex) {
        if (maxOutputTokens != null || temperature != null || topP != null) {
          throw new AppError("validation", "Codex 订阅接口不接受最大输出 token、温度或 top P");
        }
        body.instructions = "Answer the user's question.";
        body.stream = true;
      } else if (maxOutputTokens !== null) body.max_output_tokens = maxOutputTokens;
      if (grok) {
        body.stream = true;
        body.include = [GROK_BUILD_REASONING_INCLUDE];
        if (effort) rejectUnsupportedGrokEffort(modelId, effort);
        if (!effort) {
          const fallback = grokBuildFallbackEffort(modelId);
          if (fallback) body.reasoning = { effort: fallback };
        }
      }
      break;
    case "anthropic-messages":
      relativePath = "messages";
      body.messages = messages;
      body.max_tokens = maxOutputTokens ?? 1024;
      if (effort !== null) body.output_config = { effort };
      break;
    default:
      throw new AppError("capability-unavailable", "所选路由不支持测试对话");
  }
  if (temperature != null) body.temperature = temperature;
  if (topP != null) body.top_p = topP;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: body.stream === true ? "text/event-stream" : "application/json",
  };
  return { relativePath, body, headers };
}

export function previewModelChat(
  account: Account,
  route: ModelRoute,
  modelId: string,
  parameters: ModelParameters,
  source?: ConnectionProviderSource,
) {
  const compiled = compile(account, route, modelId, parameters, previewPrompt);
  return {
    ...compiled,
    headers: Object.fromEntries(
      mergeRequestHeaders(
        compiled.headers,
        modelAuthorization(account, null, route, modelId, "chat", source),
      ),
    ),
    method: "POST" as const,
    baseUrl: route.baseUrl,
    upstreamModelId: modelId,
    warnings:
      parameters.contextWindow === null
        ? []
        : [
            {
              code: "context-window",
              message: "上下文窗口作为本地配置保存，标准聊天协议没有对应的请求字段",
            },
          ],
  };
}

function replyError(message: string): never {
  throw new AppError("upstream", message);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function blocks(value: unknown, type: string): string {
  if (!Array.isArray(value)) return "";
  return value
    .map(object)
    .filter((item) => item.type === type && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function responsesText(value: unknown): string {
  const response = object(value);
  if (response.status && !["completed", "incomplete"].includes(String(response.status)))
    return replyError("模型服务未完成本次回答");
  if (!Array.isArray(response.output)) return "";
  return response.output
    .map(object)
    .filter((item) => item.type === "message" && item.role === "assistant")
    .map((item) => blocks(item.content, "output_text"))
    .join("");
}

function readReply(protocol: ModelRoute["protocolRouteId"], value: unknown): string {
  const result = object(value);
  if (protocol === "anthropic-messages") return blocks(result.content, "text");
  if (protocol === "openai-responses") return responsesText(result);
  const choice = object(Array.isArray(result.choices) ? result.choices[0] : null);
  const message = object(choice.message);
  if (choice.finish_reason === "content_filter") return replyError("模型服务过滤了本次回答");
  if (typeof message.content === "string") return message.content;
  if (typeof message.refusal === "string") return message.refusal;
  return blocks(message.content, "text");
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return replyError("模型服务返回了无效的 JSON");
  }
}

export interface ModelChatResult {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  actualCharge?: { amount: string; currency: string; eventId?: string };
  receiptLookup?: { generationId: string };
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function measuredReply(text: string, value: unknown, route: ModelRoute): ModelChatResult {
  const response = object(value);
  const usage = object(response.usage);
  const inputDetails = object(usage.input_tokens_details ?? usage.prompt_tokens_details);
  const outputDetails = object(usage.output_tokens_details ?? usage.completion_tokens_details);
  const cacheReadTokens = count(
    inputDetails.cached_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens,
  );
  const cacheWriteTokens = count(
    usage.cache_creation_input_tokens ?? inputDetails.cache_write_tokens,
  );
  let inputTokens = count(usage.input_tokens ?? usage.prompt_tokens);
  if (route.protocolRouteId === "anthropic-messages" && inputTokens !== undefined)
    inputTokens = count(inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0));
  const outputTokens = count(usage.output_tokens ?? usage.completion_tokens);
  const reasoningTokens = count(outputDetails.reasoning_tokens);
  const tokens = {
    ...(inputTokens !== undefined && { inputTokens }),
    ...(outputTokens !== undefined && { outputTokens }),
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
  };
  const result: ModelChatResult = { text, ...(Object.keys(tokens).length && { usage: tokens }) };
  const billing = object(response.billing);
  const charge = object(billing.actual_charge);
  const raw = charge.amount ?? usage.cost;
  const currency = charge.currency ?? usage.currency ?? receiptCurrency(route);
  const amount = decimalAmount(raw);
  if (typeof currency === "string" && /^[A-Z]{3}$/.test(currency) && amount !== undefined) {
    const id = charge.event_id ?? response.id;
    result.actualCharge = {
      amount,
      currency,
      ...(typeof id === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(id) && { eventId: id }),
    };
  }
  if (!result.actualCharge && openRouterReceiptRoute(route) && isGenerationId(response.id))
    result.receiptLookup = { generationId: response.id };
  return result;
}

/** Fixed subscription endpoints use Responses SSE. Only a terminal event publishes the answer. */
async function readResponse(
  response: Response,
  route: ModelRoute,
  stream: boolean,
): Promise<ModelChatResult> {
  const reader = response.body?.getReader();
  if (!reader) return replyError("模型服务返回了空响应");
  const decoder = new TextDecoder();
  let size = 0;
  let buffer = "";
  let deltas = "";
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      size += chunk.value?.byteLength ?? 0;
      if (size > maxResponseBytes) return replyError("模型响应超过读取上限");
      buffer += decoder.decode(chunk.value, { stream: !done });
      if (!stream) continue;
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : (frames.pop() ?? "");
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        const event = object(json(data));
        if (event.type === "response.output_text.delta" && typeof event.delta === "string")
          deltas += event.delta;
        if (event.type === "response.completed")
          return measuredReply(responsesText(event.response) || deltas, event.response, route);
        if (["error", "response.failed", "response.incomplete"].includes(String(event.type)))
          return replyError("模型服务未完成本次回答");
      }
    }
    if (stream) return replyError("模型流在回答完成前结束");
    const value = json(buffer);
    return measuredReply(readReply(route.protocolRouteId, value), value, route);
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function rejectStatus(status: number): never {
  const message = `模型请求失败（HTTP ${status}）`;
  if (status === 401) throw new AppError("authentication", message);
  if (status === 403) throw new AppError("permission", message);
  if (status === 429) throw new AppError("rate-limit", message, true);
  throw new AppError("upstream", message, status >= 500);
}

export async function sendModelChatDetailed(
  http: HttpPort,
  account: Account,
  envelope: CredentialEnvelope,
  route: ModelRoute,
  modelId: string,
  parameters: ModelParameters,
  prompt: string,
  signal: AbortSignal,
  source?: ConnectionProviderSource,
): Promise<ModelChatResult> {
  const { relativePath, headers, body } = compile(account, route, modelId, parameters, prompt);
  const url = route.baseUrl.replace(/\/+$/, "") + "/" + relativePath;
  const auth = modelAuthorization(account, envelope, route, modelId, "chat", source);
  try {
    signal.throwIfAborted();
    const response = await http.fetch(url, {
      method: "POST",
      headers: mergeRequestHeaders(headers, auth),
      redirect: "manual",
      credentials: "omit",
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      rejectStatus(response.status);
    }
    const result = await readResponse(response, route, body.stream === true);
    let text = result.text;
    signal.throwIfAborted();
    if (!text.trim()) return replyError("模型服务没有返回可显示的回答");
    // A gateway can echo request headers in a success payload as well as in an error.
    for (const secret of Object.values(envelope.secrets)) {
      if (typeof secret === "string" && secret) text = text.replaceAll(secret, "<redacted>");
    }
    const eventId = result.actualCharge?.eventId;
    if (
      eventId &&
      Object.values(envelope.secrets).some((s) => typeof s === "string" && s && eventId.includes(s))
    )
      delete result.actualCharge!.eventId;
    if (
      result.receiptLookup &&
      Object.values(envelope.secrets).some(
        (s) => typeof s === "string" && s && result.receiptLookup?.generationId.includes(s),
      )
    )
      delete result.receiptLookup;
    return { ...result, text };
  } catch (error) {
    if (signal.aborted) throw new AppError("network", "模型请求已取消或超时", true);
    if (error instanceof AppError) throw error;
    throw new AppError("network", "读取模型响应失败，请检查接口地址和网络连接", true);
  }
}

export async function sendModelChat(
  ...args: Parameters<typeof sendModelChatDetailed>
): Promise<string> {
  return (await sendModelChatDetailed(...args)).text;
}

function mergeRequestHeaders(
  headers: Record<string, string>,
  authorization: Record<string, string>,
) {
  const result = new Headers(headers);
  for (const [name, value] of Object.entries(authorization)) result.set(name, value);
  return result;
}
