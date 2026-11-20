import { AppError } from "@astra-conductor/core/internal";

const maxResponseBytes = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const unsafe = () => new AppError("upstream", "无法安全转发模型响应");

/**
 * Lightweight single-channel sliding-window text scanner for credential echo prevention.
 * Scans decoded UTF-8 text against both plaintext secrets and their JSON-escaped forms,
 * withholding at most `maxNeedleLen - 1` trailing characters across chunk boundaries.
 */
export class SecretGuard {
  private readonly needles: readonly string[];
  private readonly maxTailLen: number;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private pending = "";

  constructor(secrets: readonly string[]) {
    const needles: string[] = [];
    const seen = new Set<string>();
    for (const secret of secrets) {
      if (!secret) continue;
      for (const form of [secret, JSON.stringify(secret).slice(1, -1)]) {
        if (form && !seen.has(form)) {
          seen.add(form);
          needles.push(form);
        }
      }
    }
    this.needles = needles;
    this.maxTailLen = needles.length ? Math.max(...needles.map((n) => n.length)) - 1 : 0;
  }

  private assertSafe(text: string): void {
    for (const needle of this.needles) {
      if (text.includes(needle)) throw unsafe();
    }
  }

  private holdLength(text: string): number {
    const limit = Math.min(text.length, this.maxTailLen);
    for (let len = limit; len > 0; len--) {
      const suffix = text.slice(text.length - len);
      if (this.needles.some((needle) => needle.startsWith(suffix))) return len;
    }
    return 0;
  }

  push(bytes: Uint8Array): string {
    let decoded: string;
    try {
      decoded = this.decoder.decode(bytes, { stream: true });
    } catch {
      throw unsafe();
    }
    if (!decoded) return "";
    const combined = this.pending + decoded;
    this.assertSafe(combined);
    const hold = this.holdLength(combined);
    if (hold === 0) {
      this.pending = "";
      return combined;
    }
    let safeLen = combined.length - hold;
    if (
      safeLen > 0 &&
      combined.charCodeAt(safeLen - 1) >= 0xd800 &&
      combined.charCodeAt(safeLen - 1) <= 0xdbff
    ) {
      safeLen -= 1;
    }
    this.pending = combined.slice(safeLen);
    return combined.slice(0, safeLen);
  }

  flush(): string {
    let tail: string;
    try {
      tail = this.decoder.decode();
    } catch {
      throw unsafe();
    }
    const combined = this.pending + tail;
    this.pending = "";
    if (!combined) return "";
    this.assertSafe(combined);
    return combined;
  }
}

/**
 * Read-only SSE usage/receipt observer. Never withholds, alters, or rejects protocol frames;
 * only parses frames that carry usage, billing, or initial response identity signals.
 */
class SseUsageObserver {
  private buffer = "";

  constructor(private readonly observe: (value: unknown) => void) {}

  push(text: string): void {
    this.buffer += text;
    const frames = this.buffer.split(/\r?\n\r?\n|\r\r/);
    this.buffer = frames.pop() ?? "";
    for (const frame of frames) this.inspectFrame(frame);
  }

  flush(): void {
    if (this.buffer) {
      this.inspectFrame(this.buffer);
      this.buffer = "";
    }
  }

  private inspectFrame(frame: string): void {
    const data = frame
      .replace(/^\uFEFF/, "")
      .split(/\r\n|\r|\n/)
      .filter((line) => line === "data" || line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      const value = JSON.parse(data);
      if (value && typeof value === "object") {
        this.observe(value);
      }
    } catch {
      /* Read-only usage observer ignores non-JSON SSE payloads. */
    }
  }
}

function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw unsafe();
  }
}

/** Scan upstream bytes through the sliding-window secret guard and observe metering separately. */
export async function* approvedProxyBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stream: boolean,
  secrets: string[],
  signal: AbortSignal,
  observe: (value: unknown) => void,
): AsyncGenerator<Uint8Array> {
  const guard = new SecretGuard(secrets);
  const observer = stream ? new SseUsageObserver(observe) : undefined;
  const jsonParts: string[] = [];
  let total = 0;

  for (;;) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    signal.throwIfAborted();
    if (value?.byteLength) {
      total += value.byteLength;
      if (total > maxResponseBytes) throw new AppError("upstream", "模型响应超过读取上限");
      const safe = guard.push(value);
      if (safe) {
        if (stream) {
          observer!.push(safe);
          yield encoder.encode(safe);
        } else {
          jsonParts.push(safe);
        }
      }
    }
    if (done) break;
  }

  const tail = guard.flush();
  if (stream) {
    if (tail) {
      observer!.push(tail);
      yield encoder.encode(tail);
    }
    observer!.flush();
    return;
  }

  if (tail) jsonParts.push(tail);
  const fullText = jsonParts.join("");
  const parsed = decodeJson(fullText.replace(/^\uFEFF/, ""));
  observe(parsed);
  yield encoder.encode(fullText);
}
