import type {
  EndpointProtocol,
  JsonValue,
  ModelFacts,
  ModelParameters,
  ModelRoute,
} from "@astra-conductor/contract/common";
import { AppError } from "../errors.js";
import type { Account, CredentialEnvelope } from "../models.js";
import type { HttpPort } from "../ports.js";
import { getBuiltInModelPolicy } from "./catalog.js";
import {
  applyAsyncPolicyChain,
  applyPolicyChain,
  validateNativeBody,
  type ActualChargeReceipt,
  type ModelChatUsage,
  type ProtocolRequestContext,
  type ProtocolRequestDraft,
  type ProviderOfferingModelPolicy,
  type RequestPlan,
  type RequestPlanContext,
} from "./model-policy.js";
import {
  applyUserExtensions,
  compileModelRequestPlan,
  resolveEffectiveModelRule,
} from "./model-request-rule.js";
import { decimalAmount } from "./model-response.js";
import {
  applyModelRouteQuery,
  modelAuthorization,
  type ConnectionProviderSource,
} from "./model-routes.js";

const maxResponseBytes = 8 * 1024 * 1024;
const previewPrompt = "Hello from GraphAgent.";

export interface ModelChatOptions {
  readonly facts?: Partial<ModelFacts>;
  readonly policy?: ProviderOfferingModelPolicy;
  readonly extraPolicies?: readonly ProviderOfferingModelPolicy[];
  readonly receiptPolicies?: readonly ProviderOfferingModelPolicy[];
  readonly catalogModels?: RequestPlanContext["catalogModels"];
  readonly outputMode?: ModelFacts["reasoningOutputMode"];
}

function normalizeChatOptions(
  outputModeOrOptions?: ModelFacts["reasoningOutputMode"] | ModelChatOptions,
): ModelChatOptions {
  if (!outputModeOrOptions) return {};
  if (typeof outputModeOrOptions === "string") {
    return { outputMode: outputModeOrOptions, facts: { reasoningOutputMode: outputModeOrOptions } };
  }
  if (outputModeOrOptions.outputMode && !outputModeOrOptions.facts?.reasoningOutputMode) {
    return {
      ...outputModeOrOptions,
      facts: { ...outputModeOrOptions.facts, reasoningOutputMode: outputModeOrOptions.outputMode },
    };
  }
  return outputModeOrOptions;
}

function resolveChatPolicy(
  account: Account,
  source: ConnectionProviderSource | undefined,
  options: ModelChatOptions,
): ProviderOfferingModelPolicy | undefined {
  if (options.policy) return options.policy;
  return (
    getBuiltInModelPolicy({
      providerId: account.provider,
      offeringId: account.offeringId,
      templateKind: source?.templateKind?.(account.provider),
    }) ?? undefined
  );
}

