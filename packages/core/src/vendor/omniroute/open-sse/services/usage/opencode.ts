/**
 * Host-decoupled OpenCode Go usage leaf selected from OmniRoute's
 * `opencodeQuotaFetcher.ts` and `usage/opencode.ts` at the pinned source commit.
 */

import { z } from "zod";

const usageWindowSchema = z.object({
  status: z.enum(["ok", "rate-limited"]),
  percent: z.number().finite().min(0).max(100),
  resetsAt: z.string().min(1),
});

const responseSchema = z.object({
  usage: z.object({
    rolling: usageWindowSchema,
    weekly: usageWindowSchema,
    monthly: usageWindowSchema,
  }),
});

export interface OpencodeUsageWindow {
  percentUsed: number;
  resetAt: string;
}

export type OpencodeUsageResult =
  | {
      plan: "OpenCode Go";
      session: OpencodeUsageWindow;
      weekly: OpencodeUsageWindow;
      monthly: OpencodeUsageWindow;
    }
  | { message: string; status: number | null };

function normalizeWindow(value: z.infer<typeof usageWindowSchema>): OpencodeUsageWindow | null {
  const timestamp = Date.parse(value.resetsAt);
  if (!Number.isFinite(timestamp)) return null;
  return {
    percentUsed: value.status === "rate-limited" ? 100 : value.percent,
    resetAt: new Date(timestamp).toISOString(),
  };
}

export async function getOpencodeUsage(
  apiKeyInput: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpencodeUsageResult> {
  const apiKey = apiKeyInput
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!apiKey) return { message: "OpenCode API key not available", status: null };

  try {
    const response = await fetchImpl("https://opencode.ai/zen/go/v1/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      return { message: `OpenCode usage endpoint returned ${response.status}`, status: response.status };
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { message: "OpenCode usage response is invalid", status: response.status };
    }
    const session = normalizeWindow(parsed.data.usage.rolling);
    const weekly = normalizeWindow(parsed.data.usage.weekly);
    const monthly = normalizeWindow(parsed.data.usage.monthly);
    if (!session || !weekly || !monthly) {
      return { message: "OpenCode usage reset time is invalid", status: response.status };
    }
    return { plan: "OpenCode Go", session, weekly, monthly };
  } catch (error) {
    return {
      message: `OpenCode usage request failed: ${(error as Error).message}`,
      status: null,
    };
  }
}
