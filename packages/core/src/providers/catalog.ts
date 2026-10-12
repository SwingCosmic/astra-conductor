import { providerIds, type ProviderId } from "../models.js";
import type {
  ProviderDescriptor,
  ProviderOfferingDescriptor,
  ProviderPlanDescriptor,
} from "./types.js";
import { codexDescriptor } from "./codex/descriptor.js";
import { glmDescriptor } from "./glm/descriptor.js";
import { grokBuildDescriptor } from "./grok-build/descriptor.js";
import { antigravityDescriptor } from "./antigravity/descriptor.js";
import { claudeDescriptor } from "./claude/descriptor.js";
import { opencodeGoDescriptor } from "./opencode-go/descriptor.js";

/** Unmatched or unpublished plans use the mid 5x rung. */
export const DEFAULT_PLAN_MULTIPLIER = 5;

export function normalizePlanMatch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

/**
 * 收集全部供应商对外暴露的能力声明。这是唯一的目录端点：新增供应商时在
 * `providers/<id>/descriptor.ts` 声明并在此登记，前端通过快照的
 * `providers` 字段消费，不需要在各处新增分支。
 */
export function validateProviderCatalog(descriptors: readonly ProviderDescriptor[]): void {
  const seenProviders = new Set<string>();
  const seenOfferings = new Set<string>();
  for (const descriptor of descriptors) {
    if (!providerIds.includes(descriptor.provider)) {
      throw new Error(`Provider catalog declares unknown provider: ${descriptor.provider}`);
    }
    if (seenProviders.has(descriptor.provider)) {
      throw new Error(`Provider catalog declares duplicate provider: ${descriptor.provider}`);
    }
    seenProviders.add(descriptor.provider);
    if (!descriptor.offerings.length) {
      throw new Error(`Provider catalog has no offerings: ${descriptor.provider}`);
    }
    for (const offering of descriptor.offerings) {
      if (offering.provider !== descriptor.provider) {
        throw new Error(
          `Offering ${offering.id} is owned by ${offering.provider}, not ${descriptor.provider}`,
        );
      }
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(offering.id)) {
        throw new Error(`Provider catalog has invalid offering id: ${offering.id}`);
      }
      if (seenOfferings.has(offering.id)) {
        throw new Error(`Provider catalog declares duplicate offering: ${offering.id}`);
      }
      seenOfferings.add(offering.id);
      const seenMethods = new Set<string>();
      for (const method of offering.authMethods) {
        if (seenMethods.has(method.method)) {
          throw new Error(`Offering ${offering.id} declares duplicate method: ${method.method}`);
        }
        seenMethods.add(method.method);
      }
    }
    const seenPlanIds = new Set<string>();
    const seenPlanMatches = new Set<string>();
    for (const plan of descriptor.plans) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.id)) {
        throw new Error(`Provider catalog has invalid plan id: ${descriptor.provider}/${plan.id}`);
      }
      if (seenPlanIds.has(plan.id)) {
        throw new Error(
          `Provider catalog declares duplicate plan: ${descriptor.provider}/${plan.id}`,
        );
      }
      seenPlanIds.add(plan.id);
      if (!plan.displayName.trim()) {
        throw new Error(`Provider catalog has empty plan name: ${descriptor.provider}/${plan.id}`);
      }
      if (!Number.isFinite(plan.multiplier) || plan.multiplier <= 0) {
        throw new Error(
          `Provider catalog has invalid plan multiplier: ${descriptor.provider}/${plan.id}`,
        );
      }
      if (plan.source !== "published" && plan.source !== "inferred") {
        throw new Error(
          `Provider catalog has invalid plan source: ${descriptor.provider}/${plan.id}`,
        );
      }
      if (!plan.match.length) {
        throw new Error(
          `Provider catalog plan has no match keys: ${descriptor.provider}/${plan.id}`,
        );
      }
      for (const raw of plan.match) {
        const key = normalizePlanMatch(raw);
        if (!key) {
          throw new Error(
            `Provider catalog plan has empty match key: ${descriptor.provider}/${plan.id}`,
          );
        }
        if (seenPlanMatches.has(key)) {
          throw new Error(
            `Provider catalog declares duplicate plan match: ${descriptor.provider}/${key}`,
          );
        }
        seenPlanMatches.add(key);
      }
    }
  }
}

const descriptors: readonly ProviderDescriptor[] = [
  codexDescriptor,
  glmDescriptor,
  grokBuildDescriptor,
  antigravityDescriptor,
  claudeDescriptor,
  opencodeGoDescriptor,
];

validateProviderCatalog(descriptors);

export const providerCatalog: readonly ProviderDescriptor[] = descriptors;

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

export function matchProviderPlan(
  provider: ProviderId,
  plan: string | null | undefined,
): ProviderPlanDescriptor | null {
  if (typeof plan !== "string") return null;
  const key = normalizePlanMatch(plan);
  if (!key) return null;
  for (const item of getProviderDescriptor(provider).plans) {
    if (item.match.some((candidate) => normalizePlanMatch(candidate) === key)) return item;
  }
  return null;
}

export function planMultiplier(provider: ProviderId, plan: string | null | undefined): number {
  return matchProviderPlan(provider, plan)?.multiplier ?? DEFAULT_PLAN_MULTIPLIER;
}
