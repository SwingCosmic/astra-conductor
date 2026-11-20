import type { NativeChatProtocol, TestChatUsage } from "@astra-conductor/contract/graph-agent";
import { readEventStream } from "@astra-conductor/shared-ui/services";

export interface ReasoningDisplay {
  thinkingEnabled: boolean;
  returnFullReasoning: boolean;
  mode: "none" | "full" | "summary" | "activity-only" | "unknown";
}
export interface ReplyDelta {
  key: string;
  kind: "text" | "reasoning";
  delta: string;
  done?: boolean;
}
type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const list = (value: unknown) => (Array.isArray(value) ? value.map(row) : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const index = (v: unknown) => (Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : 0);

function stopNotice(reason: unknown) {
  switch (reason) {
    case "length":
    case "max_tokens":
    case "max_output_tokens":
      return "已达到输出长度上限";
    case "refusal":
    case "content_filter":
      return "模型服务过滤或拒绝了本次回答";
    case "tool_calls":
    case "tool_use":
    case "function_call":
      return "模型请求调用工具，单轮测试已结束";
    default:
      return "";
  }
}

/** Decode the bound protocol in the renderer. Only public text reaches the OmniChat segments. */
export async function readNativeReply(
  protocol: NativeChatProtocol,
  response: Response,
  display: ReasoningDisplay,
  receive: (change: ReplyDelta) => void,
  signal: AbortSignal,
) {
  if (!response.ok) {
    const problem = row(await response.json().catch(() => null));
    throw new Error(str(row(problem.error).message) || "模型服务返回 HTTP " + response.status);
  }
  const full = display.returnFullReasoning && display.mode === "full";
  const thinking = display.thinkingEnabled && display.mode !== "none";
  const parts = new Map<string, string>();
  const usage: TestChatUsage = {};
  let ended = false,
    notice = "";
  function measure(raw: unknown) {
    const u = row(raw);
    for (const [key, n] of [
      ["inputTokens", u.input_tokens ?? u.prompt_tokens],
      ["outputTokens", u.output_tokens ?? u.completion_tokens],
    ] as const)
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) usage[key] = n;
  }
  function part(
    key: string,
    kind: ReplyDelta["kind"],
    value: unknown,
    snapshot = false,
    done = false,
  ) {
    if (kind === "reasoning" && !thinking) return;
    const text = str(value),
      old = parts.get(key);
    const delta = snapshot
      ? text.startsWith(old ?? "")
        ? text.slice(old?.length ?? 0)
        : ""
      : text;
    if (!old && !delta && kind === "text") return;
    if (delta || old === undefined || done) {
      parts.set(key, (old ?? "") + delta);
      receive({ key, kind, delta, done });
    }
  }
  let chatKind: ReplyDelta["kind"] | undefined;
  let chatSequence = 0;
  function chatPart(kind: ReplyDelta["kind"], value: unknown) {
    if (kind === "reasoning" && !thinking) return;
    if (kind !== chatKind) {
      chatKind = kind;
      chatSequence++;
    }
    part("choice-" + chatSequence, kind, value);
  }
  function chat(data: Row, snapshot: boolean) {
    measure(data.usage);
    const choice = list(data.choices).find((c) => index(c.index) === 0);
    if (!choice) return;
    const m = row(snapshot ? choice.message : choice.delta);
    if (typeof m.reasoning_content === "string" && m.reasoning_content.length)
      chatPart("reasoning", full ? m.reasoning_content : "");
    const content =
      typeof m.content === "string"
        ? m.content
        : list(m.content)
            .filter((c) => c.type === "text")
            .map((c) => str(c.text))
            .join("");
    if (content || m.refusal) chatPart("text", content || m.refusal);
    notice = stopNotice(choice.finish_reason) || notice;
    if (snapshot) ended = true;
  }
  const blockTypes = new Map<number, unknown>();
  function anthropicBlock(i: number, block: Row, snapshot: boolean, done = false) {
    const type = blockTypes.get(i);
    if (type === "thinking")
      part(
        "block-" + i,
        "reasoning",
        display.mode === "summary" || full ? block.thinking : "",
        snapshot,
        done,
      );
    if (type === "text") part("block-" + i, "text", block.text, snapshot, done);
  }
  function anthropic(type: string, data: Row) {
    const i = index(data.index);
    if (type === "message_start") measure(row(data.message).usage);
    if (type === "content_block_start") {
      const block = row(data.content_block);
      blockTypes.set(i, block.type);
      anthropicBlock(i, block, true);
    }
    if (type === "content_block_delta") {
      const delta = row(data.delta);
      if (delta.type === "thinking_delta" || delta.type === "text_delta")
        anthropicBlock(i, delta, false);
    }
    if (type === "content_block_stop") anthropicBlock(i, {}, false, true);
    if (type === "message_delta") {
      measure(data.usage);
      notice = stopNotice(row(data.delta).stop_reason);
    }
    if (type === "message_stop") ended = true;
  }
  // Match each terminal snapshot to its own streamed output item and content block.
  const itemIndices = new Map<string, number>();
  const firstReasoningPart = new Map<number, string>();
  function thought(i: number, field: string, text: unknown, snapshot: boolean, done: boolean) {
    if (field && !firstReasoningPart.has(i)) firstReasoningPart.set(i, field);
    const key = !field || firstReasoningPart.get(i) === field ? i + "-reasoning" : i + "-" + field;
    part(key, "reasoning", text, snapshot, done);
  }
  function responseItem(item: Row, i: number, done: boolean) {
    if (typeof item.id === "string") itemIndices.set(item.id, i);
    if (item.type === "reasoning") {
      const summary = list(item.summary),
        content = list(item.content);
      if (!summary.length && !content.length) thought(i, "", "", true, done);
      summary.forEach((b, j) => {
        if (b.type === "summary_text") thought(i, "summary-" + j, b.text, true, done);
      });
      content.forEach((b, j) => {
        if (b.type === "reasoning_text") thought(i, "thought-" + j, full ? b.text : "", true, done);
      });
    }
    if (item.type === "message" && (!item.role || item.role === "assistant")) {
      list(item.content).forEach((b, j) => {
        if (b.type === "output_text" || b.type === "refusal")
          part(i + "-text-" + j, "text", b.text ?? b.refusal, true, done);
      });
    }
  }
  function responses(type: string, data: Row) {
    const i =
      typeof data.output_index === "number"
        ? index(data.output_index)
        : (itemIndices.get(str(data.item_id)) ?? 0);
    const j = index(data.content_index);
    if (type === "response.output_item.added" || type === "response.output_item.done")
      responseItem(row(data.item), i, type.endsWith(".done"));
    const done = type.endsWith(".done");
    const value = done ? (data.text ?? data.refusal) : data.delta;
    if (/^response\.(output_text|refusal)\.(delta|done)$/.test(type))
      part(i + "-text-" + j, "text", value, done, done);
    if (/^response\.reasoning_summary_text\.(delta|done)$/.test(type))
      thought(i, "summary-" + index(data.summary_index), value, done, done);
    if (/^response\.reasoning_text\.(delta|done)$/.test(type))
      thought(i, "thought-" + j, full ? value : "", done, done);
    if (type === "response.failed") throw new Error("模型生成失败");
    if (type === "response.completed" || type === "response.incomplete") {
      const terminal = row(data.response);
      list(terminal.output).forEach((item, n) => responseItem(item, n, true));
      measure(terminal.usage);
      if (type === "response.incomplete")
        notice = stopNotice(row(terminal.incomplete_details).reason) || "模型回复未完成";
      ended = true;
    }
  }
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
    await readEventStream(
      response,
      (event) => {
        if (signal.aborted) return;
        if (event.data === "[DONE]") {
          if (protocol === "openai-chat") ended = true;
          return;
        }
        let data: Row;
        try {
          data = row(JSON.parse(event.data));
        } catch {
          throw new Error("模型返回了无效的事件数据");
        }
        const type = str(data.type) || event.type;
        if (type === "error" || data.error) throw new Error("模型在生成过程中发生错误");
        if (protocol === "openai-chat") chat(data, false);
        else if (protocol === "openai-responses") responses(type, data);
        else anthropic(type, data);
      },
      signal,
    );
  } else {
    const data = row(await response.json());
    if (signal.aborted) signal.throwIfAborted();
    if (data.error) throw new Error("模型服务返回错误");
    if (protocol === "openai-chat") chat(data, true);
    else if (protocol === "openai-responses")
      responses("response." + str(data.status || "completed"), { response: data });
    else if (Array.isArray(data.content)) {
      list(data.content).forEach((block, i) => {
        blockTypes.set(i, block.type);
        anthropicBlock(i, block, true, true);
      });
      measure(data.usage);
      notice = stopNotice(data.stop_reason);
      ended = true;
    }
  }
  signal.throwIfAborted();
  if (!ended) throw new Error("模型回复意外中断，已保留收到的内容");
  if (!parts.size && !notice) notice = "模型未返回可展示的内容";
  return { notice, usage: Object.keys(usage).length ? usage : null };
}
