import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import AuthModal from "../src/components/AuthModal.vue";
import QuotaCard from "../src/components/QuotaCard.vue";
import type {
  PolyQuotaSnapshot,
  PublicAccount,
  PublicOfferingDescriptor,
  PublicProviderDescriptor,
  PublicUsage,
} from "../src/models";
import ProvidersView from "../src/views/ProvidersView.vue";
import UsageView from "../src/views/UsageView.vue";
import { EmptyPolyQuotaService, type IPolyQuotaService } from "../src/services/polyquota-service";
import { polyQuotaServiceKey } from "../src/services/polyquota-service-vue";
import {
  accountPresentation,
  authMethodLabel,
  catalogPresentations,
  extraLabel,
  isLegacyPlan,
  isUnrecognizedPlan,
  planTagLabel,
  quotaLabel,
  resetCreditTypeLabel,
} from "../src/presentation";
import {
  POLYQUOTA_SCHEMA_VERSION,
  emptyCompositeRemaining,
} from "@astra-conductor/polyquota-contract";

const codexPlans: PublicOfferingDescriptor["plans"] = [
  { id: "plus", displayName: "Plus" },
  { id: "pro-5x", displayName: "Pro 5x" },
];

const providerCatalogFixture: PublicProviderDescriptor[] = [
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
        plans: codexPlans,
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
        plans: [
          { id: "copilot-pro", displayName: "Copilot Pro" },
          { id: "copilot-pro-plus", displayName: "Copilot Pro+" },
        ],
      },
    ],
  },
];

