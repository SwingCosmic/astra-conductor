import { describe, expect, it } from "vitest";
import {
  readNativeReply,
  type ReasoningDisplay,
  type ReplyDelta,
} from "../ui/src/services/native-chat-reply.js";
import { appendDelta, finishContent } from "../ui/src/pages/chat-content.js";
import type { MessageSegment } from "@lovekicher/omnichat/types/types/message.js";

const full: ReasoningDisplay = { thinkingEnabled: true, returnFullReasoning: true, mode: "full" };
const signal = new AbortController().signal;
const frame = (data: unknown) =>
  "data: " + (typeof data === "string" ? data : JSON.stringify(data)) + "\r\n\r\n";
function stream(...events: unknown[]) {
  return new Response(events.map(frame).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
function bubble() {
  let segments: MessageSegment[] = [];
  return {
    receive: (d: ReplyDelta) => {
      segments = appendDelta(segments, d);
    },
    get segments() {
      return segments;
    },
  };
}

describe("native test chat replies", () => {
  it("renders chat chunks before terminal, including UTF-8 split across chunks; consumes final usage", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        source = c;
      },
    });
    const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const b = bubble();
    const reading = readNativeReply("openai-chat", response, full, b.receive, signal);
    const initial = new TextEncoder().encode(
      [
        frame({ choices: [{ delta: { reasoning_content: "已公开" } }] }),
        frame({ choices: [{ delta: { content: "**答案**" } }] }),
      ].join(""),
    );
    for (const byte of initial) source.enqueue(Uint8Array.of(byte));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(b.segments).toMatchObject([
      { type: "ai-activity", data: { text: "已公开", state: "completed" } },
      { type: "stream", data: { markdown: "**答案**", isFinished: false } },
    ]);
    source.enqueue(
      new TextEncoder().encode(
        frame({ choices: [{ delta: {}, finish_reason: "length" }] }) +
          frame({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } }) +
          frame("[DONE]"),
      ),
    );
    source.close();
    expect(await reading).toEqual({
      notice: "已达到输出长度上限",
      usage: { inputTokens: 8, outputTokens: 4 },
    });
  });
  it("merges Responses deltas, item snapshots and terminal output without repeating either kind of text", async () => {
    const thought = {
      id: "rs",
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "abc" }],
    };
    const answer = {
      id: "msg",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer" }],
    };
    const b = bubble();
    await readNativeReply(
      "openai-responses",
      stream(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "rs", type: "reasoning", summary: [] },
        },
        { type: "response.reasoning_text.delta", item_id: "rs", delta: "ab" },
        { type: "response.reasoning_text.done", item_id: "rs", text: "abc" },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { id: "msg", type: "message", content: [] },
        },
        { type: "response.output_text.delta", item_id: "msg", delta: "ans" },
        { type: "response.output_item.done", output_index: 1, item: answer },
        { type: "response.completed", response: { output: [thought, answer] } },
      ),
      full,
      b.receive,
      signal,
    );
    expect(b.segments).toMatchObject([
      { type: "ai-activity", data: { text: "abc", state: "completed" } },
      { type: "stream", data: { markdown: "answer", isFinished: true } },
    ]);
  });
  it("displays explicitly public summaries and omits signatures, opaque material and gated full text", async () => {
    const b = bubble();
    await readNativeReply(
      "openai-responses",
      Response.json({
        status: "completed",
        output: [
          {
            type: "reasoning",
            encrypted_content: "opaque",
            summary: [{ type: "summary_text", text: "公开摘要" }],
            content: [{ type: "reasoning_text", text: "hiddenFull" }],
          },
          { type: "message", content: [{ type: "output_text", text: "正文" }] },
        ],
      }),
      { ...full, returnFullReasoning: false },
      b.receive,
      signal,
    );
    expect(JSON.stringify(b.segments)).toContain("公开摘要");
    expect(JSON.stringify(b.segments)).not.toMatch(/hiddenFull|opaque/);
    for (const thinkingEnabled of [true, false]) {
      const b = bubble();
      await readNativeReply(
        "anthropic-messages",
        stream(
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "hiddenFull" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "opaque" },
          },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "正文" } },
          { type: "message_stop" },
        ),
        { ...full, thinkingEnabled, returnFullReasoning: false },
        b.receive,
        signal,
      );
      expect(b.segments.length).toBe(thinkingEnabled ? 2 : 1);
      expect(JSON.stringify(b.segments)).not.toMatch(/hiddenFull|opaque/);
    }
  });
  it("keeps partial content across early EOF, cancellation and JSON-only endpoints", async () => {
    const b = bubble();
    await expect(
      readNativeReply(
        "openai-chat",
        stream({ choices: [{ delta: { content: "可见" } }] }),
        full,
        b.receive,
        signal,
      ),
    ).rejects.toThrow("意外中断");
    expect(finishContent(b.segments, "failed")).toMatchObject([
      { data: { markdown: "可见", isFinished: true } },
    ]);
    const a = bubble();
    await readNativeReply(
      "anthropic-messages",
      Response.json({
        content: [
          { type: "thinking", thinking: "摘要", signature: "private" },
          { type: "text", text: "结果" },
        ],
        stop_reason: "end_turn",
      }),
      { ...full, returnFullReasoning: false, mode: "summary" },
      a.receive,
      signal,
    );
    expect(a.segments).toMatchObject([
      { data: { text: "摘要", state: "completed" } },
      { data: { markdown: "结果", isFinished: true } },
    ]);
    const ctrl = new AbortController();
    const cancel = readNativeReply(
      "openai-chat",
      new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }),
      full,
      b.receive,
      ctrl.signal,
    );
    ctrl.abort();
    await expect(cancel).rejects.toThrow();
  });
});
