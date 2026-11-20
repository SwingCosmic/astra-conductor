import type { MessageSegment } from "@lovekicher/omnichat/types/types/message.js";
import type { ReplyDelta } from "../services/native-chat-reply.js";

export type ActivityState = "running" | "completed" | "failed" | "cancelled";
export interface Activity {
  kind: "reasoning";
  state: ActivityState;
  text: string;
}
declare module "@lovekicher/omnichat/types/types/message.js" {
  interface MessageDataTypeMap {
    "ai-activity": Activity;
  }
}

// OmniChat's AI example uses stable segment IDs to retain expansion state during updates.
export function appendDelta(content: MessageSegment[], event: ReplyDelta): MessageSegment[] {
  const next = [...content];
  const i = next.findIndex((s) => s.id === event.key);
  const old = next[i];
  const segment: MessageSegment =
    event.kind === "text"
      ? {
          id: event.key,
          type: "stream",
          data: {
            markdown: (old?.type === "stream" ? old.data.markdown : "") + event.delta,
            isFinished: !!event.done,
          },
        }
      : {
          id: event.key,
          type: "ai-activity",
          data: {
            kind: "reasoning",
            state: event.done ? "completed" : "running",
            text: (old?.type === "ai-activity" ? old.data.text : "") + event.delta,
          },
        };
  if (i >= 0) next[i] = segment;
  else {
    const last = next.at(-1);
    if (last?.type === "ai-activity" && last.data.state === "running")
      next[next.length - 1] = { ...last, data: { ...last.data, state: "completed" } };
    next.push(segment);
  }
  return next;
}
export function finishContent(content: MessageSegment[], state: ActivityState): MessageSegment[] {
  return content.map((segment) => {
    if (segment.type === "stream")
      return { ...segment, data: { ...segment.data, isFinished: true } };
    if (segment.type === "ai-activity" && segment.data.state === "running")
      return { ...segment, data: { ...segment.data, state } };
    return segment;
  });
}
