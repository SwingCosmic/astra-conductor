import type {
  PublicSystemStatus,
  PublicUsage,
  UsageExtra,
  UsageQuota,
  UsageQuotaGroup,
} from "./models";
export {
  authMethodLabel,
  accountPresentation,
  catalogPresentations,
} from "@astra-conductor/shared-ui";
export type { ProviderPresentation } from "@astra-conductor/shared-ui";

const resetCreditTypeTexts: Record<string, string> = {
  "five-hour": "5 小时周期",
  weekly: "每周周期",
  banked: "结转额度",
};
export function resetCreditTypeLabel(type: string): string {
  return resetCreditTypeTexts[type] ?? type.replaceAll("-", " ");
}

/**
 * 套餐标签：直接消费主进程固化进快照的 `planLabel`（回退顺序已在主进程
 * 决定：目录 displayName → 原始标识串）。空 plan 的展示方式归 UI——当前
 * 选择不渲染标签，而不是虚构"未提供"占位。
 */
export function planTagLabel(usage: PublicUsage | null): string | null {
  const label = usage?.planLabel?.trim();
  return label ? label : null;
}

/**
 * 未识别档位：上游有 plan 标识但目录未命中。倍率按默认档估算（主进程既有
 * 行为），这里给出可见提示的判据——供应商改版导致 match 键失配时用户与
 * 开发者能立刻看到，而不是无声错权重。
 */
export function isUnrecognizedPlan(usage: PublicUsage | null): boolean {
  return Boolean(usage && usage.planId === null && usage.plan.trim());
}

/**
 * 旧版套餐：目录标记 legacy 的存量档位（新旧并存策略，数据侧 §7 规则 1）。
 * 随解析结果（planLegacy）随快照下发，前端只消费标记不做匹配；未识别档位
 * 无从判断新旧，不展示旧版标记。
 */
export function isLegacyPlan(usage: PublicUsage | null): boolean {
  return usage?.planLegacy === true && usage.planId !== null;
}

function windowLabel(seconds: number | null): string | null {
  if (seconds === 18_000) return "5 Hours";
  if (seconds === 604_800) return "Weekly";
  if (seconds !== null && seconds >= 20 * 86_400) return "Monthly";
  if (seconds !== null && seconds > 0 && seconds % 3_600 === 0) {
    return `${seconds / 3_600} Hours`;
  }
  return null;
}

/** 比较前折叠分隔符与大小写："5 Hours Quota" 与 "5-hour" 视为同一信息。 */
function labelCarriesDuration(name: string, duration: string): boolean {
  const fold = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, "");
  return fold(name).includes(fold(duration));
}

/** 回退顺序：上游原生 displayName → 窗口时长等纯展示计算 → key 原样。 */
export function quotaLabel(quota: UsageQuota): string {
  const duration = windowLabel(quota.windowSeconds);
  const nativeName = quota.displayName?.trim();
  if (nativeName && duration && /^(session|weekly|monthly)$/i.test(nativeName)) {
    return duration;
  }
  if (nativeName && duration && !labelCarriesDuration(nativeName, duration)) {
    return `${nativeName} · ${duration}`;
  }
  return nativeName || duration || quota.key.replaceAll("_", " ");
}

export function groupLabel(group: UsageQuotaGroup): string | null {
  return group.displayName ?? null;
}

/**
 * 附加信息键的固定文案：跨供应商的小封闭集合（目前只有 grok 的计费信息）。
 * 重置相关文案统一叫"重置额度"，与一等 resetCredits 结构的展示一致；未知
 * 键回退为连字符转空格的原文。
 */
const extraTexts: Record<string, string> = {
  "reset-credits": "重置额度",
  "extra-credits": "额外额度",
  "auto-top-up": "自动充值",
};

export function extraLabel(extra: UsageExtra): string {
  return extraTexts[extra.key] ?? extra.key.replaceAll("-", " ");
}

export function extraItemLabel(kind: string): string {
  return kind.replaceAll("-", " ");
}

export function systemProxyLabel(status: PublicSystemStatus): string {
  if (status.proxyMode === "environment") {
    return `环境变量：${status.proxyAddress ?? "未提供地址"}`;
  }
  if (status.proxyMode === "system") {
    return `系统代理：${status.proxyAddress ?? "未提供地址"}`;
  }
  if (status.proxyMode === "unknown") {
    return "无法检测，遵循系统";
  }
  return "直连";
}
