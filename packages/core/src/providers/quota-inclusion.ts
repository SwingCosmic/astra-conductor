import type { UsageQuota } from "../models.js";

/**
 * 订阅未包含的表不进入用量快照（对齐 OmniRoute 的展示闸门）：无正额度、
 * 非 unlimited、却带着百分比读数的表是上游泄漏的"未包含"形态——展示只会
 * 制造 0% 误报（免费 Copilot 账号无高级请求额度、GLM 计划未含 MCP 月度
 * 窗口）。保留两类零总额表：unlimited（UI 显示"无限"、按 100% 计）与
 * 百分比未上报的哨兵形态（如 antigravity 的 fractionReported=false，
 * 显示"未提供"且不触发告警）。credits 类事实走 extras。
 * 各 adapter 在组装 groups 前统一过这道闸，叶子层的零额形态不再外漏。
 */
export function includedQuotas(quotas: readonly UsageQuota[]): UsageQuota[] {
  return quotas.filter(
    (quota) => quota.unlimited || quota.total > 0 || quota.remainingPercentage === null,
  );
}
