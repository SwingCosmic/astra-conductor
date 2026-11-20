import { AppError } from "../errors.js";
import type {
  Account,
  AuthMethod,
  CredentialEnvelope,
  ProviderId,
  ResetCreditRedemption,
  UsageSnapshot,
} from "../models.js";
import type { CredentialRefreshResult } from "../ports.js";
import type { AuthFlowStart, AuthStartOptions } from "../auth/types.js";
import type { ProviderDescriptor, ProviderOfferingDescriptor } from "./types.js";
import { validateProviderCatalog } from "./catalog.js";
import {
  PROVIDER_CONTRIBUTION_EXTRAS,
  isCustomProviderId,
  validateOfferingRouteConfig,
  type ProviderContributionExtras,
  type ProviderOfferingModelPolicy,
} from "./model-policy.js";

/**
 * Account capability facet: auth starts via offeringId; refreshCredentials is provided only
 * by implementations with an active refresh protocol.
 */
export interface ProviderAccountCapability {
  readonly providerId: ProviderId;
  /** Validated against the descriptor catalog at construction time. */
  readonly supportedMethods: readonly AuthMethod[];
  startAuth(
    offeringId: string,
    method: AuthMethod,
    options: AuthStartOptions,
  ): Promise<AuthFlowStart>;
  /** A pure preflight for usage reads. Returning true skips the broker refresh lease. */
  canUseCurrentCredentials?(account: Account, envelope: CredentialEnvelope): boolean;
  refreshCredentials?(
    account: Account,
    envelope: CredentialEnvelope,
    options: { force: boolean },
  ): Promise<CredentialRefreshResult>;
}

/**
 * Usage capability facet: resetCredits is returned alongside fetchUsage; redeemResetCard is
 * provided only by providers that support credit redemption.
 */
export interface ProviderUsageCapability {
  readonly providerId: ProviderId;
  fetchUsage(account: Account, envelope: CredentialEnvelope): Promise<UsageSnapshot>;
  redeemResetCard?(
    account: Account,
    envelope: CredentialEnvelope,
    request: ResetCreditRedemption,
  ): Promise<void>;
}

/** Descriptor, account/usage facets, and offering model policies registered together per provider. */
export interface ProviderContribution {
  descriptor: ProviderDescriptor;
  account?: ProviderAccountCapability;
  usage?: ProviderUsageCapability;
  modelPolicies?: readonly ProviderOfferingModelPolicy[];
  dispose?(): void;
}

export interface ProviderRegistryOptions {
  templatePolicies?: Readonly<Record<string, ProviderOfferingModelPolicy>>;
  receiptPolicies?: readonly ProviderOfferingModelPolicy[];
}

export interface ModelPolicyBinding {
  readonly providerId: string;
  readonly offeringId: string;
  readonly templateKind?: "generic" | "new-api";
}

const knownCapabilities = new Set([
  "account",
  "usage",
  "model-catalog",
  "inference",
  "multiple-accounts",
]);

/**
 * Strict registry: validates ownership, capability declarations, offering uniqueness,
 * routeConfig invariants, and model policies at construction time.
 * Never falls back silently on unknown providers, offerings, or templates.
 */
export class ProviderRegistry {
  readonly contributions: readonly ProviderContribution[];
  readonly descriptors: readonly ProviderDescriptor[];
  private readonly modelPolicyIndex = new Map<string, ProviderOfferingModelPolicy>();
  private readonly templatePolicyIndex = new Map<string, ProviderOfferingModelPolicy>();
  private readonly receiptPolicies: readonly ProviderOfferingModelPolicy[];

