import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_MULTIPLIER,
  findOffering,
  getProviderDescriptor,
  matchOfferingPlan,
  planMultiplier,
  providerCatalog,
  validateProviderCatalog,
  type ProviderDescriptor,
} from "../src/internal.js";

const catalogFixture: ProviderDescriptor = {
  provider: "codex",
  displayName: "Codex",
  capabilities: ["account", "usage"],
  offerings: [
    {
      id: "codex",
      provider: "codex",
      displayName: "Codex",
      iconKey: "codex",
      authMethods: [{ method: "browser-oauth", interaction: "browser-callback" }],
      plans: [],
    },
  ],
};

describe("provider catalog", () => {
  it("collects the implemented providers with their offerings", () => {
    expect(providerCatalog.map((descriptor) => descriptor.provider)).toEqual([
      "codex",
      "glm",
      "grok-build",
      "antigravity",
      "claude",
      "opencode-go",
      "github-copilot",
    ]);
    expect(getProviderDescriptor("glm").offerings.map((offering) => offering.id)).toEqual([
      "bigmodel-coding-plan",
      "zai-coding-plan",
    ]);
    expect(
      getProviderDescriptor("codex").offerings[0]!.authMethods.map((method) => method.method),
    ).toEqual(["browser-oauth", "device-code", "cli-import"]);
    expect(getProviderDescriptor("claude").offerings[0]!.authMethods[0]?.method).toBe("cli-import");
    expect(getProviderDescriptor("opencode-go").offerings[0]!.authMethods[0]?.method).toBe(
      "api-key",
    );
  });

  it("declares offering facts (iconKey, sourcePathHint) without any region field", () => {
    for (const descriptor of providerCatalog) {
      for (const offering of descriptor.offerings) {
        expect(offering, descriptor.provider).not.toHaveProperty("region");
        expect(offering.iconKey, offering.id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
        for (const method of offering.authMethods) {
          if (method.method === "cli-import") {
            expect(method.sourcePathHint, offering.id).toBeTruthy();
          } else {
            expect(method.sourcePathHint ?? "").toBe("");
          }
        }
      }
    }
    expect(getProviderDescriptor("codex").offerings[0]!.iconKey).toBe("codex");
    expect(getProviderDescriptor("glm").offerings.map((offering) => offering.iconKey)).toEqual([
      "bigmodel",
      "zai",
    ]);
    expect(
      getProviderDescriptor("codex").offerings[0]!.authMethods.find(
        (method) => method.method === "cli-import",
      )?.sourcePathHint,
    ).toBe("~/.codex/auth.json");
  });

  it("declares only implemented capabilities on every provider", () => {
    for (const descriptor of providerCatalog) {
      expect(descriptor.capabilities, descriptor.provider).toEqual(["account", "usage"]);
    }
  });

  it("resolves offerings back to their owning provider", () => {
    expect(findOffering("zai-coding-plan")?.provider).toBe("glm");
    expect(findOffering("grok-build")?.offering.displayName).toBe("Grok Build");
    expect(findOffering("claude")?.provider).toBe("claude");
    expect(findOffering("opencode-go")?.provider).toBe("opencode-go");
    expect(findOffering("unknown-offering")).toBeNull();
  });

  it("rejects duplicate providers, offerings, methods and broken ownership", () => {
    expect(() => validateProviderCatalog([catalogFixture, { ...catalogFixture }])).toThrow(
      /duplicate provider/,
    );
    expect(() =>
      validateProviderCatalog([
        {
          ...catalogFixture,
          offerings: [...catalogFixture.offerings, { ...catalogFixture.offerings[0]! }],
        },
      ]),
    ).toThrow(/duplicate offering/);
    expect(() =>
      validateProviderCatalog([
        {
          ...catalogFixture,
          offerings: [
            {
              ...catalogFixture.offerings[0]!,
              authMethods: [
                ...catalogFixture.offerings[0]!.authMethods,
                ...catalogFixture.offerings[0]!.authMethods,
              ],
            },
          ],
        },
      ]),
    ).toThrow(/duplicate method/);
    expect(() =>
      validateProviderCatalog([
        {
          ...catalogFixture,
          offerings: [{ ...catalogFixture.offerings[0]!, provider: "glm" }],
        },
      ]),
    ).toThrow(/owned by/);
    expect(() => validateProviderCatalog([{ ...catalogFixture, offerings: [] }])).toThrow(
      /no offerings/,
    );
  });

  it("rejects duplicate plan ids, match keys, and invalid multipliers per offering", () => {
    const plan = {
      id: "plus",
      displayName: "Plus",
      match: ["plus"],
      multiplier: 1,
      source: "published" as const,
    };
    expect(() =>
      validateProviderCatalog([
        {
          ...catalogFixture,
          offerings: [
            { ...catalogFixture.offerings[0]!, plans: [plan, { ...plan, match: ["plus-alias"] }] },
          ],
        },
      ]),
    ).toThrow(/duplicate plan/);
    expect(() =>
      validateProviderCatalog([
        {
          ...catalogFixture,
          offerings: [
            {
              ...catalogFixture.offerings[0]!,
              plans: [plan, { ...plan, id: "plus-2", match: ["PLUS"] }],
            },
          ],
        },
      ]),
    ).toThrow(/duplicate plan match/);
    expect(() =>
      validateProviderCatalog([
        {
          ...catalogFixture,
          offerings: [{ ...catalogFixture.offerings[0]!, plans: [{ ...plan, multiplier: 0 }] }],
        },
      ]),
    ).toThrow(/invalid plan multiplier/);
  });

  it("enforces legacy pairing, ISO dates, and source URLs on plan entries", () => {
    const plan = {
      id: "legacy-tier",
      displayName: "Legacy",
      match: ["legacy tier"],
      multiplier: 5,
      source: "published" as const,
    };
    const withPlan = (overrides: Record<string, unknown>) =>
      validateProviderCatalog([
        {
          ...catalogFixture,
          offerings: [{ ...catalogFixture.offerings[0]!, plans: [{ ...plan, ...overrides }] }],
        },
      ]);

    expect(() => withPlan({ legacyUntil: "2026-10-29" })).toThrow(/legacyUntil without legacy/);
    expect(() => withPlan({ legacy: true, legacyUntil: "2026-10-29" })).not.toThrow();
    expect(() => withPlan({ legacy: true, legacyUntil: "2026-10-29T00:00:00Z" })).toThrow(
      /invalid legacyUntil/,
    );
    expect(() => withPlan({ legacy: true, legacyUntil: "2026-02-30" })).toThrow(
      /invalid legacyUntil/,
    );
    expect(() => withPlan({ sourceUrl: "x.ai/pricing" })).toThrow(/invalid sourceUrl/);
    expect(() => withPlan({ sourceUrl: "https://x.ai/pricing" })).not.toThrow();
    expect(() => withPlan({ verifiedAt: "2026-10-14" })).not.toThrow();
    expect(() => withPlan({ verifiedAt: "yesterday" })).toThrow(/invalid verifiedAt/);
  });

  it("rejects regex keys that would swallow every unrecognized tier", () => {
    const plan = {
      id: "catch-all",
      displayName: "Catch All",
      multiplier: 1,
      source: "inferred" as const,
    };
    const withMatch = (match: (string | RegExp)[]) =>
      validateProviderCatalog([
        {
          ...catalogFixture,
          offerings: [{ ...catalogFixture.offerings[0]!, plans: [{ ...plan, match }] }],
        },
      ]);

    expect(() => withMatch([/^/])).toThrow(/match-all regex/);
    expect(() => withMatch([/./])).toThrow(/match-all regex/);
    expect(() => withMatch([/.*/])).toThrow(/match-all regex/);
    expect(() => withMatch([/^a?/])).toThrow(/match-all regex/);
    // 有指向性的兜底正则不受影响；正则之间的重复不参与静态查重。
    expect(() => withMatch([/^self serve business/, /^self serve business/])).not.toThrow();
    expect(() => withMatch([/starter/])).not.toThrow();
  });

  it("rejects unknown capabilities and malformed offering facts", () => {
    expect(() =>
      validateProviderCatalog([
        { ...catalogFixture, capabilities: ["account", "usage", "ghost" as never] },
      ]),
    ).toThrow(/unknown capability: ghost/);
    expect(() =>
      validateProviderCatalog([
        { ...catalogFixture, offerings: [{ ...catalogFixture.offerings[0]!, iconKey: "Bad Key" }] },
      ]),
    ).toThrow(/invalid icon key/);
    expect(() =>
      validateProviderCatalog([
        {
          ...catalogFixture,
          offerings: [
            {
              ...catalogFixture.offerings[0]!,
              authMethods: [
                { method: "cli-import", interaction: "local-import", sourcePathHint: " " },
              ],
            },
          ],
        },
      ]),
    ).toThrow(/invalid source path hint/);
  });
});

describe("provider plan catalog", () => {
  it("matches known identifiers per offering without guessing unmatched names", () => {
    expect(planMultiplier("codex", "go")).toBe(0.1);
    expect(planMultiplier("codex", "plus")).toBe(1);
    expect(planMultiplier("codex", "prolite")).toBe(5);
    expect(planMultiplier("codex", "pro_5x")).toBe(5);
    // Pro $200 新订口径（2026-09 重新开放后官方 ~10x，实测）。
    expect(planMultiplier("codex", "pro")).toBe(10);
    expect(planMultiplier("codex", "pro 20x")).toBe(20);
    expect(planMultiplier("codex", "team")).toBe(5);
    expect(matchOfferingPlan("codex", "ChatGPT Super Ultra")).toBeNull();
    expect(planMultiplier("codex", "ChatGPT Super Ultra")).toBe(DEFAULT_PLAN_MULTIPLIER);

    expect(planMultiplier("bigmodel-coding-plan", "Glm Coding Pro")).toBe(6);
    expect(planMultiplier("zai-coding-plan", "max")).toBe(14);
    expect(planMultiplier("claude", "pro")).toBe(1);
    expect(planMultiplier("claude", "max")).toBe(20);
    expect(planMultiplier("claude", "default_claude_max_20x")).toBe(20);
    expect(planMultiplier("claude", "Max 5x")).toBe(5);
    expect(planMultiplier("antigravity", "Free")).toBe(0.1);
    expect(planMultiplier("antigravity", "Plus")).toBe(1);
    // 官方已发布 Pro 为 1x 基线（2026-05-19 改版）。
    expect(planMultiplier("antigravity", "Pro")).toBe(1);
    expect(planMultiplier("antigravity", "Ultra 5x")).toBe(5);
    expect(planMultiplier("antigravity", "Ultra")).toBe(20);
    expect(planMultiplier("grok-build", "SuperGrok Pro")).toBe(5);
    expect(planMultiplier("grok-build", "SuperGrok Heavy")).toBe(20);
    expect(planMultiplier("opencode-go", "OpenCode Go")).toBe(5);
    // AI Credits 合计口径（7000/1500 ≈ 4.6）与新增 Max 档（20000/1500 ≈ 13.3）。
    // copilot_plan 实测为短词（free / pro / PRO_PLUS / business …），与
    // access_type_sku 形态（copilot_pro_plus / copilot_business_seat）同表覆盖。
    expect(planMultiplier("github-copilot", "Copilot Pro+")).toBe(4.6);
    expect(planMultiplier("github-copilot", "copilot_pro_plus")).toBe(4.6);
    expect(planMultiplier("github-copilot", "PRO_PLUS")).toBe(4.6);
    expect(planMultiplier("github-copilot", "pro")).toBe(1);
    expect(planMultiplier("github-copilot", "Copilot Max")).toBe(13.3);
    expect(planMultiplier("github-copilot", "max")).toBe(13.3);
    expect(planMultiplier("github-copilot", "Copilot Business")).toBe(1);
    expect(planMultiplier("github-copilot", "copilot_business_seat")).toBe(1);
    expect(planMultiplier("github-copilot", "student")).toBe(1);
    expect(planMultiplier("github-copilot", "enterprise")).toBe(3.3);
    // 实测免费账号：copilot_plan 短词与 access_type_sku 两种形态都命中；
    // "individual" 为真实账号观测（2026-10-15，免费档配额形态）。
    expect(planMultiplier("github-copilot", "Copilot Free")).toBe(0.1);
    expect(planMultiplier("github-copilot", "free")).toBe(0.1);
    expect(planMultiplier("github-copilot", "free_limited")).toBe(0.1);
    expect(planMultiplier("github-copilot", "individual")).toBe(0.1);
    expect(planMultiplier("bigmodel-coding-plan", "")).toBe(DEFAULT_PLAN_MULTIPLIER);
    // 未知接入点不查表、不回退到相似 provider 的目录。
    expect(planMultiplier("unknown-offering", "plus")).toBe(DEFAULT_PLAN_MULTIPLIER);
  });

  it("matches Grok's new tiers and keeps the legacy SuperGrok entries", () => {
    // 2026-06 改版四档（官方倍率相对 Plus 基线），字符串键为推测形态。
    expect(planMultiplier("grok-build", "plus")).toBe(1);
    expect(planMultiplier("grok-build", "premium")).toBe(4);
    expect(planMultiplier("grok-build", "super")).toBe(15);
    expect(planMultiplier("grok-build", "ultra")).toBe(50);
    // tier 缺失时的兜底合成标识照常命中。
    expect(planMultiplier("grok-build", "Grok Build")).toBe(5);
    const legacyPro = matchOfferingPlan("grok-build", "SuperGrok Pro");
    expect(legacyPro).toMatchObject({ id: "supergrok-pro", legacy: true });
    const legacyHeavy = matchOfferingPlan("grok-build", "SuperGrok Heavy");
    expect(legacyHeavy).toMatchObject({ id: "supergrok-heavy", legacy: true });
  });

  it("adds Codex promax and folds B-side variants through regex fallback keys", () => {
    expect(planMultiplier("codex", "promax")).toBe(25);
    expect(matchOfferingPlan("codex", "promax")).toMatchObject({
      id: "promax",
      displayName: "Pro 500",
    });
    expect(planMultiplier("codex", "self_serve_business_prolite")).toBe(5);
    expect(matchOfferingPlan("codex", "self_serve_business_usage_based")?.id).toBe("business");
    expect(planMultiplier("codex", "ent26")).toBe(5);
    expect(matchOfferingPlan("codex", "enterprise_cbp_automation")?.id).toBe("enterprise");
    expect(planMultiplier("codex", "edu_plus")).toBe(5);
    expect(matchOfferingPlan("codex", "edu_pro")?.id).toBe("edu");
    expect(planMultiplier("codex", "business")).toBe(5);
  });

  it("keeps exact string keys ahead of regex fallback keys", () => {
    // 先精确后正则：`starter` 精确键必须赢过同为子串语义的正则顺序竞争，
    // 而未声明的宽泛模式（如 /pro/）抢不走 `prolite` 的精确命中。
    expect(matchOfferingPlan("antigravity", "starter")?.id).toBe("starter");
    expect(matchOfferingPlan("codex", "prolite")?.id).toBe("pro-5x");
    // 正则只作用于规范化后的小写串：声明端按小写书写。
    expect(matchOfferingPlan("antigravity", "Antigravity Starter Quota")?.id).toBe("starter");
    expect(matchOfferingPlan("antigravity", "ANTIGRAVITY ULTRA 5X (BETA)")?.id).toBe("ultra-5x");
    // ultra-5x 声明在 ultra 之前，具体正则先于宽泛兜底求值。
    expect(matchOfferingPlan("antigravity", "Antigravity Ultra (Yearly)")?.id).toBe("ultra");
    // 单词边界：`super` 正则不得吞掉 `supergrok` 形态（旧档走 legacy 精确键）。
    expect(matchOfferingPlan("grok-build", "SuperGrok Pro")?.legacy).toBe(true);
    // grok 的 \bsuper\b 不命中 "supergrok"（无边界），也不命中任何已声明键。
    expect(matchOfferingPlan("grok-build", "supergrok")).toBeNull();
    expect(matchOfferingPlan("grok-build", "Super Tier X")?.id).toBe("super");
    // 多个兜底词同时命中时按条目声明顺序取第一个（正则只是纯兜底，真实
    // subscriptionTier 预期为单词档位形态，此类输入本就未识别）。
    expect(matchOfferingPlan("grok-build", "X Premium Plus")?.id).toBe("plus");
  });

  it("lists a plan catalog on every registered offering", () => {
    for (const descriptor of providerCatalog) {
      for (const offering of descriptor.offerings) {
        expect(offering.plans.length, offering.id).toBeGreaterThan(0);
      }
    }
  });
});
