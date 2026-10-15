import type { PublicAccount, PublicUsage } from "@astra-conductor/polyquota-contract";
import type { Account, ResetCredits, UsageSnapshot } from "./models.js";
import { matchOfferingPlan } from "./providers/catalog.js";

export function toPublicAccount(
  account: Account,
  tokenExpiresAt: string | null = null,
): PublicAccount {
  return {
    id: account.id,
    provider: account.provider,
    offeringId: account.offeringId,
    authMethod: account.authMethod,
    displayName: account.displayName,
    maskedIdentifier: account.maskedIdentifier,
    enabled: account.enabled,
    credentialState: account.credentialState,
    tokenExpiresAt,
    publicMetadata: { ...account.publicMetadata },
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

/**
 * 破坏性结构更新：旧结构快照（无 resetCredits 字段）不做形态适配，投影为
 * null 即可；桌面端读到旧结构快照时会立即触发一次刷新换取新数据。
 */
function legacyResetCredits(
  value: UsageSnapshot & { resetCredits?: ResetCredits | null },
): ResetCredits | null {
  if (value.resetCredits === undefined) return null;
  return value.resetCredits ?? null;
}

/**
 * 套餐解析点上移后的唯一投影：档位匹配只在这里发生（core 目录为唯一实现），
 * 解析结果固化进公开快照。回退顺序：目录 `displayName` → 上游原始展示名
 * （叶子附带时，随数据侧批次提供）→ 原始标识串；未识别档位 `planId: null`，
 * 倍率仍走默认档（既有行为），由 UI 给出可见提示。
 */
export function toPublicUsage(snapshot: UsageSnapshot, offeringId: string): PublicUsage {
  const value = structuredClone(snapshot) as UsageSnapshot & {
    quotas?: UsageSnapshot["groups"][number]["quotas"];
    resetCredits?: number;
    overallRemainingPercentage?: number | null;
  };
  const resetCredits = legacyResetCredits(snapshot);
  const plan = typeof value.plan === "string" ? value.plan : "";
  const matched = matchOfferingPlan(offeringId, plan);
  const rawPlanLabel =
    typeof value.rawPlanLabel === "string" && value.rawPlanLabel.trim()
      ? value.rawPlanLabel.trim()
      : null;
  if (!Array.isArray(value.groups)) {
    value.groups = [{ key: "default", displayName: null, quotas: value.quotas ?? [] }];
  }
  value.groups = value.groups.map((group) => {
    const legacyGroup = group as typeof group & { title?: string | null };
    return {
      key: group.key,
      displayName: group.displayName ?? legacyGroup.title ?? null,
      quotas: group.quotas.map((quota) => {
        const legacyQuota = quota as typeof quota & { title?: string };
        return {
          key: quota.key,
          displayName: quota.displayName ?? legacyQuota.title ?? null,
          windowSeconds: quota.windowSeconds ?? null,
          used: typeof quota.used === "number" && Number.isFinite(quota.used) ? quota.used : 0,
          total: typeof quota.total === "number" && Number.isFinite(quota.total) ? quota.total : 0,
          remaining:
            typeof quota.remaining === "number" && Number.isFinite(quota.remaining)
              ? quota.remaining
              : null,
          remainingPercentage:
            typeof quota.remainingPercentage === "number" &&
            Number.isFinite(quota.remainingPercentage)
              ? quota.remainingPercentage
              : null,
          resetAt: quota.resetAt ?? null,
          unlimited: quota.unlimited === true,
          rawAmounts: quota.rawAmounts === true,
        };
      }),
    };
  });
  if (!Array.isArray(value.extras)) {
    value.extras =
      typeof value.resetCredits === "number"
        ? [{ key: "reset-credits", value: String(value.resetCredits) }]
        : [];
  }
  value.extras = value.extras.map(({ key, value: extraValue, items }) => ({
    key,
    value: String(extraValue),
    ...(Array.isArray(items)
      ? {
          items: items.map((item) => ({
            key: item.key,
            kind: item.kind,
            expiresAt: item.expiresAt ?? null,
          })),
        }
      : {}),
  }));
  if (value.overallRemainingPercentage === undefined) {
    value.overallRemainingPercentage = value.groups[0]?.quotas[0]?.remainingPercentage ?? null;
  }
  delete value.quotas;
  return {
    accountId: value.accountId,
    plan,
    planId: matched?.id ?? null,
    planLabel: matched?.displayName ?? rawPlanLabel ?? (plan.trim() || null),
    overallRemainingPercentage: value.overallRemainingPercentage,
    groups: value.groups,
    extras: value.extras,
    resetCredits,
    fetchedAt: value.fetchedAt,
  };
}
