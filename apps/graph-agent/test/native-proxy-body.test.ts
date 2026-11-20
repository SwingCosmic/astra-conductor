import { describe, expect, it } from "vitest";
import { approvedProxyBytes } from "../src/server/native-proxy-body.js";

const encoder = new TextEncoder();
function approved(
  parts: string[],
  stream = true,
  secrets: string[] = ["secret-key-123"],
  observe: (value: unknown) => void = () => {},
) {
  const reader = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(encoder.encode(p));
      c.close();
    },
  }).getReader();
  return approvedProxyBytes(reader, stream, secrets, new AbortController().signal, observe);
}
async function drainUntilError(stream: AsyncGenerator<Uint8Array>) {
  const emitted: Uint8Array[] = [];
  let error: unknown;
  try {
    for await (const chunk of stream) emitted.push(chunk);
  } catch (cause) {
    error = cause;
  }
  return { error, emitted: Buffer.concat(emitted).toString() };
}
describe("native proxy response boundary", () => {
  it("blocks a plaintext secret spanning chunk boundaries before emitting affected bytes", async () => {
    const safePrefix = 'data: {"choices":[{"delta":{"content":"safe-padding-0123456789"}}]}\n\n';
    const { error, emitted } = await drainUntilError(
      approved([
        safePrefix,
        'data: {"choices":[{"delta":{"content":"prefix-secr',
        'et-key-123"}}]}\n\n',
      ]),
    );
    expect(error).toBeInstanceOf(Error);
    expect(emitted).not.toContain("secr");
    expect(emitted).not.toContain("secret-key-123");
  });
  it("blocks JSON-escaped secrets in both non-streaming JSON and chunked SSE streams", async () => {
    const secretWithEscapes = 'sec"ret\\key-123';
    const escaped = JSON.stringify(secretWithEscapes).slice(1, -1);
    const jsonResult = await drainUntilError(
      approved(['{"extension":"' + escaped + '"}'], false, [secretWithEscapes]),
    );
    expect(jsonResult.error).toBeInstanceOf(Error);
    expect(jsonResult.emitted).toBe("");

    const safePrefix = 'data: {"type":"response.output_text.delta","delta":"safe-0123456789"}\n\n';
    const splitPoint = Math.floor(escaped.length / 2);
    const sseResult = await drainUntilError(
      approved(
        [
          safePrefix,
          'data: {"type":"response.output_text.delta","delta":"' + escaped.slice(0, splitPoint),
          escaped.slice(splitPoint) + '"}\n\n',
        ],
        true,
        [secretWithEscapes],
      ),
    );
    expect(sseResult.error).toBeInstanceOf(Error);
    expect(sseResult.emitted).not.toContain(escaped.slice(0, splitPoint));
    expect(sseResult.emitted).not.toContain(escaped);
  });
  it("blocks plaintext secrets in non-streaming JSON without emitting bytes", async () => {
    const result = await drainUntilError(approved(['{"content":"secret-key-123"}'], false));
    expect(result.error).toBeInstanceOf(Error);
    expect(result.emitted).toBe("");
  });
  it("releases unmatched candidate prefixes, comments, multiline and unknown frames verbatim", async () => {
    const parts = [
      ": beat\r\n\r\n",
      'data: {"choices":[{"delta":{"content":"sec"}}]}\n\n',
      'data: {"choices":[\n',
      'data: {"delta":{"content":"tion"}}]}\n\n',
      "data: [DONE]\r\n\r\n",
    ];
    const observed: unknown[] = [];
    const actual: Uint8Array[] = [];
    for await (const value of approved(parts, true, ["secret-key-123"], (v) => observed.push(v)))
      actual.push(value);
    expect(Buffer.concat(actual).toString()).toBe(parts.join(""));
    expect(observed).toHaveLength(2);
  });
});
