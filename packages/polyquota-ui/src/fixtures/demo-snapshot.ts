import {
  POLYQUOTA_SCHEMA_VERSION,
  type PolyQuotaSnapshot,
  type PublicAccount,
  type PublicProviderDescriptor,
  type PublicUsage,
  type ResetCreditRedemption,
  type UsageQuota,
  type UsageQuotaGroup,
} from "../models";

/**
 * 浏览器预览（无 Electron 后端）的综合演示数据：覆盖每个供应商接入点与
 * 多种展示场景——健康/告警/临界用量、旧版套餐、未识别档位、分体与聚合
 * 重置额度、附加信息、真实原始量刻度、无限额度、停用账号、尚无用量。
 * 数据是纯展示虚构，不对应任何真实账号；重置卡的消耗模拟见
 * `consumeDemoResetCredit`。
 */

interface DemoAccountSpec {
  id: string;
  provider: string;
  offeringId: string;
  authMethod: string;
  displayName: string;
  maskedIdentifier: string;
  enabled?: boolean;
  credentialState?: PublicAccount["credentialState"];
  tokenExpiresAt?: string | null;
}

function demoAccount(spec: DemoAccountSpec, index: number): PublicAccount {
  const createdAt = new Date(Date.now() - (index + 1) * 86_400_000).toISOString();
  return {
    id: spec.id,
    provider: spec.provider,
    offeringId: spec.offeringId,
    authMethod: spec.authMethod,
    displayName: spec.displayName,
    maskedIdentifier: spec.maskedIdentifier,
    enabled: spec.enabled ?? true,
    credentialState: spec.credentialState ?? "available",
    tokenExpiresAt: spec.tokenExpiresAt ?? null,
    publicMetadata: {},
    createdAt,
    updatedAt: createdAt,
  };
}

/** 偏移分钟数的未来时间：重置时间展示为将来时刻，避免演示数据"已过期"。 */
function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function percentQuota(
  key: string,
  usedPercent: number,
  options: Partial<UsageQuota> = {},
): UsageQuota {
  const remaining = 100 - usedPercent;
  return {
    key,
    displayName: null,
    windowSeconds: null,
    used: usedPercent,
    total: 100,
    remaining,
    remainingPercentage: remaining,
    resetAt: null,
    unlimited: false,
    ...options,
  };
}

function group(
  key: string,
  quotas: UsageQuota[],
  displayName: string | null = null,
): UsageQuotaGroup {
  return { key, displayName, quotas };
}

