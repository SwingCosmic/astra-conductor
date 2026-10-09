/**
 * PolyQuota's host-decoupled Claude OAuth usage leaf, selected from OmniRoute's
 * `open-sse/services/usage/claude.ts` at the pinned source commit.
 */

import { z } from "zod";
import {
  getClaudeCodeClientVersion,
  getClaudeCodeUserAgent,
} from "@omniroute/src/shared/constants/claudeCodeClient.ts";

type JsonRecord = Record<string, unknown>;

const usageWindowSchema = z.object({
  utilization: z.number().finite().min(0).max(100),
  resets_at: z.string().nullable().optional(),
});

const fableLimitSchema = z.object({
  kind: z.literal("weekly_scoped"),
  percent: z.number().finite().min(0).max(100),
  resets_at: z.string().nullable().optional(),
  scope: z.object({ model: z.object({ display_name: z.literal("Fable") }) }),
});

export interface ClaudeBootstrap {
  accountUuid: string | null;
  accountEmail: string | null;
  organizationUuid: string | null;
  organizationName: string | null;
  organizationType: string | null;
  rateLimitTier: string | null;
}

export interface ClaudeUsageQuota {
  used: number;
  total: number;
  remaining: number;
  remainingPercentage: number;
  resetAt: string | null;
  unlimited: false;
  displayName: string;
}

export type ClaudeUsageResult =
  | {
      plan: string | null;
      quotas: Record<string, ClaudeUsageQuota>;
      modelQuotas: Record<string, ClaudeUsageQuota>;
      bootstrap: ClaudeBootstrap | null;
    }
  | { message: string; status: number | null; bootstrap: ClaudeBootstrap | null };

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const result = stringValue(value);
    if (result && result.toLowerCase() !== "claude code" && result.toLowerCase() !== "unknown") {
      return result;
    }
  }
  return null;
}

function resetTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function quota(
  value: z.infer<typeof usageWindowSchema>,
  displayName: string,
): ClaudeUsageQuota {
  const remaining = Math.max(0, 100 - value.utilization);
  return {
    used: value.utilization,
    total: 100,
    remaining,
    remainingPercentage: remaining,
    resetAt: resetTime(value.resets_at),
    unlimited: false,
    displayName,
  };
}

function bootstrapRecord(value: unknown): ClaudeBootstrap | null {
  const body = toRecord(value);
  const account = Object.keys(toRecord(body.oauth_account)).length
    ? toRecord(body.oauth_account)
    : body;
  const result: ClaudeBootstrap = {
    accountUuid: stringValue(account.account_uuid),
    accountEmail: stringValue(account.account_email),
    organizationUuid: stringValue(account.organization_uuid),
    organizationName: stringValue(account.organization_name),
    organizationType: stringValue(account.organization_type),
    rateLimitTier: firstString(account.organization_rate_limit_tier, account.rate_limit_tier),
  };
  return Object.values(result).some((item) => item !== null) ? result : null;
}

function requestHeaders(accessToken: string, userAgent: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": userAgent,
    "anthropic-beta": "oauth-2025-04-20",
  };
}

export async function fetchClaudeBootstrap(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaudeBootstrap | null> {
  try {
    const response = await fetchImpl("https://api.anthropic.com/api/claude_cli/bootstrap", {
      method: "GET",
      headers: requestHeaders(accessToken, getClaudeCodeUserAgent("cli")),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? bootstrapRecord(await response.json()) : null;
  } catch {
    return null;
  }
}

export async function getClaudeUsage(
  accessToken?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaudeUsageResult> {
  if (!accessToken) {
    return { message: "Claude access token not available", status: null, bootstrap: null };
  }
  const bootstrapPromise = fetchClaudeBootstrap(accessToken, fetchImpl);
  try {
    const response = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: requestHeaders(accessToken, `claude-code/${getClaudeCodeClientVersion()}`),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return {
        message: `Claude usage endpoint returned ${response.status}`,
        status: response.status,
        bootstrap: await bootstrapPromise,
      };
    }

    const data = toRecord(await response.json());
    const quotas: Record<string, ClaudeUsageQuota> = {};
    const fiveHour = usageWindowSchema.safeParse(data.five_hour);
    if (fiveHour.success) quotas.session = quota(fiveHour.data, "5-hour");
    const sevenDay = usageWindowSchema.safeParse(data.seven_day);
    if (sevenDay.success) quotas.weekly = quota(sevenDay.data, "Weekly");
    for (const [key, value] of Object.entries(data)) {
      if (!key.startsWith("seven_day_") || key === "seven_day") continue;
      const parsed = usageWindowSchema.safeParse(value);
      if (!parsed.success) continue;
      const model = key.slice("seven_day_".length).replaceAll("_", " ");
      quotas[`weekly-${model}`] = quota(parsed.data, `Weekly ${model}`);
    }

    const modelQuotas: Record<string, ClaudeUsageQuota> = {};
    for (const value of Array.isArray(data.limits) ? data.limits : []) {
      const parsed = fableLimitSchema.safeParse(value);
      if (!parsed.success) continue;
      modelQuotas["weekly-fable"] = quota(
        { utilization: parsed.data.percent, resets_at: parsed.data.resets_at },
        "Weekly Fable",
      );
    }
    if (!Object.keys(quotas).length && !Object.keys(modelQuotas).length) {
      return {
        message: "Claude usage response did not contain supported quota windows",
        status: response.status,
        bootstrap: await bootstrapPromise,
      };
    }

    const bootstrap = await bootstrapPromise;
    return {
      plan: firstString(
        data.tier,
        data.plan,
        data.subscription_type,
        bootstrap?.rateLimitTier,
      ),
      quotas,
      modelQuotas,
      bootstrap,
    };
  } catch (error) {
    return {
      message: `Claude usage request failed: ${(error as Error).message}`,
      status: null,
      bootstrap: await bootstrapPromise,
    };
  }
}