const account: PublicAccount = {
  id: "account-1",
  provider: "codex",
  offeringId: "codex",
  authMethod: "cli-import",
  displayName: "test@example.test",
  maskedIdentifier: "te***@example.test",
  enabled: true,
  credentialState: "available",
  tokenExpiresAt: null,
  publicMetadata: {},
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mountApp(service: IPolyQuotaService) {
  return mount(App, {
    global: { provide: { [polyQuotaServiceKey as symbol]: service } },
  });
}

const emptyService = new EmptyPolyQuotaService();

function snapshot(
  accounts: PublicAccount[],
  usageByAccountId: Record<string, PublicUsage | null> = Object.fromEntries(
    accounts.map((item) => [item.id, null]),
  ),
  revision = 1,
): PolyQuotaSnapshot {
  return {
    schemaVersion: POLYQUOTA_SCHEMA_VERSION,
    instanceId: "test-instance",
    revision,
    generatedAt: "2026-09-27T00:00:00.000Z",
    providers: providerCatalogFixture,
    accounts,
    usageByAccountId,
    compositeRemaining: emptyCompositeRemaining(),
    operations: [],
    settings: { pollingEnabled: true, pollingIntervalMinutes: 15, taskbarProgressEnabled: true },
    scheduler: {
      status: "waiting",
      intervalMinutes: 15,
      nextRunAt: "2026-09-27T00:15:00.000Z",
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastResult: null,
    },
  };
}

function serviceWithSnapshot(
  value: PolyQuotaSnapshot,
  overrides: Partial<IPolyQuotaService> = {},
): IPolyQuotaService {
  const service = new EmptyPolyQuotaService();
  vi.spyOn(service, "getSnapshot").mockResolvedValue({ ok: true, value });
  return Object.assign(service, overrides);
}

function catalogRow(offeringId: string) {
  const row = catalogPresentations(providerCatalogFixture).find((item) => item.id === offeringId);
  if (!row) throw new Error(`missing presentation: ${offeringId}`);
  return row;
}

describe("desktop account UI", () => {
  it("keeps the ordinary browser preview runnable on the demo data", async () => {
    const wrapper = mountApp(emptyService);
    await flushPromises();

    // 浏览器预览返回综合演示数据：各供应商账号直接可见，而不是空态。
    expect(wrapper.text()).not.toContain("还没有接入账号");
    expect(wrapper.text()).not.toContain("桌面接口不可用");
    expect(wrapper.text()).toContain("SuperGrok Pro");
    // antigravity 演示行携带上游原始模型 id（营销名与引擎 id 漂移的真实案例）。
    const details = wrapper.findAll(".quota-detail").map((item) => item.text());
    expect(details).toContain("gemini-3.8-flash-tiered");
    expect(details).toContain("claude-opus-4-6-thinking");
    // 评分环消费演示聚合剩余度（文字在环左侧，数值来自演示读数）。
    expect(wrapper.get(".usage-score-rings").text()).toContain("5h");
    expect(wrapper.get(".usage-score-rings").text()).toContain("周");
    expect(wrapper.findAll(".usage-score-value").map((item) => item.text())).toEqual(["52", "28"]);
    const header = wrapper.get(".content-header");
    expect(header.find(".usage-title-row").exists()).toBe(false);
    expect(header.find(".content-header-copy").exists()).toBe(true);
    expect(header.find(".usage-score-rings").exists()).toBe(true);
    expect(header.find(".outline-action").exists()).toBe(true);
  });

  it("collapses all but the first group on multi-group cards", async () => {
    const wrapper = mountApp(emptyService);
    await flushPromises();

    // v-show 折叠：display 内联为 none；展开时移除。
    const quotaListDisplay = (section: Element | null | undefined): string | null => {
      const list = section?.querySelector(".quota-list");
      return list instanceof HTMLElement ? list.style.display : null;
    };

    // 演示数据里唯一的多组卡片是 antigravity（Gemini Models + Claude and GPT
    // Models）：默认只展开第一组，其余收起只留聚合摘要，避免卡片过长。
    const toggles = wrapper.findAll(".group-toggle");
    expect(toggles).toHaveLength(2);
    expect(toggles[0]?.attributes("aria-expanded")).toBe("true");
    expect(quotaListDisplay(toggles[0]?.element.closest(".quota-group"))).not.toBe("none");
    expect(toggles[1]?.attributes("aria-expanded")).toBe("false");
    const collapsedSection = toggles[1]?.element.closest(".quota-group");
    expect(quotaListDisplay(collapsedSection)).toBe("none");
    expect(collapsedSection?.querySelector(".group-summary")?.textContent).toBe("15%");

    // 手动展开收起的组：额度行重新可见，聚合摘要消失。
    await toggles[1]?.trigger("click");
    expect(toggles[1]?.attributes("aria-expanded")).toBe("true");
    expect(quotaListDisplay(collapsedSection)).not.toBe("none");
    expect(collapsedSection?.querySelector(".group-summary")).toBeNull();
  });

  it("shows session and weekly rings from the snapshot remaining scores", async () => {
    const wrapper = mountApp(
      serviceWithSnapshot({
        ...snapshot([]),
        compositeRemaining: {
          status: "complete",
          sessionScore: 80,
          weeklyScore: 40.4,
          remaining: 40.4,
          band: "attention",
          sessionBand: "healthy",
          weeklyBand: "attention",
          enabledAccountCount: 2,
          scoredAccountCount: 2,
        },
      }),
    );
    await flushPromises();

    const values = wrapper.findAll(".usage-score-value");
    expect(values).toHaveLength(2);
    expect(values[0]?.text()).toBe("80");
    expect(values[1]?.text()).toBe("40");
    expect(wrapper.find(".usage-score-fill.score-band-healthy").exists()).toBe(true);
    expect(wrapper.find(".usage-score-fill.score-band-attention").exists()).toBe(true);
  });

  it("derives presentation rows purely from the catalog", () => {
    const codex = catalogRow("codex");
    expect(codex.provider).toBe("codex");
    expect(codex.name).toBe("OpenAI Codex");
    expect(codex.description).toBe("查看 ChatGPT 订阅中的 Codex 用量。");
    // 占位字符统一取展示名首字符大写，只在无图标资产时渲染。
    expect(codex.mark).toBe("O");
    expect(codex.icon).toMatch(/gpt\.png$/);
    expect(codex.cliImportPath).toBe("~/.codex/auth.json");
    expect(codex.authMethods.map((method) => method.label)).toEqual([
      "浏览器 OAuth",
      "设备码",
      "Codex CLI",
    ]);
    // 套餐标签直接消费主进程解析结果（planLabel），前端不做任何匹配；
    // 未识别档位以 planId: null 显式暴露，展示回退原文并带可见提示。
    const resolvedUsage = (plan: string, planId: string | null, planLabel: string | null) =>
      ({
        accountId: account.id,
        plan,
        planId,
        planLabel,
        overallRemainingPercentage: null,
        groups: [],
        extras: [],
        resetCredits: null,
        fetchedAt: "2026-09-27T00:00:00.000Z",
      }) satisfies PublicUsage;
    expect(planTagLabel(resolvedUsage("prolite", "pro-5x", "Pro 5x"))).toBe("Pro 5x");
    expect(planTagLabel(resolvedUsage("mystery-tier", null, "mystery-tier"))).toBe("mystery-tier");
    expect(planTagLabel(null)).toBeNull();
    expect(isUnrecognizedPlan(resolvedUsage("mystery-tier", null, "mystery-tier"))).toBe(true);
    expect(isUnrecognizedPlan(resolvedUsage("prolite", "pro-5x", "Pro 5x"))).toBe(false);
    expect(isUnrecognizedPlan(resolvedUsage("", null, null))).toBe(false);
    // 占位符跟随名称首字符；未知 offering 不回退到第一行。
    expect(catalogRow("grok-build").mark).toBe("G");
    const unknown = accountPresentation(
      { ...account, offeringId: "unknown-offering" },
      providerCatalogFixture,
    );
    expect(unknown.name).toBe("unknown-offering");
    expect(unknown.mark).toBe("U");
  });

  it("maps quota labels through native names and window durations only", () => {
    expect(
      quotaLabel({
        key: "session",
        displayName: null,
        windowSeconds: 18_000,
        used: 10,
        total: 100,
        remaining: 90,
        remainingPercentage: 90,
        resetAt: null,
        unlimited: false,
      }),
    ).toBe("5 Hours");
    expect(
      quotaLabel({
        key: "session",
        displayName: "Weekly",
        windowSeconds: 604_800,
        used: 10,
        total: 100,
        remaining: 90,
        remainingPercentage: 90,
        resetAt: null,
        unlimited: false,
      }),
    ).toBe("Weekly");
    expect(
      quotaLabel({
        key: "weekly",
        displayName: "Session",
        windowSeconds: 18_000,
        used: 10,
        total: 100,
        remaining: 90,
        remainingPercentage: 90,
        resetAt: null,
        unlimited: false,
      }),
    ).toBe("5 Hours");
    // 原生名已携带窗口信息时不再追加时长后缀（分隔符/复数差异不算新信息）：
    // GLM 的 "5 Hours Quota" 不再展示成 "5 Hours Quota · 5-hour"。
    expect(
      quotaLabel({
        key: "session",
        displayName: "5 Hours Quota",
        windowSeconds: 18_000,
        used: 10,
        total: 100,
        remaining: 90,
        remainingPercentage: 90,
        resetAt: null,
        unlimited: false,
      }),
    ).toBe("5 Hours Quota");
    expect(
      quotaLabel({
        key: "weekly",
        displayName: "Weekly Quota",
        windowSeconds: 604_800,
        used: 10,
        total: 100,
        remaining: 90,
        remainingPercentage: 90,
        resetAt: null,
        unlimited: false,
      }),
    ).toBe("Weekly Quota");
    // 原生名不含窗口信息时后缀仍有增益。
    expect(
      quotaLabel({
        key: "premium",
        displayName: "Premium",
        windowSeconds: 18_000,
        used: 10,
        total: 100,
        remaining: 90,
        remainingPercentage: 90,
        resetAt: null,
        unlimited: false,
      }),
    ).toBe("Premium · 5 Hours");
    expect(
      quotaLabel({
        key: "code_review",
        displayName: null,
        windowSeconds: null,
        used: 0,
        total: 0,
        remaining: null,
        remainingPercentage: null,
        resetAt: null,
        unlimited: false,
      }),
    ).toBe("code review");
    expect(resetCreditTypeLabel("five-hour")).toBe("5 小时周期");
    expect(resetCreditTypeLabel("weekly")).toBe("每周周期");
    expect(resetCreditTypeLabel("banked")).toBe("结转额度");
    expect(resetCreditTypeLabel("future-kind")).toBe("future kind");
    // extras 键固定文案：重置相关统一叫"重置额度"（grok 的计数展示与一等
    // resetCredentials 结构一致），未知键回退连字符转空格。
    expect(extraLabel({ key: "reset-credits", value: "3" })).toBe("重置额度");
    expect(extraLabel({ key: "extra-credits", value: "$1.00" })).toBe("额外额度");
    expect(extraLabel({ key: "auto-top-up", value: "已停用" })).toBe("自动充值");
    expect(extraLabel({ key: "future-extra", value: "x" })).toBe("future extra");
    // 旧版套餐判定：消费 planLegacy，只对已识别档位生效。
    const legacyUsage = (planId: string | null, planLegacy: boolean) =>
      ({
        accountId: "legacy-check",
        plan: "GrokPro",
        planId,
        planLabel: "SuperGrok Pro",
        planLegacy,
        overallRemainingPercentage: null,
        groups: [],
        extras: [],
        resetCredits: null,
        fetchedAt: "2026-09-27T00:00:00.000Z",
      }) satisfies PublicUsage;
    expect(isLegacyPlan(legacyUsage("supergrok-pro", true))).toBe(true);
    expect(isLegacyPlan(legacyUsage("supergrok-pro", false))).toBe(false);
    expect(isLegacyPlan(legacyUsage(null, true))).toBe(false);
    expect(isLegacyPlan(null)).toBe(false);
    expect(authMethodLabel("cli-import")).toBe("CLI 导入");
  });

  it("exposes the Grok Build and Antigravity authentication methods", async () => {
    const grok = catalogRow("grok-build");
    const antigravity = catalogRow("antigravity");
    expect(grok.icon).toMatch(/grok\.svg$/);
    expect(grok.authMethods.map((method) => method.id)).toEqual([
      "device-code",
      "browser-oauth",
      "cli-import",
    ]);
    expect(antigravity.icon).toMatch(/antigravity\.png$/);
    expect(antigravity.authMethods.map((method) => method.id)).toEqual(["browser-oauth"]);

    const startAuth = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        status: "completed",
        account: { ...account, provider: "grok-build", offeringId: "grok-build" },
      },
    });
    const service = Object.assign(new EmptyPolyQuotaService(), { startAuth });
    const wrapper = mount(AuthModal, {
      props: { provider: grok },
      global: { provide: { [polyQuotaServiceKey as symbol]: service } },
    });

    expect(wrapper.text()).toContain("设备码");
    expect(wrapper.text()).toContain("浏览器 OAuth");
    expect(wrapper.text()).toContain("Grok CLI");
    await wrapper.get("footer .primary-action").trigger("click");
    await flushPromises();
    expect(startAuth).toHaveBeenCalledWith({ offeringId: "grok-build", method: "device-code" });
  });

  it("renders the CLI import hint from the catalog source path", async () => {
    const catalogCodex = catalogRow("codex");
    expect(catalogCodex.cliImportPath).toBe("~/.codex/auth.json");
    expect(catalogRow("bigmodel-coding-plan").cliImportPath).toBe("~/.zcode/v2/credentials.json");

    const service = Object.assign(new EmptyPolyQuotaService(), {
      startAuth: vi.fn().mockResolvedValue({
        ok: true,
        value: { status: "completed", account },
      }),
    });
    const wrapper = mount(AuthModal, {
      props: { provider: catalogCodex },
      global: { provide: { [polyQuotaServiceKey as symbol]: service } },
    });
    const cliTab = wrapper
      .findAll(".auth-tabs button")
      .find((button) => button.text() === "Codex CLI");
    await cliTab!.trigger("click");

    expect(wrapper.text()).toContain("检测本地 Codex CLI 凭据文件");
    expect(wrapper.text()).toContain("~/.codex/auth.json");
  });

  it("starts Claude import and OpenCode Go API key auth from catalog data", async () => {
    const claude = catalogRow("claude");
    const opencode = catalogRow("opencode-go");
    expect(claude.cliImportPath).toBe("~/.claude/.credentials.json");
    expect(claude.authMethods.map((method) => method.label)).toEqual(["Claude Code"]);
    expect(opencode.authMethods.map((method) => method.id)).toEqual(["api-key"]);

    const startAuth = vi.fn().mockResolvedValue({
      ok: true,
      value: { status: "completed", account },
    });
    const service = Object.assign(new EmptyPolyQuotaService(), { startAuth });
    const claudeWrapper = mount(AuthModal, {
      props: { provider: claude },
      global: { provide: { [polyQuotaServiceKey as symbol]: service } },
    });
    await claudeWrapper.get("footer .primary-action").trigger("click");
    await flushPromises();
    expect(startAuth).toHaveBeenCalledWith({ offeringId: "claude", method: "cli-import" });

    const opencodeWrapper = mount(AuthModal, {
      props: { provider: opencode },
      global: { provide: { [polyQuotaServiceKey as symbol]: service } },
    });
    await opencodeWrapper.get("input").setValue("oc-key");
    await opencodeWrapper.get("footer .primary-action").trigger("click");
    await flushPromises();
    expect(startAuth).toHaveBeenCalledWith({
      offeringId: "opencode-go",
      method: "api-key",
      apiKey: "oc-key",
    });
  });

  it("renders Codex quota data and account controls", async () => {
    const wrapper = mount(QuotaCard, {
      props: {
        account,
        busy: false,
        providers: providerCatalogFixture,
        usage: {
          accountId: account.id,
          plan: "plus",
          planId: "plus",
          planLabel: "Plus",
          overallRemainingPercentage: 80,
          groups: [
            {
              key: "default",
              displayName: null,
              quotas: [
                {
                  key: "session",
                  displayName: null,
                  windowSeconds: 18_000,
                  used: 7_000,
                  total: 28_000,
                  remaining: 21_000,
                  remainingPercentage: 75,
                  resetAt: "2026-09-25T15:00:00.000Z",
                  unlimited: false,
                  rawAmounts: true,
                },
                {
                  key: "weekly",
                  displayName: null,
                  windowSeconds: 604_800,
                  used: 90,
                  total: 100,
                  remaining: 10,
                  remainingPercentage: 10,
                  resetAt: null,
                  unlimited: false,
                },
              ],
            },
          ],
          extras: [{ key: "extra-credits", value: "$5.00" }],
          resetCredits: null,
          fetchedAt: "2026-09-24T00:00:00.000Z",
        },
      },
    });
    expect(wrapper.get(".plan-tag").text()).toBe("Plus");
    expect(wrapper.text()).toContain("5 Hours");
    expect(wrapper.text()).toContain("Weekly");
    // extras 键走固定文案映射（"extra-credits" → "额外额度"），不再是连字符原文。
    expect(wrapper.text()).toContain("额外额度 $5.00");
    expect(wrapper.find(".switch-field").exists()).toBe(true);
    // 真实原始量的配额在重置时间行右对齐展示 使用量/总量；百分比合成刻度不展示。
    const resetRows = wrapper.findAll(".reset-time");
    expect(resetRows).toHaveLength(1);
    expect(resetRows[0]!.text()).toContain("重置时间：");
    expect(resetRows[0]!.get(".quota-amounts").text()).toBe("7,000 / 28,000");
    await wrapper.get(".extra-button").trigger("click");
    expect(wrapper.text()).toContain("当前值");
    expect(wrapper.text()).toContain("$5.00");
    expect(wrapper.find(".credit-redeem-action").exists()).toBe(false);
  });

  it("marks unrecognized plan tiers visibly instead of silently defaulting", () => {
    const wrapper = mount(QuotaCard, {
      props: {
        account,
        busy: false,
        providers: providerCatalogFixture,
        usage: {
          accountId: account.id,
          // 目录未命中：展示回退原文，且套餐标签旁有可见提示（不再无声落默认倍率）。
          plan: "ChatGPT Super Ultra",
          planId: null,
          planLabel: "ChatGPT Super Ultra",
          overallRemainingPercentage: 80,
          groups: [],
          extras: [],
          resetCredits: null,
          fetchedAt: "2026-09-24T00:00:00.000Z",
        },
      },
    });
    const tag = wrapper.get(".plan-tag");
    expect(tag.text()).toBe("ChatGPT Super Ultra?");
    expect(tag.classes()).toContain("is-unrecognized");
    expect(tag.attributes("title")).toContain("未识别的订阅档位");
    // 未识别档位无从判断新旧，不展示旧版标记。
    expect(wrapper.find(".plan-tag-legacy").exists()).toBe(false);
  });

  it("shows a legacy badge next to the plan tag for catalog legacy plans", () => {
    const wrapper = mount(QuotaCard, {
      props: {
        account: { ...account, provider: "grok-build", offeringId: "grok-build" },
        busy: false,
        providers: providerCatalogFixture,
        usage: {
          accountId: account.id,
          // 目录命中 legacy 条目：planLegacy 随快照下发，标签右侧追加"旧版"。
          plan: "GrokPro",
          planId: "supergrok-pro",
          planLabel: "SuperGrok Pro",
          planLegacy: true,
          overallRemainingPercentage: 45,
          groups: [],
          extras: [],
          resetCredits: null,
          fetchedAt: "2026-09-24T00:00:00.000Z",
        },
      },
    });
    const tags = wrapper.findAll(".provider-title .plan-tag");
    expect(tags).toHaveLength(2);
    expect(tags[0]?.text()).toBe("SuperGrok Pro");
    expect(tags[1]?.text()).toBe("旧版");
    expect(tags[1]?.classes()).toContain("plan-tag-legacy");
    expect(tags[1]?.attributes("title")).toContain("旧版套餐");
  });

  it("keeps refresh available before the first usage snapshot", async () => {
    const wrapper = mount(QuotaCard, {
      props: { account, busy: false, usage: null, providers: providerCatalogFixture },
    });
    expect(wrapper.text()).toContain("尚无用量数据");
    const refresh = wrapper.findAll("button").find((button) => button.text().includes("刷新"));
    expect(refresh).toBeDefined();
    await refresh!.trigger("click");
    expect(wrapper.emitted("refresh")).toHaveLength(1);
  });

  it("keeps BigModel and Z.ai as separate UI services by offering id", () => {
    const bigmodel = { ...account, provider: "glm" as const, offeringId: "bigmodel-coding-plan" };
    const zai = {
      ...account,
      id: "account-2",
      provider: "glm" as const,
      offeringId: "zai-coding-plan",
    };
    expect(accountPresentation(bigmodel, providerCatalogFixture).name).toBe("BigModel Coding Plan");
    expect(accountPresentation(zai, providerCatalogFixture).name).toBe("Z.ai Coding Plan");
    expect(accountPresentation(bigmodel, providerCatalogFixture).icon).toMatch(/bigmodel\.svg$/);
    expect(accountPresentation(zai, providerCatalogFixture).icon).toMatch(/zai\.svg$/);
    expect(accountPresentation(bigmodel, providerCatalogFixture).icon).not.toBe(
      accountPresentation(zai, providerCatalogFixture).icon,
    );
  });

  it("wires the Claude and OpenCode Go provider icons", () => {
    const claude = accountPresentation(
      { ...account, provider: "claude", offeringId: "claude" },
      providerCatalogFixture,
    );
    const opencode = accountPresentation(
      { ...account, provider: "opencode-go", offeringId: "opencode-go" },
      providerCatalogFixture,
    );
    const copilot = accountPresentation(
      { ...account, provider: "github-copilot", offeringId: "github-copilot" },
      providerCatalogFixture,
    );
    expect(claude.mark).toBe("C");
    expect(claude.icon).toMatch(/claude\.svg$/);
    expect(opencode.mark).toBe("O");
    expect(opencode.icon).toMatch(/opencode\.png$/);
    expect(copilot.mark).toBe("G");
    expect(copilot.icon).toMatch(/copilot\.svg$/);
    expect(copilot.authMethods.map((method) => method.label)).toEqual(["设备码"]);
  });

  it("keeps only the method-specific explanation in the account modal", async () => {
    const wrapper = mount(ProvidersView, {
      props: {
        accounts: [],
        presentations: catalogPresentations(providerCatalogFixture),
        busy: false,
      },
      global: { provide: { [polyQuotaServiceKey as symbol]: emptyService } },
    });
    const zaiRow = wrapper
      .findAll(".provider-row")
      .find((row) => row.text().includes("Z.ai Coding Plan"));
    // 名称与状态占第一行，描述独立第二行，不再挤进同一行。
    const heading = zaiRow!.get(".provider-heading");
    expect(heading.get(".provider-name-row h2").text()).toBe("Z.ai Coding Plan");
    expect(heading.get(".provider-name-row .provider-status").text()).toContain("尚未接入");
    expect(heading.get(".provider-description").text()).toContain("智谱国际版 Coding Plan");
    expect(heading.findAll(".provider-name-row .provider-description")).toHaveLength(0);
    const addButton = zaiRow?.findAll("button").find((button) => button.text() === "添加账号");

    await addButton!.trigger("click");
    expect(wrapper.text()).toContain("只读取现有凭据并保存应用自己的加密副本");
    expect(wrapper.find(".method-summary").exists()).toBe(false);
    expect(wrapper.find(".modal-note").exists()).toBe(false);
  });

  it("shows OAuth token expiry and emits a manual refresh action", async () => {
    const oauthAccount: PublicAccount = {
      ...account,
      authMethod: "browser-oauth",
      tokenExpiresAt: "2099-09-25T13:00:00.000Z",
    };
    const wrapper = mount(ProvidersView, {
      props: {
        accounts: [oauthAccount],
        presentations: catalogPresentations(providerCatalogFixture),
        busy: false,
      },
    });

    expect(wrapper.text()).toContain("令牌到期：");
    const refreshButton = wrapper.findAll("button").find((button) => button.text() === "刷新令牌");
    expect(refreshButton).toBeDefined();
    await refreshButton!.trigger("click");
    expect(wrapper.emitted("refreshCredentials")?.[0]).toEqual([oauthAccount]);
  });

  it("renders GLM reset-card type and expiry details", async () => {
    const glmAccount: PublicAccount = {
      ...account,
      provider: "glm",
      offeringId: "bigmodel-coding-plan",
    };
    const wrapper = mount(QuotaCard, {
      props: {
        account: glmAccount,
        busy: false,
        providers: providerCatalogFixture,
        usage: {
          accountId: glmAccount.id,
          plan: "Pro",
          planId: "pro",
          planLabel: "Pro",
          overallRemainingPercentage: 75,
          groups: [],
          extras: [],
          resetCredits: {
            kind: "itemized",
            items: [
              { id: "record-1", type: "five-hour", expiresAt: "2099-09-25T13:00:00.000Z" },
              { id: "record-2", type: "weekly", expiresAt: "2099-09-26T13:00:00.000Z" },
            ],
          },
          fetchedAt: "2026-09-25T12:00:00.000Z",
        },
      },
    });
    expect(wrapper.text()).toContain("BigModel Coding Plan");
    expect(wrapper.text()).toContain("重置额度 2");
    await wrapper.get(".extra-button").trigger("click");
    expect(wrapper.text()).toContain("5 小时周期");
    expect(wrapper.text()).toContain("每周周期");
    expect(wrapper.text()).toContain("有效期至");
    expect(wrapper.findAll(".credit-items li")).toHaveLength(2);
    expect(wrapper.findAll(".credit-redeem-action")).toHaveLength(2);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await wrapper.get(".credit-redeem-action").trigger("click");
    expect(wrapper.emitted("redeem")).toBeUndefined();
    confirm.mockReturnValue(true);
    await wrapper.get(".credit-redeem-action").trigger("click");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted("redeem")?.[0]).toEqual([{ kind: "item", itemId: "record-1" }]);
  });

  it("renders aggregate reset credits as per-type buckets", async () => {
    const codexAccount: PublicAccount = { ...account };
    const wrapper = mount(QuotaCard, {
      props: {
        account: codexAccount,
        busy: false,
        providers: providerCatalogFixture,
        usage: {
          accountId: codexAccount.id,
          plan: "plus",
          planId: "plus",
          planLabel: "Plus",
          overallRemainingPercentage: 80,
          groups: [],
          extras: [],
          resetCredits: {
            kind: "aggregate",
            totals: [
              { type: "banked", total: 2 },
              { type: "five-hour", total: 1 },
            ],
          },
          fetchedAt: "2026-09-25T12:00:00.000Z",
        },
      },
    });
    expect(wrapper.text()).toContain("重置额度 3");
    await wrapper.get(".extra-button").trigger("click");
    const rows = wrapper.findAll(".credit-items li");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.text()).toContain("结转额度");
    expect(rows[0]?.text()).toContain("2 次");
    expect(rows[1]?.text()).toContain("5 小时周期");
    expect(rows[1]?.text()).toContain("1 次");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await rows[1]!.get(".credit-redeem-action").trigger("click");
    expect(wrapper.emitted("redeem")?.[0]).toEqual([{ kind: "aggregate", type: "five-hour" }]);
  });

  it("shows a persistent success notice after using a reset credit", async () => {
    const glmAccount: PublicAccount = {
      ...account,
      provider: "glm",
      offeringId: "bigmodel-coding-plan",
      authMethod: "api-key",
    };
    const usage: PublicUsage = {
      accountId: glmAccount.id,
      plan: "Pro",
      planId: "pro",
      planLabel: "Pro",
      overallRemainingPercentage: 75,
      groups: [],
      extras: [],
      resetCredits: {
        kind: "itemized",
        items: [{ id: "record-1", type: "five-hour", expiresAt: null }],
      },
      fetchedAt: "2026-09-27T00:00:00.000Z",
    };
    const redeemResetCredit = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        status: "redeemed",
        accountId: glmAccount.id,
        refreshStatus: "updated",
        remainingResetCredits: 0,
      },
    });
    const service = serviceWithSnapshot(snapshot([glmAccount], { [glmAccount.id]: usage }), {
      redeemResetCredit,
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const wrapper = mountApp(service);
    await flushPromises();

    await wrapper.get(".extra-button").trigger("click");
    await wrapper.get(".credit-redeem-action").trigger("click");
    await vi.waitFor(() =>
      expect(redeemResetCredit).toHaveBeenCalledWith(glmAccount.id, {
        kind: "item",
        itemId: "record-1",
      }),
    );
    await vi.waitFor(() =>
      expect(wrapper.get(".global-message").text()).toBe("重置额度使用成功，剩余 0 次"),
    );
    expect(wrapper.get(".global-message").classes()).toContain("message-success");
  });

  it("renders provider-independent quota groups", async () => {
    const wrapper = mount(QuotaCard, {
      props: {
        account: { ...account, provider: "antigravity", offeringId: "antigravity" },
        busy: false,
        providers: providerCatalogFixture,
        usage: {
          accountId: account.id,
          plan: "Starter",
          planId: "starter",
          planLabel: "Starter",
          overallRemainingPercentage: 75,
          groups: [
            {
              key: "gemini-models",
              displayName: "Gemini Models",
              quotas: [
                {
                  key: "weekly",
                  displayName: "Weekly Quota",
                  windowSeconds: 604_800,
                  used: 25,
                  total: 100,
                  remaining: 75,
                  remainingPercentage: 75,
                  resetAt: null,
                  unlimited: false,
                },
              ],
            },
          ],
          extras: [],
          resetCredits: null,
          fetchedAt: "2026-09-24T00:00:00.000Z",
        },
      },
    });
    expect(wrapper.text()).toContain("Antigravity");
    expect(wrapper.text()).toContain("Gemini Models");
    expect(wrapper.text()).toContain("Weekly Quota");
    expect(wrapper.text()).toContain("75% 剩余");
    await wrapper.get(".group-toggle").trigger("click");
    expect(wrapper.get(".group-summary").text()).toBe("75%");
    expect(wrapper.get(".group-summary").classes()).toContain("text-ok");
  });

  it("lays accounts out in one auto-fill grid keeping the visual order", () => {
    const accounts: PublicAccount[] = [
      account,
      {
        ...account,
        id: "account-2",
        provider: "glm",
        offeringId: "bigmodel-coding-plan",
      },
      { ...account, id: "account-3", provider: "grok-build", offeringId: "grok-build" },
      { ...account, id: "account-4", provider: "antigravity", offeringId: "antigravity" },
    ];
    const wrapper = mount(UsageView, {
      props: { accounts, usage: {}, busy: false, providers: providerCatalogFixture },
    });

    // 自动列数网格（卡片最小 450px）：单一网格容器，卡片按账号顺序排列。
    expect(wrapper.findAll(".quota-column")).toHaveLength(0);
    const cards = wrapper.findAll(".quota-grid .quota-card");
    expect(cards).toHaveLength(4);
    expect(cards.map((card) => card.get(".provider-identity h2").text())).toEqual([
      "OpenAI Codex",
      "BigModel Coding Plan",
      "Grok Build",
      "Antigravity",
    ]);
  });

  it("loads accounts without exposing credentials to the renderer", async () => {
    const service = serviceWithSnapshot(snapshot([account]), {
      getSystemStatus: vi.fn().mockResolvedValue({
        ok: true,
        value: { proxyMode: "system", proxyAddress: "127.0.0.1:7890" },
      }),
    });
    const wrapper = mountApp(service);
    await vi.waitFor(() => expect(wrapper.text()).toContain("te***@example.test"));
    expect(wrapper.text()).not.toMatch(/accessToken|refreshToken|idToken/);
    const settingsButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("设置"));
    expect(settingsButton).toBeDefined();
    await settingsButton!.trigger("click");
    await vi.waitFor(() => expect(wrapper.text()).toContain("系统代理：127.0.0.1:7890"));
  });

  it("subscribes before the first snapshot and reloads after a newer revision", async () => {
    const order: string[] = [];
    let listener!: Parameters<IPolyQuotaService["subscribe"]>[0];
    const dispose = vi.fn();
    const getSnapshot = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push("snapshot");
        return { ok: true as const, value: snapshot([], {}, 1) };
      })
      .mockResolvedValue({ ok: true, value: snapshot([account], undefined, 2) });
    const service = serviceWithSnapshot(snapshot([], {}, 1), {
      getSnapshot,
      subscribe: vi.fn((nextListener) => {
        order.push("subscribe");
        listener = nextListener;
        return dispose;
      }),
    });

    const wrapper = mountApp(service);
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    expect(order).toEqual(["subscribe", "snapshot"]);

    listener({
      schemaVersion: POLYQUOTA_SCHEMA_VERSION,
      instanceId: "test-instance",
      revision: 2,
      reasons: ["accounts"],
      occurredAt: "2026-09-27T00:01:00.000Z",
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain("te***@example.test"));
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    wrapper.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("accepts a low revision after a backend restart and ignores a delayed old snapshot", async () => {
    let listener!: Parameters<IPolyQuotaService["subscribe"]>[0];
    let finishOld!: (value: { ok: true; value: PolyQuotaSnapshot }) => void;
    const first = { ...snapshot([account], undefined, 30), instanceId: "first" };
    const second = { ...snapshot([], {}, 0), instanceId: "second" };
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: first })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValue({ ok: true, value: second });
    const wrapper = mountApp(
      serviceWithSnapshot(first, {
        getSnapshot,
        subscribe: (next) => {
          listener = next;
          return () => undefined;
        },
      }),
    );
    await vi.waitFor(() => expect(wrapper.text()).toContain("te***@example.test"));
    listener({
      schemaVersion: POLYQUOTA_SCHEMA_VERSION,
      instanceId: "first",
      revision: 31,
      reasons: ["accounts"],
      occurredAt: "now",
    });
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    listener({
      schemaVersion: POLYQUOTA_SCHEMA_VERSION,
      instanceId: "second",
      revision: 0,
      reasons: [],
      occurredAt: "now",
      resync: true,
    });
    finishOld({ ok: true, value: { ...first, revision: 31 } });
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(3));
    await flushPromises();
    expect(wrapper.text()).not.toContain("te***@example.test");
    listener({
      schemaVersion: POLYQUOTA_SCHEMA_VERSION,
      instanceId: "second",
      revision: 0,
      reasons: [],
      occurredAt: "now",
      resync: true,
    });
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(4));
    wrapper.unmount();
  });

  it("refreshes a newly connected account before loading its first snapshot", async () => {
    const getSnapshot = vi.fn().mockResolvedValue({ ok: true, value: snapshot([account]) });
    const refreshAccount = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        status: "updated",
        accountId: account.id,
        snapshot: {
          accountId: account.id,
          plan: "plus",
          planId: "plus",
          planLabel: "Plus",
          overallRemainingPercentage: 100,
          groups: [],
          extras: [],
          resetCredits: null,
          fetchedAt: "2026-09-27T00:00:00.000Z",
        },
      },
    });
    const service = serviceWithSnapshot(snapshot([account]), {
      getSnapshot,
      refreshAccount,
    });
    const wrapper = mountApp(service);
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    await flushPromises();
    const providersButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("服务商"));
    expect(providersButton).toBeDefined();
    await providersButton!.trigger("click");

    wrapper.findComponent(ProvidersView).vm.$emit("connected", account);

    await vi.waitFor(() => expect(refreshAccount).toHaveBeenCalledWith(account.id));
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(wrapper.text()).toContain("账号已接入并刷新用量"));
  });

  it("refreshes OAuth credentials from the provider account row", async () => {
    const oauthAccount: PublicAccount = {
      ...account,
      authMethod: "browser-oauth",
      tokenExpiresAt: "2099-09-25T13:00:00.000Z",
    };
    const getSnapshot = vi.fn().mockResolvedValue({ ok: true, value: snapshot([oauthAccount]) });
    const refreshCredentials = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        status: "updated",
        accountId: oauthAccount.id,
        tokenExpiresAt: "2099-09-25T15:00:00.000Z",
      },
    });
    const service = serviceWithSnapshot(snapshot([oauthAccount]), {
      getSnapshot,
      refreshCredentials,
    });
    const wrapper = mountApp(service);
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    const providersButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("服务商"));
    await providersButton!.trigger("click");
    const refreshButton = wrapper.findAll("button").find((button) => button.text() === "刷新令牌");
    await vi.waitFor(() => expect(refreshButton?.attributes("disabled")).toBeUndefined());
    await refreshButton!.trigger("click");

    await vi.waitFor(() => expect(refreshCredentials).toHaveBeenCalledWith(oauthAccount.id));
    await vi.waitFor(() => expect(wrapper.text()).toContain("令牌已刷新"));
  });

  it("dismisses the global message automatically", async () => {
    vi.useFakeTimers();
    const service = serviceWithSnapshot(snapshot([account]), {
      refreshAccount: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          status: "updated",
          accountId: account.id,
          snapshot: {
            accountId: account.id,
            plan: "plus",
            overallRemainingPercentage: 100,
            groups: [],
            extras: [],
            resetCredits: null,
            fetchedAt: "2026-09-27T00:00:00.000Z",
          },
        },
      }),
    });
    const wrapper = mountApp(service);
    await flushPromises();
    await wrapper.get(".quota-card-foot button").trigger("click");
    await flushPromises();

    expect(wrapper.get(".global-message").text()).toBe("用量已刷新");
    await vi.advanceTimersByTimeAsync(8_000);
    await flushPromises();
    expect(wrapper.find(".global-message").exists()).toBe(false);
  });
});
