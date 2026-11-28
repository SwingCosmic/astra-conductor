import { describe, expect, it, vi } from "vitest";
import {
  modelEndpointDescriptor,
  protocolFamilyDescriptors,
} from "@astra-conductor/contract/common";
import {
  AuthCoordinator,
  CommonProviderApplicationService,
  CredentialVault,
  MemoryStorage,
  ProviderRegistry,
  createProviderContributions,
  discoverRouteModels,
  previewModelChat,
  projectDiscoveredModels,
  resolveModelRoutes,
  sendModelChatDetailed,
  supportsSubscriptionUsage,
} from "../src/internal.js";
import { providerServices } from "./service-helpers.js";

const key = "fictional-gemini-api-key";

function setup(
  offeringFilter?: ConstructorParameters<
    typeof CommonProviderApplicationService
  >[0]["offeringFilter"],
) {
  const storage = new MemoryStorage();
  const vault = new CredentialVault(storage, {
    isAvailable: async () => true,
    encrypt: async (text) => Buffer.from(text),
    decrypt: async (bytes) => ({
      plaintext: Buffer.from(bytes).toString(),
      shouldReEncrypt: false,
    }),
  });
  const registry = new ProviderRegistry(
    createProviderContributions(
      providerServices({
        storage,
        vault,
        http: { fetch: vi.fn() },
        callbackServer: { start: async () => ({ port: 0 }) },
      }),
    ),
  );
  const service = new CommonProviderApplicationService({
    storage,
    registry,
    credentials: vault,
    auth: new AuthCoordinator(registry),
    offeringFilter,
  });
  return { storage, vault, registry, service };
}

