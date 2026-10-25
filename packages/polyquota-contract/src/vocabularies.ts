/**
 * 协议词表：只在协议本身演进（需要 bump `POLYQUOTA_SCHEMA_VERSION`）时变更的
 * 枚举留守在这里。随业务数据扩张的集合（供应商 id、认证方式 id）已去契约化
 */

export const POLYQUOTA_SCHEMA_VERSION = 6 as const;

/** 新增交互形态是产品协议变更；认证方式 id 本身不受此约束（目录声明即可）。 */
export type PublicAuthInteraction =
  | "browser-callback"
  | "device-code"
  | "local-import"
  | "secret-form";

export const remainingStatuses = ["empty", "complete", "incomplete"] as const;
export type RemainingStatus = (typeof remainingStatuses)[number];

export const remainingBands = ["healthy", "attention", "critical", "unknown"] as const;
export type RemainingBand = (typeof remainingBands)[number];

export const polyQuotaChangeReasons = [
  "accounts",
  "usage",
  "settings",
  "operations",
  "scheduler",
] as const;
export type PolyQuotaChangeReason = (typeof polyQuotaChangeReasons)[number];

export const polyQuotaProxyModes = ["direct", "system", "environment", "unknown"] as const;
export type PolyQuotaProxyMode = (typeof polyQuotaProxyModes)[number];
