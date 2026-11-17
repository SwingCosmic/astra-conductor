import type { BillingEstimate } from "../common/index.js";
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
  getChatCharge(input: ChatResultRequest): Promise<ServiceResult<ChatCharge>>;
  closeChatResult(input: ChatResultRequest): Promise<ServiceResult<void>>;
  testChat(input: TestChatRequest, signal?: AbortSignal): Promise<ServiceResult<TestChatResult>>;
}

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
