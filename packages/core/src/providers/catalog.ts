import type { AuthMethod, ProviderId } from "../models.js";
import type {
  ProviderCapability,
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
import { githubCopilotDescriptor } from "./github-copilot/descriptor.js";

/** Unmatched or unpublished plans use the mid 5x rung. */
export const DEFAULT_PLAN_MULTIPLIER = 5;

const capabilityIds: readonly ProviderCapability[] = [
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
  // V8 会把 2026-02-30 这类越界日期滚动成 3 月，必须按往返一致判合法性。
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
 * 目录正则的防御探测串：一条同时命中全部探测串（外加空串）的正则等价于
 * "吞掉一切未识别档位"的全匹配模式（如 `/^/`、`/./`），目录校验直接拒绝。
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
  const seenPlanIds = new Set<string>();
  const seenPlanMatches = new Set<string>();
  for (const plan of plans) {
    if (!identifierPattern.test(plan.id)) {
      throw new Error(`Provider catalog has invalid plan id: ${offering.id}/${plan.id}`);
    }
    if (seenPlanIds.has(plan.id)) {
      throw new Error(`Provider catalog declares duplicate plan: ${offering.id}/${plan.id}`);
    }
    seenPlanIds.add(plan.id);
    if (!plan.displayName.trim()) {
      throw new Error(`Provider catalog has empty plan name: ${offering.id}/${plan.id}`);
    }
    if (!Number.isFinite(plan.multiplier) || plan.multiplier <= 0) {
      throw new Error(`Provider catalog has invalid plan multiplier: ${offering.id}/${plan.id}`);
    }
    if (plan.source !== "published" && plan.source !== "inferred") {
      throw new Error(`Provider catalog has invalid plan source: ${offering.id}/${plan.id}`);
    }
    if (plan.legacyUntil !== undefined) {
      if (plan.legacy !== true) {
        throw new Error(
          `Provider catalog plan sets legacyUntil without legacy: ${offering.id}/${plan.id}`,
        );
      }
      if (!isIsoDate(plan.legacyUntil)) {
        throw new Error(
          `Provider catalog plan has invalid legacyUntil date: ${offering.id}/${plan.id}`,
        );
      }
    }
    if (plan.sourceUrl !== undefined && !isHttpUrl(plan.sourceUrl)) {
      throw new Error(`Provider catalog plan has invalid sourceUrl: ${offering.id}/${plan.id}`);
    }
    if (plan.verifiedAt !== undefined && !isIsoDate(plan.verifiedAt)) {
      throw new Error(
        `Provider catalog plan has invalid verifiedAt date: ${offering.id}/${plan.id}`,
      );
    }
    if (!plan.match.length) {
      throw new Error(`Provider catalog plan has no match keys: ${offering.id}/${plan.id}`);
    }
    for (const raw of plan.match) {
      if (raw instanceof RegExp) {
        // 正则之间的重叠无法静态判定，靠求值顺序（先精确后正则）与用例约束；
        // 这里只拒绝会吞掉一切的兜底模式。
        if (isMatchAllRegex(raw)) {
          throw new Error(
            `Provider catalog plan has a match-all regex key: ${offering.id}/${plan.id}`,
          );
        }
        continue;
      }
      const key = normalizePlanMatch(raw);
      if (!key) {
        throw new Error(`Provider catalog plan has empty match key: ${offering.id}/${plan.id}`);
      }
      if (seenPlanMatches.has(key)) {
        throw new Error(`Provider catalog declares duplicate plan match: ${offering.id}/${key}`);
      }
      seenPlanMatches.add(key);
    }
  }
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
      if (!capabilityIds.includes(capability)) {
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

const descriptors: readonly ProviderDescriptor[] = [
  codexDescriptor,
  glmDescriptor,
  grokBuildDescriptor,
  antigravityDescriptor,
  claudeDescriptor,
  opencodeGoDescriptor,
  githubCopilotDescriptor,
];

validateProviderCatalog(descriptors);

export const providerCatalog: readonly ProviderDescriptor[] = descriptors;

/**
 * 单源反转：供应商与认证方式的已知集合从注册 descriptors 收集导出，不再由
 * 契约包词表供源。新增供应商 / 认证方式只登记 descriptor，这里自动跟上；
 * 运行期"已知供应商 / 该接入点支持哪些认证方式"的检测一律以目录内容为准。
 */
export const providerIds: readonly ProviderId[] = descriptors.map(
  (descriptor) => descriptor.provider,
);

export const authMethods: readonly AuthMethod[] = [
  ...new Set(
    descriptors.flatMap((descriptor) =>
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

/**
 * 套餐查表键是接入点：同一服务商的不同接入点计费目录可以不同。求值顺序
 * 先精确后正则：先按声明顺序扫全部条目的字符串键做全词精确匹配（与历史
 * 行为逐位一致），全部未中再按条目声明顺序试正则（作用于规范化小写串，
 * 纯兜底能力——宽泛模式抢不走精确命中）。
 */
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
