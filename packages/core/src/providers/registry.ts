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

/**
 * 账号能力 facet：认证交互由 `startAuth` 开始，输入以 `offeringId` 为稳定
 * 入口（协调器已对目录交叉验证）；`refreshCredentials` 只由确实有主动刷新
 * 协议的账号实现提供，API Key 账号不提供无效果刷新方法。
 */
export interface ProviderAccountCapability {
  readonly providerId: ProviderId;
  /** 构造期与目录对账，不参与运行期分派。 */
  readonly supportedMethods: readonly AuthMethod[];
  startAuth(
    offeringId: string,
    method: AuthMethod,
    options: AuthStartOptions,
  ): Promise<AuthFlowStart>;
  refreshCredentials?(
    account: Account,
    envelope: CredentialEnvelope,
    options: { force: boolean },
  ): Promise<CredentialRefreshResult>;
}

/**
 * 用量能力 facet：`resetCredits` 是 `fetchUsage` 的一等返回结构；`redeemResetCard`
 * 是用量侧用户动作，只由支持消耗协议的供应商提供。
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

/** 声明与全部能力实现以相同 providerId 成对注册；能力声明在 descriptor.capabilities。 */
export interface ProviderContribution {
  descriptor: ProviderDescriptor;
  account?: ProviderAccountCapability;
  usage?: ProviderUsageCapability;
  dispose?(): void;
}

const facetBackedCapabilities = ["account", "usage", "model-catalog", "inference"] as const;

/**
 * 严格注册表：构造期完整校验所有权与能力声明，任一错误使整个构造失败。
 * 禁止后注册覆盖、跳过坏条目后继续启动，或把请求交给默认实现。
 */
export class ProviderRegistry {
  readonly contributions: readonly ProviderContribution[];
  readonly descriptors: readonly ProviderDescriptor[];

  constructor(contributions: readonly ProviderContribution[]) {
    this.contributions = [...contributions];
    this.descriptors = this.contributions.map((contribution) => contribution.descriptor);
    validateProviderCatalog(this.descriptors);
    const byProvider = new Map<ProviderId, ProviderContribution>();
    for (const contribution of this.contributions) {
      const { descriptor, account, usage } = contribution;
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
        if ((facetBackedCapabilities as readonly string[]).includes(capability)) continue;
        if (capability !== "multiple-accounts") {
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
      for (const capability of facetBackedCapabilities) {
        if (!declared.has(capability)) continue;
        if (capability === "model-catalog" || capability === "inference") {
          throw new Error(
            `Contribution ${provider} declares ${capability}, which no facet implements yet`,
          );
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

  getAccount(providerId: ProviderId): ProviderAccountCapability | null {
    const contribution = this.contributions.find((item) => item.descriptor.provider === providerId);
    return contribution?.account ?? null;
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