const providers: PublicProviderDescriptor[] = [
  {
    provider: "codex",
    displayName: "OpenAI Codex",
    offerings: [
      {
        id: "codex",
        provider: "codex",
        displayName: "OpenAI Codex",
        description: "查看 ChatGPT 订阅中的 Codex 用量。",
        iconKey: "codex",
        authMethods: [
          { method: "browser-oauth", interaction: "browser-callback" },
          { method: "device-code", interaction: "device-code" },
          {
            method: "cli-import",
            interaction: "local-import",
            sourceLabel: "Codex CLI",
            sourcePathHint: "~/.codex/auth.json",
          },
        ],
        plans: [],
      },
    ],
  },
  {
    provider: "glm",
    displayName: "GLM Coding Plan",
    offerings: [
      {
        id: "bigmodel-coding-plan",
        provider: "glm",
        displayName: "BigModel Coding Plan",
        description: "智谱国内 Coding Plan，查看 5 小时、周配额和重置卡。",
        iconKey: "bigmodel",
        authMethods: [
          {
            method: "cli-import",
            interaction: "local-import",
            sourceLabel: "ZCode",
            sourcePathHint: "~/.zcode/v2/credentials.json",
          },
          { method: "api-key", interaction: "secret-form" },
        ],
        plans: [],
      },
      {
        id: "zai-coding-plan",
        provider: "glm",
        displayName: "Z.ai Coding Plan",
        description: "智谱国际版 Coding Plan，查看 5 小时、周配额和重置卡。",
        iconKey: "zai",
        authMethods: [
          {
            method: "cli-import",
            interaction: "local-import",
            sourceLabel: "ZCode",
            sourcePathHint: "~/.zcode/v2/credentials.json",
          },
          { method: "api-key", interaction: "secret-form" },
        ],
        plans: [],
      },
    ],
  },
  {
    provider: "grok-build",
    displayName: "Grok Build",
    offerings: [
      {
        id: "grok-build",
        provider: "grok-build",
        displayName: "Grok Build",
        description: "查看 Grok Build 订阅用量。",
        iconKey: "grok",
        authMethods: [
          { method: "device-code", interaction: "device-code" },
          { method: "browser-oauth", interaction: "browser-callback" },
          {
            method: "cli-import",
            interaction: "local-import",
            sourceLabel: "Grok CLI",
            sourcePathHint: "~/.grok/auth.json",
          },
        ],
        plans: [],
      },
    ],
  },
  {
    provider: "antigravity",
    displayName: "Antigravity",
    offerings: [
      {
        id: "antigravity",
        provider: "antigravity",
        displayName: "Antigravity",
        description: "查看 Antigravity 订阅用量。",
        iconKey: "antigravity",
        authMethods: [{ method: "browser-oauth", interaction: "browser-callback" }],
        plans: [],
      },
    ],
  },
  {
    provider: "claude",
    displayName: "Claude Code",
    offerings: [
      {
        id: "claude",
        provider: "claude",
        displayName: "Claude Code",
        description: "读取 Claude Code OAuth 凭据并查看订阅用量。",
        iconKey: "claude",
        authMethods: [
          {
            method: "cli-import",
            interaction: "local-import",
            sourceLabel: "Claude Code",
            sourcePathHint: "~/.claude/.credentials.json",
          },
        ],
        plans: [],
      },
    ],
  },
  {
    provider: "opencode-go",
    displayName: "OpenCode Go",
    offerings: [
      {
        id: "opencode-go",
        provider: "opencode-go",
        displayName: "OpenCode Go",
        description: "查看 OpenCode Go 的 5 小时、周和月用量。",
        iconKey: "opencode",
        authMethods: [{ method: "api-key", interaction: "secret-form" }],
        plans: [],
      },
    ],
  },
  {
    provider: "github-copilot",
    displayName: "GitHub Copilot",
    offerings: [
      {
        id: "github-copilot",
        provider: "github-copilot",
        displayName: "GitHub Copilot",
        description: "通过 GitHub 设备码授权查看 Copilot 的月度请求配额。",
        iconKey: "copilot",
        authMethods: [{ method: "device-code", interaction: "device-code" }],
        plans: [],
      },
    ],
  },
];

const accountSpecs: DemoAccountSpec[] = [
  {
    id: "demo-codex-plus",
    provider: "codex",
    offeringId: "codex",
    authMethod: "cli-import",
    displayName: "codex-main@example.test",
    maskedIdentifier: "co***@example.test",
  },
  {
    id: "demo-codex-legacy",
    provider: "codex",
    offeringId: "codex",
    authMethod: "browser-oauth",
    displayName: "codex-legacy@example.test",
    maskedIdentifier: "cl***@example.test",
    tokenExpiresAt: inMinutes(3 * 24 * 60),
  },
  {
    id: "demo-bigmodel-pro",
    provider: "glm",
    offeringId: "bigmodel-coding-plan",
    authMethod: "cli-import",
    displayName: "智谱主力号",
    maskedIdentifier: "zh***@example.test",
  },
  {
    id: "demo-zai-lite",
    provider: "glm",
    offeringId: "zai-coding-plan",
    authMethod: "api-key",
    displayName: "zai-backup",
    maskedIdentifier: "za**************key",
    enabled: false,
    credentialState: "locked",
  },
  {
    id: "demo-grok-legacy",
    provider: "grok-build",
    offeringId: "grok-build",
    authMethod: "device-code",
    displayName: "grok-存量号",
    maskedIdentifier: "gr***@example.test",
  },
  {
    id: "demo-grok-ultra",
    provider: "grok-build",
    offeringId: "grok-build",
    authMethod: "browser-oauth",
    displayName: "grok-ultra@example.test",
    maskedIdentifier: "gu***@example.test",
    tokenExpiresAt: inMinutes(6 * 24 * 60),
  },
  {
    id: "demo-antigravity-edge",
    provider: "antigravity",
    offeringId: "antigravity",
    authMethod: "browser-oauth",
    displayName: "antigravity@example.test",
    maskedIdentifier: "an***@example.test",
    tokenExpiresAt: inMinutes(9 * 24 * 60),
  },
  {
    id: "demo-claude-max",
    provider: "claude",
    offeringId: "claude",
    authMethod: "cli-import",
    displayName: "claude@example.test",
    maskedIdentifier: "cj***@example.test",
  },
  {
    id: "demo-opencode-go",
    provider: "opencode-go",
    offeringId: "opencode-go",
    authMethod: "api-key",
    displayName: "opencode-go",
    maskedIdentifier: "oc**************key",
  },
  {
    id: "demo-copilot-pro-plus",
    provider: "github-copilot",
    offeringId: "github-copilot",
    authMethod: "device-code",
    displayName: "copilot@example.test",
    maskedIdentifier: "co***@example.test",
  },
];