/** Step 3a: Pure protocol encoder for openai-chat, openai-responses, and anthropic-messages. */
export function encodeProtocolDraft(
  plan: RequestPlan,
  route: ModelRoute,
  prompt: string,
  facts: Partial<ModelFacts> = {},
): ProtocolRequestDraft {
  const { maxOutputTokens, temperature, topP } = plan.parameters;
  const effort =
    plan.thinkingActive && !plan.suppressEffortField && !plan.consumedParameters.includes("effort")
      ? plan.parameters.effort
      : null;
  const outputMode = facts.reasoningOutputMode;
  const messages = [{ role: "user", content: prompt }];
  const body: Record<string, JsonValue> = { model: plan.upstreamModelId };
  let relativePath: string;

  switch (route.protocol) {
    case "openai-chat":
      relativePath = "chat/completions";
      body.messages = messages;
      if (effort !== null) body.reasoning_effort = effort;
      if (maxOutputTokens !== null) {
        body[plan.outputLimitField ?? "max_completion_tokens"] = maxOutputTokens;
      }
      break;
    case "openai-responses":
      relativePath = "responses";
      body.input = [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
      body.store = false;
      if (effort !== null) body.reasoning = { effort };
      if (
        plan.thinkingActive &&
        !plan.suppressSummaryRequest &&
        effort !== "none" &&
        outputMode === "summary"
      ) {
        body.reasoning = { ...(effort ? { effort } : {}), summary: "auto" };
      }
      if (maxOutputTokens !== null) body.max_output_tokens = maxOutputTokens;
      break;
    case "anthropic-messages":
      relativePath = "messages";
      body.messages = messages;
      body.max_tokens = maxOutputTokens ?? 1024;
      if (effort !== null) body.output_config = { effort };
      if (plan.thinkingActive && !plan.suppressSummaryRequest && outputMode === "summary") {
        body.thinking = { type: "adaptive", display: "summarized" };
      }
      break;
    case "gemini-generate-content": {
      relativePath = `models/${encodeURIComponent(plan.upstreamModelId)}:generateContent`;
      const generationConfig: Record<string, JsonValue> = {};
      if (maxOutputTokens !== null) generationConfig.maxOutputTokens = maxOutputTokens;
      if (temperature != null) generationConfig.temperature = temperature;
      if (topP != null) generationConfig.topP = topP;
      if (effort !== null && effort !== "none") {
        generationConfig.thinkingConfig = {
          thinkingLevel: effort.toUpperCase(),
          ...(plan.thinkingActive && !plan.suppressSummaryRequest && outputMode === "summary"
            ? { includeThoughts: true }
            : {}),
        };
      } else if (!plan.thinkingActive && facts.reasoningMode !== "none") {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }
      return {
        relativePath,
        body: {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
        },
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        query: { ...(route.familyPolicy?.query ?? {}) },
      };
    }
    default:
      throw new AppError("capability-unavailable", "所选路由不支持测试对话");
  }

  if (temperature != null) body.temperature = temperature;
  if (topP != null) body.top_p = topP;

  return {
    relativePath,
    body,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    query: { ...(route.familyPolicy?.query ?? {}) },
  };
}

function compileChatRequest(
  account: Account,
  route: ModelRoute,
  modelId: string,
  parameters: ModelParameters,
  prompt: string,
  source?: ConnectionProviderSource,
  outputModeOrOptions?: ModelFacts["reasoningOutputMode"] | ModelChatOptions,
) {
  const options = normalizeChatOptions(outputModeOrOptions);
  const policy = resolveChatPolicy(account, source, options);
  const facts = options.facts ?? {};

  // Step 1 + Step 2: Build base plan and run transformRequestPlan chain
  const plan = compileModelRequestPlan({
    providerId: account.provider,
    offeringId: account.offeringId,
    route,
    localModelId: modelId,
    facts,
    parameters,
    policy,
    extraPolicies: options.extraPolicies,
    catalogModels: options.catalogModels,
  });

  // Step 3: Encode standard protocol draft and run transformProtocolRequest chain
  const baseDraft = encodeProtocolDraft(plan, route, prompt, facts);
  const draftContext: ProtocolRequestContext = {
    providerId: account.provider,
    offeringId: account.offeringId,
    protocol: route.protocol,
    route,
    plan,
    facts,
    requestRule: route.requestRule,
    prompt,
  };
  const draft = applyPolicyChain(baseDraft, draftContext, [
    ...(options.extraPolicies ?? []).map((p) => p.transformProtocolRequest),
    policy?.transformProtocolRequest,
    applyUserExtensions,
  ]);

  // Verify the compiled draft satisfies all declared RequestPlan constraints
  validateNativeBody(draft.body, plan, route.protocol);

  const { rule, hasByModel } = resolveEffectiveModelRule(modelId, route.requestRule);
  const ruleSources = [
    ...(route.familyPolicy ? ["family"] : []),
    ...(rule ? ["endpoint"] : []),
    ...(hasByModel ? ["model"] : []),
    ...(policy?.transformRequestPlan || policy?.transformProtocolRequest
      ? ["policy:" + policy.offeringId]
      : []),
  ];

  return { plan, draft, policy, options, ruleSources };
}

export interface CompiledModelChatPreview {
  readonly method: "POST";
  readonly baseUrl: string;
  readonly relativePath: string;
  readonly upstreamModelId: string;
  readonly consumedParameters: ("effort" | "window")[];
  readonly ruleSources: string[];
  readonly headers: Record<string, string>;
  readonly body: Record<string, JsonValue>;
  readonly warnings: { code: string; message: string }[];
}

/** Step 4a: Pure preview (zero credential reads, strict DTO fields with no leaked internal headers). */
export function previewModelChat(
  account: Account,
  route: ModelRoute,
  modelId: string,
  parameters: ModelParameters,
  source?: ConnectionProviderSource,
  outputModeOrOptions?: ModelFacts["reasoningOutputMode"] | ModelChatOptions,
): CompiledModelChatPreview {
  const { plan, draft, policy, ruleSources } = compileChatRequest(
    account,
    route,
    modelId,
    parameters,
    previewPrompt,
    source,
    outputModeOrOptions,
  );
  const url = applyDraftQuery(new URL(route.baseUrl), draft.query);
  const authHeaders = modelAuthorization(
    account,
    null,
    route,
    plan.upstreamModelId,
    "chat",
    source,
    policy,
  );
  return {
    method: "POST",
    baseUrl: route.baseUrl,
    relativePath: draft.relativePath + url.search,
    upstreamModelId: plan.upstreamModelId,
    consumedParameters: [...plan.consumedParameters],
    ruleSources,
    headers: Object.fromEntries(mergeRequestHeaders(draft.headers, authHeaders)),
    body: draft.body,
    warnings: [...plan.warnings],
  };
}

function applyDraftQuery(url: URL, query: Record<string, string>): URL {
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return url;
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
  if (response.status && !["completed", "incomplete"].includes(String(response.status))) {
    return replyError("模型服务未完成本次回答");
  }
  if (!Array.isArray(response.output)) return "";
  return response.output
    .map(object)
    .filter((item) => item.type === "message" && item.role === "assistant")
    .map((item) => blocks(item.content, "output_text"))
    .join("");
}

function readReply(protocol: EndpointProtocol, value: unknown): string {
  const result = object(value);
  if (protocol === "anthropic-messages") return blocks(result.content, "text");
  if (protocol === "openai-responses") return responsesText(result);
  if (protocol === "gemini-generate-content") {
    const candidate = object(Array.isArray(result.candidates) ? result.candidates[0] : null);
    if (candidate.finishReason === "SAFETY" || candidate.finishReason === "PROHIBITED_CONTENT") {
      return replyError("模型服务过滤了本次回答");
    }
    const content = object(candidate.content);
    if (!Array.isArray(content.parts)) return "";
    return content.parts
      .map(object)
      .filter((part) => part.thought !== true && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
  }
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
  usage?: ModelChatUsage;
  actualCharge?: ActualChargeReceipt;
  responseId?: string;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function measuredReply(
  text: string,
  value: unknown,
  route: ModelRoute,
  options?: {
    providerId?: string;
    offeringId?: string;
    policies?: readonly (ProviderOfferingModelPolicy | undefined)[];
  },
): ModelChatResult {
  const response = object(value);
  const usage = object(response.usage ?? response.usageMetadata);
  const inputDetails = object(usage.input_tokens_details ?? usage.prompt_tokens_details);
  const outputDetails = object(usage.output_tokens_details ?? usage.completion_tokens_details);
  const cacheReadTokens = count(
    inputDetails.cached_tokens ??
      usage.cache_read_input_tokens ??
      usage.prompt_cache_hit_tokens ??
      usage.cachedContentTokenCount,
  );
  const cacheWriteTokens = count(
    usage.cache_creation_input_tokens ?? inputDetails.cache_write_tokens,
  );
  let inputTokens = count(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount);
  if (route.protocol === "anthropic-messages" && inputTokens !== undefined) {
    inputTokens = count(inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0));
  }
  const outputTokens = count(
    usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount,
  );
  const reasoningTokens = count(outputDetails.reasoning_tokens ?? usage.thoughtsTokenCount);
  const baseUsage: ModelChatUsage = {
    ...(inputTokens !== undefined && { inputTokens }),
    ...(outputTokens !== undefined && { outputTokens }),
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
  };

  const finalUsage = options?.policies?.length
    ? applyPolicyChain(
        baseUsage,
        {
          providerId: options.providerId ?? "",
          offeringId: options.offeringId ?? "",
          protocol: route.protocol,
          route,
          rawResponse: value,
        },
        options.policies.map((p) => p?.transformUsage),
      )
    : baseUsage;

  const result: ModelChatResult = {
    text,
    ...(Object.keys(finalUsage).length && { usage: finalUsage }),
  };

  const billing = object(response.billing);
  const charge = object(billing.actual_charge);
  const raw = charge.amount ?? usage.cost;
  const currency = charge.currency ?? usage.currency;
  const amount = decimalAmount(raw);
  if (typeof currency === "string" && /^[A-Z]{3}$/.test(currency) && amount !== undefined) {
    const id = charge.event_id ?? response.id;
    result.actualCharge = {
      amount,
      currency,
      ...(typeof id === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(id) && { eventId: id }),
    };
  }
  if (typeof response.id === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(response.id)) {
    result.responseId = response.id;
  }
  return result;
}

/** Fixed subscription endpoints use Responses SSE. Only a terminal event publishes the answer. */
async function readResponse(
  response: Response,
  route: ModelRoute,
  stream: boolean,
  usageOptions?: Parameters<typeof measuredReply>[3],
): Promise<{ result: ModelChatResult; rawResponse: unknown }> {
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
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          deltas += event.delta;
        }
        if (event.type === "response.completed") {
          return {
            result: measuredReply(
              responsesText(event.response) || deltas,
              event.response,
              route,
              usageOptions,
            ),
            rawResponse: event.response,
          };
        }
        if (["error", "response.failed", "response.incomplete"].includes(String(event.type))) {
          return replyError("模型服务未完成本次回答");
        }
      }
    }
    if (stream) return replyError("模型流在回答完成前结束");
    const value = json(buffer);
    return {
      result: measuredReply(readReply(route.protocol, value), value, route, usageOptions),
      rawResponse: value,
    };
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

