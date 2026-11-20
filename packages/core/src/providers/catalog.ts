import type { PublicProviderDescriptor } from "@astra-conductor/contract/common";
import { AppError } from "../errors.js";
import type { AuthMethod, ProviderId } from "../models.js";
import {
  builtInProviderDescriptors,
  builtInProviderModelPolicies,
  builtInReceiptPolicies,
  customTemplatePolicies,
} from "./contributions.js";
import {
  isCustomProviderId,
  validateOfferingRouteConfig,
  type ProviderOfferingModelPolicy,
} from "./model-policy.js";
import type {
  ProviderCapability,
  ProviderDescriptor,
  ProviderOfferingDescriptor,
  ProviderPlanDescriptor,
} from "./types.js";

/** Unmatched or unpublished plans use the mid 5x rung. */
export const DEFAULT_PLAN_MULTIPLIER = 5;

export const providerCapabilities: readonly ProviderCapability[] = [
  "account",
  "usage",
  "model-catalog",
  "inference",
  "multiple-accounts",
];

const identifierPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function normalizePlanMatch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string): boolean {
  if (!isoDatePattern.test(value)) return false;
  // V8 rolls out-of-range dates like 2026-02-30 into March; verify round-trip equality.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isHttpUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:" || new URL(value).protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Probe strings rejecting catch-all regex patterns (e.g. `/^/`, `/./`) that would swallow
 * every unrecognized tier.
 */
const regexProbeStrings = ["a", "ab", "0", "x y"] as const;

function isMatchAllRegex(pattern: RegExp): boolean {
  if (pattern.test("")) return true;
  return regexProbeStrings.every((probe) => pattern.test(probe));
}

function validatePlans(
  offering: ProviderOfferingDescriptor,
  plans: readonly ProviderPlanDescriptor[],
): void {
  const seenPlanKeys = new Set<string>();
  const seenPlanMatches = new Set<string>();
  for (const plan of plans) {
    if (!identifierPattern.test(plan.key)) {
      throw new Error(`Provider catalog has invalid plan key: ${offering.id}/${plan.key}`);
    }
    if (seenPlanKeys.has(plan.key)) {
      throw new Error(`Provider catalog declares duplicate plan: ${offering.id}/${plan.key}`);
    }
    seenPlanKeys.add(plan.key);
    if (!plan.displayName.trim()) {
      throw new Error(`Provider catalog has empty plan name: ${offering.id}/${plan.key}`);
    }
    if (!Number.isFinite(plan.multiplier) || plan.multiplier <= 0) {
      throw new Error(`Provider catalog has invalid plan multiplier: ${offering.id}/${plan.key}`);
    }
    if (plan.source !== "published" && plan.source !== "inferred") {
      throw new Error(`Provider catalog has invalid plan source: ${offering.id}/${plan.key}`);
    }
    if (plan.legacyUntil !== undefined) {
      if (plan.legacy !== true) {
        throw new Error(
          `Provider catalog plan sets legacyUntil without legacy: ${offering.id}/${plan.key}`,
        );
      }
      if (!isIsoDate(plan.legacyUntil)) {
        throw new Error(
          `Provider catalog plan has invalid legacyUntil date: ${offering.id}/${plan.key}`,
        );
      }
    }
    if (plan.sourceUrl !== undefined && !isHttpUrl(plan.sourceUrl)) {
      throw new Error(`Provider catalog plan has invalid sourceUrl: ${offering.id}/${plan.key}`);
    }
    if (plan.verifiedAt !== undefined && !isIsoDate(plan.verifiedAt)) {
      throw new Error(
        `Provider catalog plan has invalid verifiedAt date: ${offering.id}/${plan.key}`,
      );
    }
    if (!plan.match.length) {
      throw new Error(`Provider catalog plan has no match keys: ${offering.id}/${plan.key}`);
    }
    for (const raw of plan.match) {
      if (raw instanceof RegExp) {
        if (isMatchAllRegex(raw)) {
          throw new Error(
            `Provider catalog plan has a match-all regex key: ${offering.id}/${plan.key}`,
          );
        }
        continue;
      }
      const key = normalizePlanMatch(raw);
      if (!key) {
        throw new Error(`Provider catalog plan has empty match key: ${offering.id}/${plan.key}`);
      }
      if (seenPlanMatches.has(key)) {
        throw new Error(`Provider catalog declares duplicate plan match: ${offering.id}/${key}`);
      }
      seenPlanMatches.add(key);
    }
  }
}

export function validateProviderCatalog(descriptors: readonly ProviderDescriptor[]): void {
  const seenProviders = new Set<string>();
  const seenOfferings = new Set<string>();
  for (const descriptor of descriptors) {
    if (!identifierPattern.test(descriptor.provider)) {
      throw new Error(`Provider catalog declares invalid provider id: ${descriptor.provider}`);
    }
    if (seenProviders.has(descriptor.provider)) {
      throw new Error(`Provider catalog declares duplicate provider: ${descriptor.provider}`);
    }
    seenProviders.add(descriptor.provider);
    if (!descriptor.offerings.length) {
      throw new Error(`Provider catalog has no offerings: ${descriptor.provider}`);
    }
    for (const capability of descriptor.capabilities) {
      if (!providerCapabilities.includes(capability)) {
        throw new Error(`Provider catalog declares unknown capability: ${capability}`);
      }
    }
    for (const offering of descriptor.offerings) {
      if (offering.provider !== descriptor.provider) {
        throw new Error(
          `Offering ${offering.id} is owned by ${offering.provider}, not ${descriptor.provider}`,
        );
      }
      if (!identifierPattern.test(offering.id)) {
        throw new Error(`Provider catalog has invalid offering id: ${offering.id}`);
      }
      if (seenOfferings.has(offering.id)) {
        throw new Error(`Provider catalog declares duplicate offering: ${offering.id}`);
      }
      seenOfferings.add(offering.id);
      if (offering.iconKey !== undefined && !identifierPattern.test(offering.iconKey)) {
        throw new Error(
          `Provider catalog has invalid icon key: ${offering.id}/${offering.iconKey}`,
        );
      }
      if (offering.routeConfig !== undefined) {
        validateOfferingRouteConfig(offering.id, offering.routeConfig);
      }
      const seenMethods = new Set<string>();
      for (const method of offering.authMethods) {
        if (!identifierPattern.test(method.method)) {
          throw new Error(
            `Offering ${offering.id} declares invalid auth method id: ${method.method}`,
          );
        }
        if (seenMethods.has(method.method)) {
          throw new Error(`Offering ${offering.id} declares duplicate method: ${method.method}`);
        }
        seenMethods.add(method.method);
        if (
          method.sourcePathHint !== undefined &&
          (typeof method.sourcePathHint !== "string" || !method.sourcePathHint.trim())
        ) {
          throw new Error(`Offering ${offering.id} has invalid source path hint`);
        }
      }
      validatePlans(offering, offering.plans);
    }
  }
}

validateProviderCatalog(builtInProviderDescriptors);

export const providerCatalog: readonly ProviderDescriptor[] = builtInProviderDescriptors;

export const providerIds: readonly ProviderId[] = providerCatalog.map(
  (descriptor) => descriptor.provider,
);

export const authMethods: readonly AuthMethod[] = [
  ...new Set(
    providerCatalog.flatMap((descriptor) =>
      descriptor.offerings.flatMap((offering) =>
        offering.authMethods.map((method) => method.method),
      ),
    ),
  ),
];

export function getProviderDescriptor(provider: ProviderId): ProviderDescriptor {
  const descriptor = providerCatalog.find((item) => item.provider === provider);
  if (!descriptor) throw new Error(`Provider is not registered in catalog: ${provider}`);
  return descriptor;
}

export function findOffering(
  offeringId: string,
): { provider: ProviderId; offering: ProviderOfferingDescriptor } | null {
  for (const descriptor of providerCatalog) {
    const offering = descriptor.offerings.find((item) => item.id === offeringId);
    if (offering) return { provider: descriptor.provider, offering };
  }
  return null;
}

export function isLocalKeyAccount(
  account: { provider: string; offeringId: string; authMethod: string },
  lookupOffering: (
    offeringId: string,
  ) => { provider: ProviderId; offering: ProviderOfferingDescriptor } | null = findOffering,
): boolean {
  if (account.authMethod !== "api-key") return false;
  if (isCustomProviderId(account.provider)) return true;
  const found = lookupOffering(account.offeringId);
  return Boolean(
    found &&
      found.provider === account.provider &&
      found.offering.supportsSubscriptionUsage === false &&
      found.offering.routeConfig !== undefined,
  );
}

export function toPublicProviderDescriptor(
  descriptor: ProviderDescriptor,
): PublicProviderDescriptor {
  return {
    provider: descriptor.provider,
    displayName: descriptor.displayName,
    offerings: descriptor.offerings.map((offering) => {
      const connectionKind =
        offering.connectionKind ??
        (offering.supportsSubscriptionUsage === false && offering.routeConfig
          ? offering.routeConfig.mode === "editable"
            ? "editable-routes"
            : "fixed-routes"
          : undefined);
      return {
        id: offering.id,
        ...(connectionKind ? { connectionKind } : {}),
        ...(offering.routeConfig ? { routeConfig: offering.routeConfig } : {}),
        provider: offering.provider,
        displayName: offering.displayName,
        ...(offering.description ? { description: offering.description } : {}),
        ...(offering.websiteUrl ? { websiteUrl: offering.websiteUrl } : {}),
        ...(offering.iconKey ? { iconKey: offering.iconKey } : {}),
        authMethods: offering.authMethods.map((method) => ({
          method: method.method,
          interaction: method.interaction,
          ...(method.sourceLabel ? { sourceLabel: method.sourceLabel } : {}),
          ...(method.sourcePathHint ? { sourcePathHint: method.sourcePathHint } : {}),
        })),
        plans: offering.plans.map(({ key, displayName }) => ({ key, displayName })),
      };
    }),
  };
}

export function resolveBuiltInModelPolicy(binding: {
  providerId: string;
  offeringId: string;
  templateKind?: "generic" | "new-api";
}): ProviderOfferingModelPolicy {
  if (isCustomProviderId(binding.providerId)) {
    const kind = binding.templateKind ?? "generic";
    const template = Object.hasOwn(customTemplatePolicies, kind)
      ? customTemplatePolicies[kind]
      : undefined;
    if (!template) {
      throw new AppError("capability-unavailable", `未注册的自定义供应商模板策略：${String(kind)}`);
    }
    return template;
  }
  const policy = builtInProviderModelPolicies.get(`${binding.providerId}\0${binding.offeringId}`);
  if (!policy) {
    throw new AppError(
      "capability-unavailable",
      `未注册的模型策略：${binding.providerId}/${binding.offeringId}`,
    );
  }
  return policy;
}

export function getBuiltInModelPolicy(binding: {
  providerId: string;
  offeringId: string;
  templateKind?: "generic" | "new-api";
}): ProviderOfferingModelPolicy | null {
  try {
    return resolveBuiltInModelPolicy(binding);
  } catch {
    return null;
  }
}

export function getBuiltInReceiptPolicies(): readonly ProviderOfferingModelPolicy[] {
  return builtInReceiptPolicies;
}

export function matchOfferingPlan(
  offeringId: string,
  plan: string | null | undefined,
): ProviderPlanDescriptor | null {
  if (typeof plan !== "string") return null;
  const found = findOffering(offeringId);
  if (!found) return null;
  const key = normalizePlanMatch(plan);
  if (!key) return null;
  for (const item of found.offering.plans) {
    for (const candidate of item.match) {
      if (typeof candidate === "string" && normalizePlanMatch(candidate) === key) return item;
    }
  }
  for (const item of found.offering.plans) {
    for (const candidate of item.match) {
      if (candidate instanceof RegExp && candidate.test(key)) return item;
    }
  }
  return null;
}

export function planMultiplier(offeringId: string, plan: string | null | undefined): number {
  return matchOfferingPlan(offeringId, plan)?.multiplier ?? DEFAULT_PLAN_MULTIPLIER;
}
