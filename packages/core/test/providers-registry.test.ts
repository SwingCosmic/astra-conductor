import { providerServices } from "./service-helpers.js";
import { describe, expect, it } from "vitest";
import {
  CredentialVault,
  MemoryStorage,
  ProviderRegistry,
  createProviderContributions,
  providerCatalog,
  type Account,
  type CredentialEnvelope,
  type CredentialCipherPort,
  type ProviderContribution,
} from "../src/internal.js";

class FakeCipher implements CredentialCipherPort {
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async encrypt(plaintext: string): Promise<Uint8Array> {
    return Buffer.from(plaintext);
  }

  async decrypt(ciphertext: Uint8Array): Promise<{ plaintext: string; shouldReEncrypt: boolean }> {
    return { plaintext: Buffer.from(ciphertext).toString(), shouldReEncrypt: false };
  }
}

function fullRegistry(): ProviderRegistry {
  const storage = new MemoryStorage();
  const vault = new CredentialVault(storage, new FakeCipher());
  return new ProviderRegistry(
    createProviderContributions(
      providerServices({
        http: { fetch },
        clock: { now: () => new Date(0) },
        callbackServer: { start: async () => ({ port: 0 }) },
        storage,
        vault,
      }),
    ),
  );
}

function codexDescriptor(): ProviderContribution["descriptor"] {
  const descriptor = providerCatalog.find((item) => item.provider === "codex");
  if (!descriptor) throw new Error("missing codex descriptor");
  return descriptor;
}

const codexFacets = {
  account: {
    providerId: "codex" as const,
    supportedMethods: ["browser-oauth", "device-code", "cli-import"] as const,
    startAuth: async () => {
      throw new Error("not used");
    },
  },
  usage: {
    providerId: "codex" as const,
    fetchUsage: async () => {
      throw new Error("not used");
    },
  },
};

