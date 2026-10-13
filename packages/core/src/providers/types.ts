import type { AuthMethod, ProviderId } from "../models.js";

export type AuthMethodInteraction =
  | "browser-callback"
  | "device-code"
  | "local-import"
  | "secret-form";

/**
 * 服务商贡献提供的共享能力面。`account`、`usage`、`model-catalog` 与
 * `inference` 必须有对应 facet（ProviderRegistry 构造期校验）；其余是行为
 * 声明。模型与推理能力尚未落地，当前不得声明。
 */
export type ProviderCapability =
  | "account"
  | "usage"
  | "model-catalog"
  | "inference"
  | "multiple-accounts";

export interface ProviderAuthMethodDescriptor {
  method: AuthMethod;
  interaction: AuthMethodInteraction;
  sourceLabel?: string;
  /** cli-import 展示用凭据路径提示；真实路径解析在各 auth-flow 内部，两者同源维护。 */
  sourcePathHint?: string;
}

export interface ProviderOfferingDescriptor {
  id: string;
  provider: ProviderId;
  displayName: string;
  description?: string;
  websiteUrl?: string;
  /** core 声明键、UI 持有资产映射；缺失映射时 UI 使用自己的视觉回退。 */
  iconKey?: string;
  authMethods: ProviderAuthMethodDescriptor[];
  /** 接入点级套餐目录：同一服务商的不同接入点计费模式可以完全不同。 */
  plans: readonly ProviderPlanDescriptor[];
}

/**
 * One-time plan catalog entry. Runtime scoring only looks these up; it does not
 * re-guess names. `source` records how the multiplier was filled in:
 * published vendor ratio, or a one-time inference from the identifier / name.
 */
export type ProviderPlanSource = "published" | "inferred";

export interface ProviderPlanDescriptor {
  id: string;
  displayName: string;
  /**
   * Raw `usage.plan` strings that map to this entry. Matching lowercases and
   * collapses whitespace / `_` / `-`; it is exact on the normalized form.
   */
  match: readonly string[];
  /** Weight `w` relative to the provider baseline. Must be finite and greater than 0. */
  multiplier: number;
  source: ProviderPlanSource;
}

export interface ProviderDescriptor {
  provider: ProviderId;
  displayName: string;
  offerings: ProviderOfferingDescriptor[];
  capabilities: readonly ProviderCapability[];
}
