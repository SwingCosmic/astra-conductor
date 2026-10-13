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
    expect(planMultiplier("codex", "pro")).toBe(5);
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
    expect(planMultiplier("antigravity", "Pro")).toBe(5);
    expect(planMultiplier("antigravity", "Ultra")).toBe(20);
    expect(planMultiplier("grok-build", "SuperGrok Pro")).toBe(5);
    expect(planMultiplier("grok-build", "SuperGrok Heavy")).toBe(20);
    expect(planMultiplier("opencode-go", "OpenCode Go")).toBe(5);
    expect(planMultiplier("bigmodel-coding-plan", "")).toBe(DEFAULT_PLAN_MULTIPLIER);
    // 未知接入点不查表、不回退到相似 provider 的目录。
    expect(planMultiplier("unknown-offering", "plus")).toBe(DEFAULT_PLAN_MULTIPLIER);
  });

  it("lists a plan catalog on every registered offering", () => {
    for (const descriptor of providerCatalog) {
      for (const offering of descriptor.offerings) {
        expect(offering.plans.length, offering.id).toBeGreaterThan(0);
      }
    }
  });
});
