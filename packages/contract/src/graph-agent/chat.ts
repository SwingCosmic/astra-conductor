import type { BillingEstimate, JsonValue } from "../common/index.js";
import { apiOperation } from "../common/api.js";
import type { ServiceResult } from "../common/dto/errors.js";
import type { CommandContext } from "../common/service.js";
import { exact, fail, object, parseCommandContext } from "../common/validation/request.js";

export interface TestChatRequest extends CommandContext {
  expectedSettingsRevision: string;
  expectedBindingRevision: string;
  prompt: string;
}

export interface TestChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
export interface ChatCharge {
  rateCard?: { id: string; revision: string };
  status: BillingEstimate["status"] | "actual";
  currency: string | null;
  amount: string | null;
  estimate: BillingEstimate | null;
}
export interface ChatResultRequest extends CommandContext {
  callId: string;
}
export interface TestChatResult {
  text: string;
  callId: string;
  usage?: TestChatUsage;
  charge: ChatCharge;
}

export interface IGraphAgentChatService {
  nativeChat(input: NativeChatRequest, signal?: AbortSignal): Promise<Response>;
  nativeModels(input: NativeModelsRequest, signal?: AbortSignal): Promise<Response>;
  getChatCharge(input: ChatResultRequest): Promise<ServiceResult<ChatCharge>>;
  closeChatResult(input: ChatResultRequest): Promise<ServiceResult<void>>;
  testChat(input: TestChatRequest, signal?: AbortSignal): Promise<ServiceResult<TestChatResult>>;
}

const proxy = "/api/v1/graph-agent/proxy";
export const nativeChatPaths = {
  "openai-chat": proxy + "/openai/v1/chat/completions",
  "openai-responses": proxy + "/openai/v1/responses",
  "anthropic-messages": proxy + "/anthropic/v1/messages",
} as const;
export type NativeChatProtocol = keyof typeof nativeChatPaths;
export interface NativeChatRequest extends Omit<TestChatRequest, "prompt"> {
  protocol: NativeChatProtocol;
  body: Record<string, JsonValue>;
}
export interface NativeModelsRequest extends CommandContext {
  family: "openai" | "anthropic";
  accountId: string;
  familyBindingRevision: string;
  query?: Record<string, string>;
}
const localHeaders = (input: CommandContext) => ({
  "X-GraphAgent-Instance-Id": input.instanceId,
  "X-GraphAgent-Context-Id": input.contextId,
});
export const nativeChatOperation = {
  method: "POST" as const,
  path: (input: NativeChatRequest) => nativeChatPaths[input.protocol],
  headers: (input: NativeChatRequest) => ({
    ...localHeaders(input),
    "X-GraphAgent-Settings-Revision": input.expectedSettingsRevision,
    "X-GraphAgent-Binding-Revision": input.expectedBindingRevision,
    "Content-Type": "application/json",
    Accept: input.body.stream === true ? "text/event-stream, application/json" : "application/json",
  }),
  body: (input: NativeChatRequest) => input.body,
};
export const nativeModelsOperation = {
  method: "GET" as const,
  path: (input: NativeModelsRequest) => {
    const query = new URLSearchParams(input.query).toString();
    if (input.family !== "openai" && input.family !== "anthropic") throw new Error("未知的协议族");
    return proxy + "/" + input.family + "/v1/models" + (query ? "?" + query : "");
  },
  headers: (input: NativeModelsRequest) => ({
    ...localHeaders(input),
    "X-GraphAgent-Account-Id": input.accountId,
    "X-GraphAgent-Family-Binding-Revision": input.familyBindingRevision,
    Accept: "application/json",
  }),
};

export function parseTestChatRequest(value: unknown): TestChatRequest {
  const request = object(value, "testChat");
  exact(
    request,
    ["instanceId", "contextId", "expectedSettingsRevision", "expectedBindingRevision", "prompt"],
    "testChat",
  );
  const revision = (key: "expectedSettingsRevision" | "expectedBindingRevision") => {
    const field = request[key];
    if (typeof field !== "string" || !field || field.length > 256 || /[\s\x00-\x1f]/.test(field))
      return fail(key);
    return field;
  };
  if (
    typeof request.prompt !== "string" ||
    !request.prompt.trim() ||
    request.prompt.length > 16_384
  ) {
    return fail("prompt");
  }
  return {
    ...parseCommandContext(request),
    expectedSettingsRevision: revision("expectedSettingsRevision"),
    expectedBindingRevision: revision("expectedBindingRevision"),
    prompt: request.prompt,
  };
}

export const testChatPath = "/api/v1/graph-agent/chat";
export const testChatOperation = apiOperation<TestChatRequest, TestChatResult>(
  "POST",
  testChatPath,
  { body: (input) => input, parseInput: parseTestChatRequest, timeoutMs: 125_000 },
);

function parseResultRequest(value: unknown): ChatResultRequest {
  const row = object(value, "chatResult");
  exact(row, ["instanceId", "contextId", "callId"], "chatResult");
  if (typeof row.callId !== "string" || !/^[-a-f0-9]{36}$/.test(row.callId)) return fail("callId");
  return { ...parseCommandContext(row), callId: row.callId };
}
export const getChatChargeOperation = apiOperation<ChatResultRequest, ChatCharge>(
  "POST",
  testChatPath + "/charge",
  { body: (i) => i, parseInput: parseResultRequest },
);
export const closeChatResultOperation = apiOperation<ChatResultRequest, void>(
  "POST",
  testChatPath + "/close",
  { body: (i) => i, parseInput: parseResultRequest },
);