function demoUsage(): Record<string, PublicUsage | null> {
  const fetchedAt = new Date().toISOString();
  const usage = (partial: Omit<PublicUsage, "accountId" | "fetchedAt">): PublicUsage => ({
    accountId: "",
    fetchedAt,
    ...partial,
  });
  const byId: Record<string, PublicUsage | null> = {
    // codex Plus：健康档 + 聚合重置额度（分桶）+ 额外额度附加信息。
    "demo-codex-plus": usage({
      plan: "plus",
      planId: "plus",
      planLabel: "Plus",
      overallRemainingPercentage: 72,
      groups: [
        group("default", [
          percentQuota("session (5h)", 28, { windowSeconds: 18_000, resetAt: inMinutes(180) }),
          percentQuota("weekly (7d)", 19, {
            windowSeconds: 604_800,
            resetAt: inMinutes(4 * 24 * 60),
          }),
        ]),
      ],
      extras: [{ key: "extra-credits", value: "$5.00" }],
      resetCredits: {
        kind: "aggregate",
        totals: [
          { type: "banked", total: 2 },
          { type: "five-hour", total: 1 },
        ],
      },
    }),
    // codex Pro 20x：旧版套餐（legacy + 到期日场景）+ 临界用量。
    "demo-codex-legacy": usage({
      plan: "pro 20x",
      planId: "pro-20x",
      planLabel: "Pro 20x",
      planLegacy: true,
      overallRemainingPercentage: 8,
      groups: [
        group("default", [
          percentQuota("session (5h)", 88, { windowSeconds: 18_000, resetAt: inMinutes(95) }),
          percentQuota("weekly (7d)", 92, {
            windowSeconds: 604_800,
            resetAt: inMinutes(2 * 24 * 60),
          }),
        ]),
      ],
      extras: [],
      resetCredits: null,
    }),
    // BigModel Pro：真实原始量刻度（积分）+ 分体重置额度（带过期时间）。
    "demo-bigmodel-pro": usage({
      plan: "Glm Coding Pro",
      planId: "pro",
      planLabel: "Pro",
      overallRemainingPercentage: 38,
      groups: [
        group("default", [
          {
            key: "session (5h)",
            displayName: "5 Hours Quota",
            windowSeconds: 18_000,
            used: 7_440,
            total: 12_000,
            remaining: 4_560,
            remainingPercentage: 38,
            resetAt: inMinutes(160),
            unlimited: false,
            rawAmounts: true,
          },
          {
            key: "weekly (7d)",
            displayName: "Weekly Quota",
            windowSeconds: 604_800,
            used: 372_000,
            total: 600_000,
            remaining: 228_000,
            remainingPercentage: 38,
            resetAt: inMinutes(3 * 24 * 60),
            unlimited: false,
            rawAmounts: true,
          },
          {
            key: "mcp_monthly",
            displayName: "Monthly",
            windowSeconds: 30 * 86_400,
            used: 1_200,
            total: 10_000,
            remaining: 8_800,
            remainingPercentage: 88,
            resetAt: inMinutes(12 * 24 * 60),
            unlimited: false,
            rawAmounts: true,
          },
        ]),
      ],
      extras: [],
      resetCredits: {
        kind: "itemized",
        items: [
          { id: "demo-reset-hourly", type: "five-hour", expiresAt: inMinutes(45 * 24 * 60) },
          { id: "demo-reset-weekly", type: "weekly", expiresAt: inMinutes(9 * 24 * 60) },
        ],
      },
    }),
    // Z.ai Lite：停用账号 + 尚无用量（卡片空态 + 停用提示叠加）。
    "demo-zai-lite": null,
    // Grok 存量 SuperGrok Pro：旧版套餐 + 附加信息三件套（重置计数走 extras）。
    "demo-grok-legacy": usage({
      plan: "GrokPro",
      planId: "supergrok-pro",
      planLabel: "SuperGrok Pro",
      planLegacy: true,
      overallRemainingPercentage: 45,
      groups: [
        group("default", [
          percentQuota("weekly", 55, { windowSeconds: 604_800, resetAt: inMinutes(5 * 24 * 60) }),
          percentQuota("agentic-coding", 47, { displayName: "Agentic Coding" }),
          percentQuota("grok-web-app", 30, { displayName: "Grok Web App" }),
        ]),
      ],
      extras: [
        { key: "reset-credits", value: "3" },
        { key: "extra-credits", value: "$12.34" },
        { key: "auto-top-up", value: "已停用" },
      ],
      // grok 的重置额度暂以计数展示在 extras（未接入消耗协议），演示数据同构。
      resetCredits: null,
    }),
    // Grok Ultra：新档位、健康用量。
    "demo-grok-ultra": usage({
      plan: "ultra",
      planId: "ultra",
      planLabel: "Ultra",
      overallRemainingPercentage: 88,
      groups: [
        group("default", [
          percentQuota("weekly", 12, { windowSeconds: 604_800, resetAt: inMinutes(6 * 24 * 60) }),
          percentQuota("agentic-coding", 8, { displayName: "Agentic Coding" }),
        ]),
      ],
      extras: [],
      resetCredits: null,
    }),
    // Antigravity：未识别档位（目录未命中的长 tier 名）+ 按模型原始额度归入
    // 模型族（族级周配额 + 按模型 5 小时额度，对齐 vendor 叶子三源组装）。
    "demo-antigravity-edge": usage({
      plan: "Antigravity Edge Quota",
      planId: null,
      planLabel: "Antigravity Edge Quota",
      overallRemainingPercentage: 30,
      groups: [
        group(
          "gemini_models",
          [
            percentQuota("weekly", 45, {
              displayName: "Weekly Quota",
              windowSeconds: 604_800,
              resetAt: inMinutes(4 * 24 * 60),
            }),
            percentQuota("gemini_3_1_flash_lite", 55, {
              displayName: "Gemini 3.1 Flash Lite",
              // 上游真实桶 id：营销名与引擎 id 漂移的真实案例，演示 detail 行。
              detail: "gemini-3.8-flash-tiered",
              windowSeconds: 18_000,
              resetAt: inMinutes(190),
            }),
            percentQuota("gemini_pro_agent", 70, {
              displayName: "Gemini 3.1 Pro (High)",
              detail: "gemini-pro-agent",
              windowSeconds: 18_000,
              resetAt: inMinutes(190),
            }),
          ],
          "Gemini Models",
        ),
        group(
          "claude_gpt_models",
          [
            percentQuota("weekly", 60, {
              displayName: "Weekly Quota",
              windowSeconds: 604_800,
              resetAt: inMinutes(4 * 24 * 60),
            }),
            percentQuota("claude_opus_4_6_thinking", 30, {
              displayName: "Claude Opus 4.6 (Thinking)",
              detail: "claude-opus-4-6-thinking",
              windowSeconds: 18_000,
              resetAt: inMinutes(230),
            }),
            percentQuota("gpt_oss_120b_medium", 85, {
              displayName: "GPT-OSS 120B (Medium)",
              detail: "gpt-oss-120b-medium",
              windowSeconds: 18_000,
              resetAt: inMinutes(230),
            }),
          ],
          "Claude and GPT Models",
        ),
      ],
      extras: [],
      resetCredits: null,
    }),
    // Claude Max 20x：会话 + 周/按模型周配额（adapter 实际都归 default 组）。
    "demo-claude-max": usage({
      plan: "max 20x",
      planId: "max-20x",
      planLabel: "Max 20x",
      overallRemainingPercentage: 76,
      groups: [
        group("default", [
          percentQuota("session (5h)", 24, { windowSeconds: 18_000, resetAt: inMinutes(210) }),
          percentQuota("weekly (7d)", 33, {
            windowSeconds: 604_800,
            resetAt: inMinutes(5 * 24 * 60),
          }),
          percentQuota("weekly designer (7d)", 55, {
            displayName: "Weekly Designer",
            windowSeconds: 604_800,
            resetAt: inMinutes(5 * 24 * 60),
          }),
        ]),
      ],
      extras: [],
      resetCredits: null,
    }),
    // OpenCode Go：三窗口 + 无限额度场景。
    "demo-opencode-go": usage({
      plan: "OpenCode Go",
      planId: "opencode-go",
      planLabel: "OpenCode Go",
      overallRemainingPercentage: 64,
      groups: [
        group("default", [
          percentQuota("session", 36, { windowSeconds: 18_000, resetAt: inMinutes(150) }),
          percentQuota("weekly", 22, { windowSeconds: 604_800, resetAt: inMinutes(3 * 24 * 60) }),
          percentQuota("monthly", 0, {
            windowSeconds: 30 * 86_400,
            resetAt: inMinutes(20 * 24 * 60),
            unlimited: true,
            remaining: null,
            remainingPercentage: null,
          }),
        ]),
      ],
      extras: [],
      resetCredits: null,
    }),
    // Copilot Pro+：月度请求配额（无重置额度）。
    "demo-copilot-pro-plus": usage({
      plan: "copilot_pro_plus",
      planId: "copilot-pro-plus",
      planLabel: "Copilot Pro+",
      overallRemainingPercentage: 68,
      groups: [
        group("default", [
          percentQuota("premium_interactions", 32, {
            windowSeconds: 30 * 86_400,
            resetAt: inMinutes(14 * 24 * 60),
          }),
          percentQuota("chat", 18, { windowSeconds: 30 * 86_400 }),
          percentQuota("completions", 25, { windowSeconds: 30 * 86_400 }),
        ]),
      ],
      extras: [],
      resetCredits: null,
    }),
  };
  for (const spec of accountSpecs) {
    const value = byId[spec.id] ?? null;
    if (value) value.accountId = spec.id;
    byId[spec.id] = value;
  }
  return byId;
}

