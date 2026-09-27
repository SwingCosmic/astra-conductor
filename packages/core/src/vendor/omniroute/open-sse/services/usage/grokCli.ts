import { z } from "zod";
import {
  GROK_BUILD_PROXY_BASE_URL,
  getGrokBuildModelsHeaders,
} from "../../config/grokBuild.ts";
import { fetchGrokResetCredits } from "../grokResetCredits.ts";

const MAX_RESPONSE_BYTES = 256 * 1024;
const optionalText = z.string().trim().min(1).max(256).optional().nullable().catch(undefined);
const optionalPercent = z.number().finite().min(0).max(100).optional().nullable().catch(undefined);
const cents = z
  .object({ val: z.number().finite().int().safe().optional() })
  .passthrough()
  .transform(({ val }) => Math.abs(val ?? 0));
const userSchema = z
  .object({ userId: optionalText, subscriptionTier: optionalText })
  .passthrough();
const productSchema = z
  .object({ product: z.string().trim().min(1).max(128), usagePercent: optionalPercent })
  .passthrough();
const billingSchema = z
  .object({
    config: z
      .object({
        creditUsagePercent: optionalPercent,
        currentPeriod: z
          .object({ end: optionalText })
          .passthrough()
          .optional()
          .nullable()
          .catch(undefined),
        productUsage: z.array(productSchema).max(100).optional().nullable().catch(undefined),
        prepaidBalance: cents.optional().nullable().catch(undefined),
      })
      .passthrough()
      .optional()
      .nullable()
      .catch(undefined),
  })
  .passthrough();
const autoTopUpSchema = z
  .object({ rule: z.object({ enabled: z.boolean().optional() }).passthrough().optional().nullable() })
  .passthrough();

async function boundedJson<T>(response: Response, schema: z.ZodType<T>): Promise<T | null> {
  if (!response.ok) return null;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) return null;
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

async function get<T>(
  path: string,
  headers: Record<string, string>,
  schema: z.ZodType<T>,
  fetchImpl: typeof fetch,
): Promise<T | null> {
  try {
    const response = await fetchImpl(`${GROK_BUILD_PROXY_BASE_URL}${path}`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return boundedJson(response, schema);
  } catch {
    return null;
  }
}

function productKey(name: string): string {
  const compact = name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact === "grokbuild" || compact === "productgrokbuild") return "grok_build";
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

export async function getGrokCliUsage(
  accessToken: string | undefined,
  identity: {
    userId?: string | null;
    email?: string | null;
    principalType?: string | null;
  } = {},
  fetchImpl: typeof fetch = fetch,
) {
  if (!accessToken) return { message: "Grok Build usage unavailable" } as const;
  const baseHeaders = getGrokBuildModelsHeaders({ token: accessToken, ...identity });
  const user = await get("/user?include=subscription", baseHeaders, userSchema, fetchImpl);
  const userId = user?.userId ?? identity.userId ?? null;
  const headers = getGrokBuildModelsHeaders({ token: accessToken, ...identity, userId });
  const [billing, resetCredits] = await Promise.all([
    get("/billing?format=credits", headers, billingSchema, fetchImpl),
    fetchGrokResetCredits(accessToken, fetchImpl),
  ]);
  if (!billing?.config) {
    return {
      ...(user?.subscriptionTier ? { plan: user.subscriptionTier } : {}),
      message: "Grok Build billing status unavailable",
    } as const;
  }
  const config = billing.config;
  const resetAt = config.currentPeriod?.end ?? null;
  const quotas = [
    {
      key: "weekly",
      displayName: null,
      usedPercentage: config.creditUsagePercent ?? 0,
      resetAt,
    },
    ...(config.productUsage ?? []).flatMap((product) =>
      product.usagePercent === undefined || product.usagePercent === null
        ? []
        : [
            {
              key: `product_${productKey(product.product)}`,
              displayName: product.product,
              usedPercentage: product.usagePercent,
              resetAt,
            },
          ],
    ),
  ];
  const autoTopUp = userId
    ? await get("/auto-topup-rule", headers, autoTopUpSchema, fetchImpl)
    : null;
  return {
    plan: user?.subscriptionTier ?? "Grok Build",
    userId,
    quotas,
    resetCredits,
    billing: {
      extraCreditsMinorUnits: config.prepaidBalance ?? null,
      autoTopUpAvailable: Boolean(autoTopUp?.rule),
      autoTopUpEnabled: autoTopUp?.rule?.enabled === true,
    },
  } as const;
}
