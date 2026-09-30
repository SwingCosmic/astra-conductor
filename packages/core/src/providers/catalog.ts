import { providerIds, type ProviderId } from "../models.js";
import type { ProviderDescriptor, ProviderOfferingDescriptor } from "./types.js";
import { codexDescriptor } from "./codex/descriptor.js";
import { glmDescriptor } from "./glm/descriptor.js";
import { grokBuildDescriptor } from "./grok-build/descriptor.js";
import { antigravityDescriptor } from "./antigravity/descriptor.js";

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
  }
}

const descriptors: readonly ProviderDescriptor[] = [
  codexDescriptor,
  glmDescriptor,
  grokBuildDescriptor,
  antigravityDescriptor,
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