export function createDemoSnapshot(): PolyQuotaSnapshot {
  return {
    schemaVersion: POLYQUOTA_SCHEMA_VERSION,
    revision: 1,
    generatedAt: new Date().toISOString(),
    providers,
    accounts: accountSpecs.map((spec, index) => demoAccount(spec, index)),
    usageByAccountId: demoUsage(),
    // 聚合剩余度取演示数据中具有代表性的读数，不在此复算 core 的加权逻辑。
    compositeRemaining: {
      status: "complete",
      sessionScore: 52,
      weeklyScore: 28,
      remaining: 28,
      band: "attention",
      sessionBand: "attention",
      weeklyBand: "attention",
      enabledAccountCount: 9,
      scoredAccountCount: 9,
    },
    operations: [],
    settings: { pollingEnabled: false, pollingIntervalMinutes: 15, taskbarProgressEnabled: true },
    scheduler: {
      status: "disabled",
      intervalMinutes: 15,
      nextRunAt: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastResult: null,
    },
  };
}

/**
 * 重置卡消耗模拟：移除对应的演示重置额度（分体按 id、聚合按类型扣减，
 * 耗尽后整个 resetCredits 置 null），并把该账号全部配额与总体剩余度回满。
 * 返回兑换结果；账号不存在或没有匹配的重置额度时返回 null。
 */