  constructor(
    contributions: readonly ProviderContribution[],
    options: ProviderRegistryOptions = {},
  ) {
    this.contributions = [...contributions];
    this.descriptors = this.contributions.map((contribution) => contribution.descriptor);
    validateProviderCatalog(this.descriptors);

    const attachedExtras = (
      contributions as readonly ProviderContribution[] & {
        [PROVIDER_CONTRIBUTION_EXTRAS]?: ProviderContributionExtras;
      }
    )[PROVIDER_CONTRIBUTION_EXTRAS];

    const rawTemplatePolicies = options.templatePolicies ?? attachedExtras?.templatePolicies ?? {};
    for (const [kind, policy] of Object.entries(rawTemplatePolicies)) {
      if (policy.routeConfig) validateOfferingRouteConfig(policy.offeringId, policy.routeConfig);
      this.templatePolicyIndex.set(kind, policy);
    }

    const rawReceiptPolicies = options.receiptPolicies ?? attachedExtras?.receiptPolicies ?? [];
    const seenReceiptIds = new Set<string>();
    for (const policy of rawReceiptPolicies) {
      if (seenReceiptIds.has(policy.offeringId)) {
        throw new Error(
          `Provider registry declares duplicate receipt policy: ${policy.offeringId}`,
        );
      }
      seenReceiptIds.add(policy.offeringId);
      if (policy.routeConfig) validateOfferingRouteConfig(policy.offeringId, policy.routeConfig);
    }
    this.receiptPolicies = [...rawReceiptPolicies];

    const byProvider = new Map<ProviderId, ProviderContribution>();
    for (const contribution of this.contributions) {
      const { descriptor, account, usage, modelPolicies } = contribution;
      const provider = descriptor.provider;
      if (account && account.providerId !== provider) {
        throw new Error(
          `Account facet of ${account.providerId} is bound to contribution ${provider}`,
        );
      }
      if (usage && usage.providerId !== provider) {
        throw new Error(`Usage facet of ${usage.providerId} is bound to contribution ${provider}`);
      }
      for (const capability of descriptor.capabilities) {
        if (!knownCapabilities.has(capability)) {
          throw new Error(`Contribution ${provider} declares unknown capability: ${capability}`);
        }
      }
      const declared = new Set(descriptor.capabilities);
      if (declared.has("account") !== Boolean(account)) {
        throw new Error(
          declared.has("account")
            ? `Contribution ${provider} declares account capability without a facet`
            : `Contribution ${provider} provides an account facet without declaring it`,
        );
      }
      if (declared.has("usage") !== Boolean(usage)) {
        throw new Error(
          declared.has("usage")
            ? `Contribution ${provider} declares usage capability without a facet`
            : `Contribution ${provider} provides a usage facet without declaring it`,
        );
      }

      const offeringById = new Map(
        descriptor.offerings.map((offering) => [offering.id, offering] as const),
      );
      const seenPolicyOfferings = new Set<string>();
      for (const policy of modelPolicies ?? []) {
        const offering = offeringById.get(policy.offeringId);
        if (!offering) {
          throw new Error(
            `Model policy ${policy.offeringId} does not match any offering of contribution ${provider}`,
          );
        }
        if (seenPolicyOfferings.has(policy.offeringId)) {
          throw new Error(
            `Contribution ${provider} declares duplicate model policy for offering: ${policy.offeringId}`,
          );
        }
        seenPolicyOfferings.add(policy.offeringId);
        if (policy.routeConfig) {
          validateOfferingRouteConfig(policy.offeringId, policy.routeConfig);
          if (
            offering.routeConfig &&
            JSON.stringify(offering.routeConfig) !== JSON.stringify(policy.routeConfig)
          ) {
            throw new Error(
              `Model policy routeConfig conflicts with offering descriptor for ${provider}/${policy.offeringId}`,
            );
          }
        }
        this.modelPolicyIndex.set(`${provider}\0${policy.offeringId}`, policy);
      }

      if (declared.has("model-catalog") || declared.has("inference")) {
        for (const offering of descriptor.offerings) {
          if (!seenPolicyOfferings.has(offering.id)) {
            throw new Error(
              `Contribution ${provider} declares model capability without a model policy for offering: ${offering.id}`,
            );
          }
        }
      }

      if (byProvider.has(provider)) {
        throw new Error(`Provider registry declares duplicate contribution: ${provider}`);
      }
      byProvider.set(provider, contribution);
    }
  }

