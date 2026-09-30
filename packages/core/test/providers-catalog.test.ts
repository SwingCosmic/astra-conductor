import { describe, expect, it } from "vitest";
import {
  findOffering,
  getProviderDescriptor,
  providerCatalog,
  validateProviderCatalog,
  type ProviderDescriptor,
} from "../src/internal.js";

describe("provider catalog", () => {
  it("collects the four first-party providers with their offerings", () => {
    expect(providerCatalog.map((descriptor) => descriptor.provider)).toEqual([
      "codex",
      "glm",
      "grok-build",
      "antigravity",
    ]);
    expect(getProviderDescriptor("glm").offerings.map((offering) => offering.id)).toEqual([
      "bigmodel-coding-plan",
      "zai-coding-plan",
    ]);
    expect(getProviderDescriptor("glm").offerings.map((offering) => offering.region)).toEqual([
      "china",
      "international",
    ]);
    expect(
      getProviderDescriptor("codex").offerings[0]!.authMethods.map((method) => method.method),
    ).toEqual(["browser-oauth", "device-code", "cli-import"]);
  });

  it("resolves offerings back to their owning provider", () => {
    expect(findOffering("zai-coding-plan")?.provider).toBe("glm");
    expect(findOffering("grok-build")?.offering.displayName).toBe("Grok Build");
    expect(findOffering("unknown-offering")).toBeNull();
  });

  it("rejects duplicate providers, offerings, methods and broken ownership", () => {
    const base: ProviderDescriptor = {
      provider: "codex",
      displayName: "Codex",
      offerings: [
        {
          id: "codex",
          provider: "codex",
          displayName: "Codex",
          authMethods: [{ method: "browser-oauth", interaction: "browser-callback" }],
        },
      ],
    };
    expect(() => validateProviderCatalog([base, { ...base }])).toThrow(/duplicate provider/);
    expect(() =>
      validateProviderCatalog([
        {
          ...base,
          offerings: [...base.offerings, { ...base.offerings[0]! }],
        },
      ]),
    ).toThrow(/duplicate offering/);
    expect(() =>
      validateProviderCatalog([
        {
          ...base,
          offerings: [
            {
              ...base.offerings[0]!,
              authMethods: [...base.offerings[0]!.authMethods, ...base.offerings[0]!.authMethods],
            },
          ],
        },
      ]),
    ).toThrow(/duplicate method/);
    expect(() =>
      validateProviderCatalog([
        {
          ...base,
          offerings: [{ ...base.offerings[0]!, provider: "glm" }],
        },
      ]),
    ).toThrow(/owned by/);
    expect(() => validateProviderCatalog([{ ...base, offerings: [] }])).toThrow(/no offerings/);
  });
});
