export interface ServerEvent {
  type: string;
  data: string;
}

/** Incremental UTF-8/SSE decoding, including CRLF, comments and multiline data. */
export async function readEventStream(
  response: Response,
  receive: (event: ServerEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("text/event-stream") ||
    !response.body
  )
    throw new Error("无法连接事件流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let type = "message";
  let data: string[] = [];
  let frameSize = 0;
  const line = (value: string): void => {
    if (!value) {
      if (data.length) receive({ type, data: data.join("\n") });
      type = "message";
      data = [];
      frameSize = 0;
      return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const key = colon < 0 ? value : value.slice(0, colon);
    const field = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
    if (key === "event") type = field;
    if (key === "data") {
      frameSize += field.length;
      if (frameSize > 1_048_576) throw new Error("事件流消息过大");
      data.push(field);
    }
  };
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1_048_576) throw new Error("事件流消息过大");
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        // A trailing CR may be the first half of CRLF in the next chunk.
        if (!done && match[0] === "\r" && match.index === buffer.length - 1) break;
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (done) break;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
