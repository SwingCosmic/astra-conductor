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
   * Data-layer identifiers that map to this entry: either raw `usage.plan`
   * strings (exact on the normalized form — lowercased, whitespace / `_` / `-`
   * collapsed to spaces) or regex literals as pure fallback. Evaluation is
   * exact-first: all string keys across the offering are tried in declaration
   * order, then regexes in declaration order against the normalized string,
   * so a broad regex can never steal an exact hit.
   */
  match: readonly (string | RegExp)[];
  /** Weight `w` relative to the provider baseline. Must be finite and greater than 0. */
  multiplier: number;
  source: ProviderPlanSource;
  /**
   * 仍可继续使用的旧订阅条目（新旧并存，见数据侧 §7 规则 1）。到期前仍按
   * multiplier 参与加权；到期后上游字符串消失、条目自然失配，无需运行时清理。
   */
  legacy?: boolean;
  /** 可选 legacy 到期日（ISO `YYYY-MM-DD`）；出现时必须同时有 `legacy: true`。 */
  legacyUntil?: string;
  /**
   * 倍率出处（官方定价 / 公告页）与核实时间（ISO `YYYY-MM-DD`）。核心内部
   * 事实，不进公开目录快照；published 条目应携带，便于漂移审计。
   */
  sourceUrl?: string;
  verifiedAt?: string;
}

export interface ProviderDescriptor {
  provider: ProviderId;
  displayName: string;
  offerings: ProviderOfferingDescriptor[];
  capabilities: readonly ProviderCapability[];
}