  getDescriptor(providerId: ProviderId): ProviderDescriptor | null {
    return this.descriptors.find((descriptor) => descriptor.provider === providerId) ?? null;
  }

  requireDescriptor(providerId: ProviderId): ProviderDescriptor {
    const descriptor = this.getDescriptor(providerId);
    if (!descriptor) throw new AppError("validation", `服务商未注册：${providerId}`);
    return descriptor;
  }

  findOffering(
    offeringId: string,
  ): { provider: ProviderId; offering: ProviderOfferingDescriptor } | null {
    for (const descriptor of this.descriptors) {
      const offering = descriptor.offerings.find((item) => item.id === offeringId);
      if (offering) return { provider: descriptor.provider, offering };
    }
    return null;
  }

  resolveModelPolicy(binding: ModelPolicyBinding): ProviderOfferingModelPolicy {
    if (isCustomProviderId(binding.providerId)) {
      const kind = binding.templateKind ?? "generic";
      const template = this.templatePolicyIndex.get(kind);
      if (!template) {
        throw new AppError(
          "capability-unavailable",
          `未注册的自定义供应商模板策略：${String(kind)}`,
        );
      }
      return template;
    }
    const policy = this.modelPolicyIndex.get(`${binding.providerId}\0${binding.offeringId}`);
    if (!policy) {
      throw new AppError(
        "capability-unavailable",
        `未注册的模型策略：${binding.providerId}/${binding.offeringId}`,
      );
    }
    return policy;
  }

  getModelPolicy(binding: ModelPolicyBinding): ProviderOfferingModelPolicy | null {
    if (isCustomProviderId(binding.providerId)) {
      return this.templatePolicyIndex.get(binding.templateKind ?? "generic") ?? null;
    }
    return this.modelPolicyIndex.get(`${binding.providerId}\0${binding.offeringId}`) ?? null;
  }

  listModelPolicies(): readonly ProviderOfferingModelPolicy[] {
    return [...this.modelPolicyIndex.values(), ...this.templatePolicyIndex.values()];
  }

  listReceiptPolicies(): readonly ProviderOfferingModelPolicy[] {
    return this.receiptPolicies;
  }

  resolveReceiptPolicy(offeringId: string): ProviderOfferingModelPolicy {
    const policy = this.receiptPolicies.find((item) => item.offeringId === offeringId);
    if (!policy) {
      throw new AppError("capability-unavailable", `未注册的回执策略：${offeringId}`);
    }
    return policy;
  }

  getAccount(providerId: ProviderId): ProviderAccountCapability | null {
    const contribution = this.contributions.find((item) => item.descriptor.provider === providerId);
    return contribution?.account ?? null;
  }

  getRefreshAccount(
    account: Pick<Account, "provider" | "offeringId" | "authMethod">,
  ): ProviderAccountCapability | null {
    if (isCustomProviderId(account.provider)) return null;
    const entry = this.findOffering(account.offeringId);
    if (
      entry?.provider !== account.provider ||
      entry.offering.supportsSubscriptionUsage === false ||
      !entry.offering.authMethods.some((method) => method.method === account.authMethod)
    ) {
      return null;
    }
    return this.getAccount(account.provider);
  }

  requireAccount(providerId: ProviderId): ProviderAccountCapability {
    const account = this.getAccount(providerId);
    if (!account) {
      throw new AppError("validation", `服务商账号能力不可用：${providerId}`);
    }
    return account;
  }

  getUsage(providerId: ProviderId): ProviderUsageCapability | null {
    const contribution = this.contributions.find((item) => item.descriptor.provider === providerId);
    return contribution?.usage ?? null;
  }

  requireUsage(providerId: ProviderId): ProviderUsageCapability {
    const usage = this.getUsage(providerId);
    if (!usage) {
      throw new AppError("validation", `服务商用量能力不可用：${providerId}`);
    }
    return usage;
  }
}
