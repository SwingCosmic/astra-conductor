import { AppError } from "../errors.js";

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
