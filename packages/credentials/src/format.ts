import { createHash } from "node:crypto";

export class BrokerError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function requireValue(condition: unknown, code = "invalid-broker-data"): asserts condition {
  if (!condition) throw new BrokerError(code);
}
export function object(value: unknown, keys?: string[]): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  if (keys)
    requireValue(
      Object.keys(record).length === keys.length && keys.every((k) => Object.hasOwn(record, k)),
    );
  return record;
}
export function text(value: unknown): string {
  requireValue(
    typeof value === "string" &&
      ![...value].some((char) => {
        const point = char.codePointAt(0)!;
        return point >= 0xd800 && point <= 0xdfff;
      }),
  );
  return value;
}
export function id(value: unknown): string {
  const result = text(value);
  requireValue(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(result));
  return result;
}
export function unb64(value: unknown, size?: number): Buffer {
  const encoded = text(value);
  requireValue(/^[A-Za-z0-9_-]*$/.test(encoded) && encoded.length <= 2_796_203);
  const bytes = Buffer.from(encoded, "base64url");
  requireValue(
    bytes.toString("base64url") === encoded && (size === undefined || bytes.length === size),
  );
  return bytes;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(text(value));
  if (typeof value === "number") {
    requireValue(Number.isSafeInteger(value));
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = object(value);
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${canonical(k)}:${canonical(record[k])}`)
    .join(",")}}`;
}
export function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("base64url");
}
/** Bounded JSON decoder: reject duplicate keys before authenticated data is interpreted. */
export function parseJson(bytes: Uint8Array): unknown {
  requireValue(bytes.length <= 2 * 1024 * 1024, "message-too-large");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let position = 0;
  const whitespace = () => {
    while (/[\t\r\n ]/.test(source[position] ?? "x")) position++;
  };
  const string = (): string => {
    const start = position++;
    while (position < source.length) {
      const char = source[position++];
      if (char === "\\") position++;
      else if (char === '"') return text(JSON.parse(source.slice(start, position)));
    }
    throw new BrokerError("invalid-json");
  };
  const read = (depth: number): unknown => {
    requireValue(depth <= 32, "message-too-deep");
    whitespace();
    const char = source[position];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      position++;
      whitespace();
      const end = char === "{" ? "}" : "]";
      const keys = new Set<string>();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const list: unknown[] = [];
      if (source[position] !== end)
        for (;;) {
          if (char === "{") {
            requireValue(source[position] === '"', "invalid-json");
            const key = string();
            requireValue(!keys.has(key), "duplicate-property");
            keys.add(key);
            whitespace();
            requireValue(source[position++] === ":", "invalid-json");
            result[key] = read(depth + 1);
          } else list.push(read(depth + 1));
          whitespace();
          if (source[position] !== ",") break;
          position++;
          whitespace();
        }
      requireValue(source[position++] === end, "invalid-json");
      return char === "{" ? result : list;
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(position),
    );
    requireValue(match, "invalid-json");
    position += match[0].length;
    const result: unknown = JSON.parse(match[0]);
    if (typeof result === "number")
      requireValue(Number.isSafeInteger(result), "noncanonical-number");
    return result;
  };
  const result = read(0);
  whitespace();
  requireValue(position === source.length, "invalid-json");
  return result;
}