export function consumeDemoResetCredit(
  snapshot: PolyQuotaSnapshot,
  accountId: string,
  redemption: ResetCreditRedemption,
): { remainingResetCredits: number } | null {
  const usage = snapshot.usageByAccountId[accountId];
  if (!usage?.resetCredits) return null;
  const credits = usage.resetCredits;
  let remaining: number;
  if (credits.kind === "itemized") {
    if (redemption.kind !== "item") return null;
    // items 是 readonly 数组，替换引用而不是原地 splice。
    const next = credits.items.filter((item) => item.id !== redemption.itemId);
    if (next.length === credits.items.length) return null;
    credits.items = next;
    remaining = next.length;
  } else {
    if (redemption.kind !== "aggregate") return null;
    const bucket = redemption.type
      ? credits.totals.find((total) => total.type === redemption.type)
      : (credits.totals[0] ?? null);
    if (!bucket || bucket.total <= 0) return null;
    bucket.total -= 1;
    remaining = credits.totals.reduce((sum, total) => sum + total.total, 0);
  }
  if (remaining <= 0) usage.resetCredits = null;
  refillDemoUsage(usage);
  return { remainingResetCredits: remaining };
}

/** 用量回满：有限配额 used 归零、剩余与百分比回满，无限与未提供刻度保持原样。 */
function refillDemoUsage(usage: PublicUsage): void {
  const percentages: number[] = [];
  for (const quotaGroup of usage.groups) {
    for (const quota of quotaGroup.quotas) {
      if (quota.unlimited) continue;
      quota.used = 0;
      if (quota.total > 0) {
        quota.remaining = quota.total;
        quota.remainingPercentage = 100;
        percentages.push(100);
      } else {
        quota.remaining = null;
        quota.remainingPercentage = null;
      }
    }
  }
  usage.overallRemainingPercentage = percentages.length ? Math.min(...percentages) : null;
  usage.fetchedAt = new Date().toISOString();
}