/** Step 4b: Host-generated single-turn chat send with auth, usage, and optional receipt chains. */
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
  outputModeOrOptions?: ModelFacts["reasoningOutputMode"] | ModelChatOptions,
): Promise<ModelChatResult> {
  const { plan, draft, policy, options } = compileChatRequest(
    account,
    route,
    modelId,
    parameters,
    prompt,
    source,
    outputModeOrOptions,
  );
  const url = applyDraftQuery(
    applyModelRouteQuery(
      new URL(route.baseUrl.replace(/\/+$/, "") + "/" + draft.relativePath),
      route,
    ),
    draft.query,
  ).href;
  const auth = modelAuthorization(
    account,
    envelope,
    route,
    plan.upstreamModelId,
    "chat",
    source,
    policy,
  );
  const activePolicies = [...(options.extraPolicies ?? []), policy];

  try {
    signal.throwIfAborted();
    const response = await http.fetch(url, {
      method: "POST",
      headers: mergeRequestHeaders(draft.headers, auth),
      redirect: "manual",
      credentials: "omit",
      body: JSON.stringify(draft.body),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      rejectStatus(response.status);
    }
    const { result, rawResponse } = await readResponse(
      response,
      route,
      draft.body.stream === true,
      {
        providerId: account.provider,
        offeringId: account.offeringId,
        policies: activePolicies,
      },
    );
    let text = result.text;
    signal.throwIfAborted();
    if (!text.trim()) return replyError("模型服务没有返回可显示的回答");

    // A gateway can echo request headers in a success payload as well as in an error.
    for (const secret of Object.values(envelope.secrets)) {
      if (typeof secret === "string" && secret) text = text.replaceAll(secret, "<redacted>");
    }

    const containsSecret = (value: string) =>
      Object.values(envelope.secrets).some(
        (secret) => typeof secret === "string" && secret && value.includes(secret),
      );

    if (result.actualCharge?.eventId && containsSecret(result.actualCharge.eventId)) {
      delete result.actualCharge.eventId;
    }
    if (result.responseId && containsSecret(result.responseId)) {
      delete result.responseId;
    }

    const receiptPolicies = [
      ...(options.receiptPolicies ?? []),
      ...(policy?.transformReceipt ? [policy] : []),
    ];
    if (!result.actualCharge && receiptPolicies.length) {
      const receipt = await applyAsyncPolicyChain<
        ActualChargeReceipt | null,
        Parameters<NonNullable<ProviderOfferingModelPolicy["transformReceipt"]>>[1]
      >(
        null,
        {
          http,
          account,
          envelope,
          route,
          modelId: plan.upstreamModelId,
          rawResponse,
          generationId: result.responseId,
          signal,
          headers: auth,
        },
        receiptPolicies.map((p) => p.transformReceipt),
      );
      if (receipt) {
        if (receipt.eventId && containsSecret(receipt.eventId)) {
          delete receipt.eventId;
        }
        result.actualCharge = receipt;
      }
    }

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
