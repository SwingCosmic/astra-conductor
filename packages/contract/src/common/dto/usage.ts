export interface UsageQuota {
  key: string;
  displayName: string | null;
  windowSeconds: number | null;
  used: number;
  total: number;
  remaining: number | null;
  remainingPercentage: number | null;
  resetAt: string | null;
  unlimited: boolean;
  /** 上游真实上报 used/total 原始量时为 true；百分比合成的刻度不算。缺省 false。 */
  rawAmounts?: boolean;
  /**
   * 上游原始标识（如 antigravity 的模型桶 id）：供应商会反复改模型名与目录，
   * 展示名可能滞后于真实模型，id 随行透传供核对。缺省不展示。
   */
  detail?: string;
}

export interface UsageQuotaGroup {
  key: string;
  displayName: string | null;
  quotas: UsageQuota[];
}

export interface UsageExtraItem {
  key: string;
  kind: string;
  expiresAt: string | null;
}

export interface UsageExtra {
  key: string;
  value: string;
  items?: UsageExtraItem[];
}

export interface ResetCreditItem {
  /** 上游不透明标识，只回传给所属 provider 的兑换协议。 */
  id: string;
  /** 如 "five-hour"、"weekly"、"banked"。 */
  type: string;
  expiresAt: string | null;
}

/**
 * 重置额度的一等结构（获得侧，随 `fetchUsage` 返回）：
 * - aggregate：上游只提供计数时按类型分桶，不区分窗口的供应商声明单桶；
 * - itemized：每张重置卡有完整类型、过期时间与 id。
 */
export type ResetCredits =
  | {
      kind: "aggregate";
      totals: readonly { type: string; total: number }[];
    }
  | {
      kind: "itemized";
      items: readonly ResetCreditItem[];
    };

/** 重置额度消耗请求：聚合按类型（单桶可省略 type），分体带对应重置卡 id。 */
export type ResetCreditRedemption =
  | { kind: "aggregate"; type?: string }
  | { kind: "item"; itemId: string };

export interface PublicUsage {
  accountId: string;
  /** 上游原始 plan 标识（数据层标识符）：审计与最后回退用，展示走 `planLabel`。 */
  plan: string;
  /**
   * 主进程经目录匹配解析出的档位 id；`null` 即未识别档位——倍率按默认档
   * 估算（既有行为），UI 需给出可见提示而不是静默兜底。
   */
  planId: string | null;
  /**
   * 主进程固化进快照的展示标签，回退顺序：目录 `displayName` → 上游原始
   * 展示名（叶子附带时）→ 原始标识串；`null` 表示上游没有 plan 信息。
   */
  planLabel: string | null;
  /**
   * 命中的目录条目带 `legacy` 标记（新旧并存的存量档位，数据侧 §7 规则 1）
   * 时为 true；未识别档位与普通档位不带或为 false。
   */
  planLegacy?: boolean;
  overallRemainingPercentage: number | null;
  groups: UsageQuotaGroup[];
  extras: UsageExtra[];
  resetCredits: ResetCredits | null;
  fetchedAt: string;
}