describe("provider registry", () => {
  it("rejects a facet bound to another contribution", () => {
    expect(
      () =>
        new ProviderRegistry([
          {
            descriptor: { ...codexDescriptor() },
            account: { ...codexFacets.account, providerId: "glm" },
            usage: codexFacets.usage,
          },
        ]),
    ).toThrow(/Account facet of glm is bound to contribution codex/);
  });

  it("rejects duplicate contributions for one provider", () => {
    const contribution: ProviderContribution = {
      descriptor: codexDescriptor(),
      ...codexFacets,
    };
    expect(() => new ProviderRegistry([contribution, contribution])).toThrow(
      /duplicate provider: codex/,
    );
  });

  it("rejects a declared capability without its facet", () => {
    expect(
      () => new ProviderRegistry([{ descriptor: codexDescriptor(), account: codexFacets.account }]),
    ).toThrow(/declares usage capability without a facet/);
  });

  it("rejects a facet that is not declared as a capability", () => {
    expect(
      () =>
        new ProviderRegistry([
          {
            descriptor: { ...codexDescriptor(), capabilities: ["account"] },
            ...codexFacets,
          },
        ]),
    ).toThrow(/provides a usage facet without declaring it/);
  });

  it("rejects capabilities that no facet implements yet", () => {
    expect(
      () =>
        new ProviderRegistry([
          {
            descriptor: { ...codexDescriptor(), capabilities: ["account", "usage", "inference"] },
            ...codexFacets,
          },
        ]),
    ).toThrow(/declares inference, which no facet implements yet/);
  });

  it("rejects unknown capability names", () => {
    expect(
      () =>
        new ProviderRegistry([
          {
            descriptor: {
              ...codexDescriptor(),
              capabilities: ["account", "usage", "quantum" as never],
            },
            ...codexFacets,
          },
        ]),
    ).toThrow(/unknown capability: quantum/);
  });

  it("rejects duplicate offerings across contributions", () => {
    const grokDescriptor = providerCatalog.find((item) => item.provider === "grok-build");
    if (!grokDescriptor) throw new Error("missing grok descriptor");
    const grokContribution: ProviderContribution = {
      descriptor: {
        ...grokDescriptor,
        offerings: [{ ...grokDescriptor.offerings[0]!, id: "codex", provider: "grok-build" }],
      },
      account: {
        providerId: "grok-build",
        supportedMethods: ["device-code", "browser-oauth", "cli-import"],
        startAuth: async () => {
          throw new Error("not used");
        },
      },
      usage: {
        providerId: "grok-build",
        fetchUsage: async () => {
          throw new Error("not used");
        },
      },
    };
    expect(() => new ProviderRegistry([codexDescriptorContribution(), grokContribution])).toThrow(
      /duplicate offering: codex/,
    );
  });

  it("fails lookup with explicit errors instead of falling back", () => {
    const registry = new ProviderRegistry([codexDescriptorContribution()]);
    expect(registry.findOffering("bigmodel-coding-plan")).toBeNull();
    expect(registry.getDescriptor("glm")).toBeNull();
    expect(registry.getAccount("glm")).toBeNull();
    expect(registry.getUsage("glm")).toBeNull();
    expect(() => registry.requireDescriptor("glm")).toThrow(/服务商未注册：glm/);
    expect(() => registry.requireUsage("glm")).toThrow(/服务商用量能力不可用：glm/);
  });

  it("resolves both GLM offerings to the same facets and never cross providers", () => {
    const registry = fullRegistry();
    const bigmodel = registry.findOffering("bigmodel-coding-plan");
    const zai = registry.findOffering("zai-coding-plan");
    expect(bigmodel?.provider).toBe("glm");
    expect(zai?.provider).toBe("glm");
    expect(registry.getUsage(bigmodel!.provider)).toBe(registry.getUsage(zai!.provider));

    const codexUsage = registry.requireUsage("codex");
    expect(codexUsage).not.toBe(registry.getUsage("glm"));
    expect(codexUsage.providerId).toBe("codex");
  });

  it("derives redeemResetCard and refreshCredentials from the provider facts", () => {
    const registry = fullRegistry();
    expect(typeof registry.requireUsage("codex").redeemResetCard).toBe("function");
    expect(typeof registry.requireUsage("glm").redeemResetCard).toBe("function");
    expect(registry.requireUsage("grok-build").redeemResetCard).toBeUndefined();
    expect(typeof registry.requireAccount("codex").refreshCredentials).toBe("function");
    expect(registry.requireAccount("glm").refreshCredentials).toBeUndefined();
    expect(registry.requireAccount("opencode-go").refreshCredentials).toBeUndefined();
  });

  it.each([
    { provider: "codex", minutes: 5, allowsOverride: true },
    { provider: "claude", minutes: 5, allowsOverride: true },
    { provider: "antigravity", minutes: 15, allowsOverride: false },
    { provider: "grok-build", minutes: 5, allowsOverride: false },
  ])(
    "applies the registered expiry policy for $provider",
    ({ provider, minutes, allowsOverride }) => {
      const check = fullRegistry().requireAccount(provider).canUseCurrentCredentials!;
      const account: Account = {
        id: "account",
        provider,
        offeringId: provider,
        authMethod: "browser-oauth",
        stableIdentity: "test",
        displayName: "test",
        maskedIdentifier: "***",
        enabled: true,
        credentialState: "available",
        publicMetadata: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      const boundary = minutes * 60_000;
      const envelope: CredentialEnvelope = {
        version: 1,
        accountId: account.id,
        provider,
        authMethod: account.authMethod,
        expiresAt: new Date(boundary).toISOString(),
        secrets: { accessToken: "fictional" },
      };
      expect(check(account, envelope)).toBe(false);
      expect(check(account, { ...envelope, expiresAt: new Date(boundary + 1).toISOString() })).toBe(
        true,
      );
      expect(check(account, { ...envelope, expiresAt: null })).toBe(false);
      expect(check({ ...account, publicMetadata: { refreshLeadMs: 60_000 } }, envelope)).toBe(
        allowsOverride,
      );
    },
  );

  it("aggregates exactly the catalog providers", () => {
    const registry = fullRegistry();
    expect(registry.descriptors.map((descriptor) => descriptor.provider)).toEqual(
      providerCatalog.map((descriptor) => descriptor.provider),
    );
  });
});

function codexDescriptorContribution(): ProviderContribution {
  return { descriptor: codexDescriptor(), ...codexFacets };
}