describe("Gemini API protocol, catalog discovery, and provider offering", () => {
  it("registers gemini-generate-content and gemini family catalog metadata", () => {
    expect(protocolFamilyDescriptors.gemini).toEqual({
      family: "gemini",
      label: "Gemini 协议族",
      nativeVersionPath: "/v1beta",
      catalogPath: "models",
      supportsCatalog: true,
    });
    expect(modelEndpointDescriptor("gemini-generate-content")).toMatchObject({
      protocol: "gemini-generate-content",
      protocolFamily: "gemini",
      modelType: "text-llm",
      operation: "chat",
      relativePath: "models/{model}:generateContent",
      modelIdLocation: "path",
      authentication: "x-goog-api-key",
      canDiscover: true,
      chatExecutable: true,
    });
  });

  it("creates Gemini API connections, paginates /v1beta/models, and runs preview & chat", async () => {
    const { service, storage, vault, registry } = setup();
    const created = await service.createConnection({
      providerId: "gemini",
      offeringId: "gemini-api-key",
      displayName: "Google Gemini",
      operationId: "gemini-op-1",
      apiKey: key,
      routes: [],
    });

    expect(created.routes.map((r) => r.protocol)).toEqual([
      "gemini-generate-content",
      "gemini-tts",
    ]);
    const account = storage.accounts.get(created.accountId)!;
    const envelope = await vault.load(account.id);
    expect(supportsSubscriptionUsage(account, registry)).toBe(false);

    const snapshot = await service.getSnapshot();
    expect(snapshot.accounts[0]).toMatchObject({
      provider: "gemini",
      offeringId: "gemini-api-key",
      isCustom: false,
      authMethodLabel: "API Key",
    });
    expect(snapshot.connections[0]).toMatchObject({
      providerId: "gemini",
      isCustom: false,
      authMethodLabel: "API Key",
    });

    const routes = resolveModelRoutes(account, envelope, service.routeSource);
    const chatRoute = routes.find((r) => r.protocol === "gemini-generate-content")!;
    expect(chatRoute.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(chatRoute.familyCatalog).toBe("native");

    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          models: [
            {
              name: "models/gemini-2.5-pro",
              displayName: "Gemini 2.5 Pro",
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
              thinking: true,
              supportedGenerationMethods: ["generateContent", "countTokens"],
            },
            {
              name: "models/gemini-2.5-flash-preview-tts",
              displayName: "Gemini 2.5 Flash TTS",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
          nextPageToken: "page-2-token",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          models: [
            {
              name: "models/text-embedding-004",
              displayName: "Text Embedding 004",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        }),
      );

    const familyModels = await discoverRouteModels(
      { fetch },
      account,
      envelope,
      chatRoute,
      undefined,
      service.routeSource,
      "family",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models",
    );
    expect(String(fetch.mock.calls[1][0])).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageToken=page-2-token",
    );
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("x-goog-api-key")).toBe(key);
    expect(familyModels.map((m) => m.modelId)).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash-preview-tts",
      "text-embedding-004",
    ]);
    expect(familyModels[0]).toMatchObject({
      modelId: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      facts: {
        contextWindow: 1048576,
        maxInputTokens: 1048576,
        maxOutputTokens: 65536,
        reasoningMode: "effort",
        operations: ["chat"],
      },
    });
    expect(
      projectDiscoveredModels(familyModels, "gemini-generate-content").map((m) => m.modelId),
    ).toEqual(["gemini-2.5-pro"]);
    expect(projectDiscoveredModels(familyModels, "gemini-tts").map((m) => m.modelId)).toEqual([
      "gemini-2.5-flash-preview-tts",
    ]);

    const preview = previewModelChat(
      account,
      chatRoute,
      "gemini-2.5-pro",
      {
        contextWindow: null,
        maxOutputTokens: 1024,
        effort: "medium",
        thinkingEnabled: true,
        temperature: 0.5,
      },
      service.routeSource,
      { facts: { reasoningMode: "effort", reasoningOutputMode: "summary" } },
    );
    expect(preview.relativePath).toBe("models/gemini-2.5-pro:generateContent");
    expect(preview.headers["x-goog-api-key"]).toBe("<redacted>");
    expect(preview.body).toEqual({
      contents: [{ role: "user", parts: [{ text: "Hello from GraphAgent." }] }],
      generationConfig: {
        maxOutputTokens: 1024,
        temperature: 0.5,
        thinkingConfig: { thinkingLevel: "MEDIUM", includeThoughts: true },
      },
    });

    const chatFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: "internal thoughts", thought: true },
                { text: "Hello back from Gemini!" },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 25,
          candidatesTokenCount: 12,
          cachedContentTokenCount: 4,
          thoughtsTokenCount: 9,
        },
      }),
    );
    const reply = await sendModelChatDetailed(
      { fetch: chatFetch },
      account,
      envelope,
      chatRoute,
      "gemini-2.5-pro",
      { contextWindow: null, maxOutputTokens: 1024, effort: "low", thinkingEnabled: true },
      "Hi",
      new AbortController().signal,
      service.routeSource,
      { facts: { reasoningMode: "effort" } },
    );
    expect(reply.text).toBe("Hello back from Gemini!");
    expect(reply.usage).toEqual({
      inputTokens: 25,
      outputTokens: 12,
      cacheReadTokens: 4,
      reasoningTokens: 9,
    });
  });

  it("enforces offeringFilter without deleting hidden non-usage accounts from storage", async () => {
    const unfiltered = setup();
    const ds = await unfiltered.service.createConnection({
      providerId: "deepseek",
      offeringId: "deepseek-api-key",
      displayName: "DeepSeek",
      operationId: "ds-keep",
      apiKey: key,
      routes: [],
    });
    const gem = await unfiltered.service.createConnection({
      providerId: "gemini",
      offeringId: "gemini-api-key",
      displayName: "Gemini",
      operationId: "gem-keep",
      apiKey: key,
      routes: [],
    });

    const filtered = new CommonProviderApplicationService({
      storage: unfiltered.storage,
      registry: unfiltered.registry,
      credentials: unfiltered.vault,
      auth: new AuthCoordinator(unfiltered.registry),
      allowLegacyConnections: false,
      offeringFilter: (offering, provider) =>
        offering.supportsSubscriptionUsage !== false && provider.capabilities.includes("usage"),
    });

    const snapshot = await filtered.getSnapshot();
    expect(snapshot.providers.map((p) => p.provider)).not.toContain("deepseek");
    expect(snapshot.providers.map((p) => p.provider)).not.toContain("gemini");
    expect(snapshot.providers.map((p) => p.provider)).not.toContain("compatible-api-key");
    const codex = snapshot.providers.find((p) => p.provider === "codex");
    expect(codex?.offerings.map((o) => o.id)).toEqual(["codex"]);
    expect(snapshot.accounts).toEqual([]);
    expect(snapshot.connections).toEqual([]);

    // Disallowed creation is rejected while pre-existing stored accounts stay intact.
    await expect(
      filtered.createConnection({
        providerId: "gemini",
        offeringId: "gemini-api-key",
        displayName: "Blocked",
        operationId: "gem-blocked",
        apiKey: key,
        routes: [],
      }),
    ).rejects.toMatchObject({ code: "capability-unavailable" });
    expect(unfiltered.storage.accounts.get(ds.accountId)).toBeDefined();
    expect(unfiltered.storage.accounts.get(gem.accountId)).toBeDefined();
  });
});
