import { AppError } from "../errors.js";

/** Quoted prices are nonnegative decimal strings, possibly longer than double precision. */
export function decimalAmount(value: unknown): string | undefined {
  let amount =
    typeof value === "string"
      ? value
      : typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= Number.MAX_SAFE_INTEGER
        ? String(value)
        : "";
  // JSON numbers below 1e-6 are emitted in exponential notation by JS.
  if (typeof value === "number" && amount.includes("e-")) {
    const [digits, exponent] = amount.split("e-");
    if (Number(exponent) > 32) return;
    amount = "0." + "0".repeat(Number(exponent) - 1) + digits.replace(".", "");
  }
  return /^\d{1,32}(?:\.\d{1,32})?$/.test(amount) ? amount : undefined;
}

export async function readModelJson(
  response: Response,
  maxBytes: number,
  invalid: () => never,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return invalid();
  const decoder = new TextDecoder();
  let size = 0,
    body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        return invalid();
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return invalid();
  } finally {
    reader.releaseLock();
  }
}
