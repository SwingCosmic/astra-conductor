import { describe, expect, it, vi } from "vitest";
import type {
  EndpointProtocol,
  ModelParameters,
  ModelRoute,
  OfferingRouteConfig,
} from "@astra-conductor/contract/common";
import {
  AuthCoordinator,
  CommonProviderApplicationService,
  CredentialVault,
  MemoryStorage,
  ProviderRegistry,
  accountRoutesSettingKey,
  applyAsyncPolicyChain,
  applyPolicyChain,
  buildBaseRequestPlan,
  codexModelPolicy,
  compileModelRequestPlan,
  createProviderContributions,
  deepSeekModelPolicy,
  discoverRouteModels,
  genericModelPolicy,
  grokBuildModelPolicy,
  newApiModelPolicy,
  openAiApiKeyModelPolicy,
  openRouterReceiptPolicy,
  previewModelChat,
  resolveModelRoutes,
  sendModelChatDetailed,
  validateNativeBody,
  type Account,
  type CredentialEnvelope,
  type ProviderContribution,
  type ProviderOfferingModelPolicy,
} from "../src/internal.js";
import { providerServices } from "./service-helpers.js";

function createTestRegistry() {
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
  return { storage, vault, registry };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acct-1",
    provider: "deepseek",
    offeringId: "deepseek-api-key",
    authMethod: "api-key",
    stableIdentity: "acct-1",
    displayName: "DeepSeek",
    maskedIdentifier: "API Key ••••",
    enabled: true,
    credentialState: "available",
    publicMetadata: { credentialBindingRevision: "default-rev-1" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEnvelope(account: Account, secret = "fictional-policy-key"): CredentialEnvelope {
  return {
    version: 1,
    accountId: account.id,
    provider: account.provider,
    authMethod: account.authMethod,
    expiresAt: null,
    secrets: { apiKey: secret },
    ...(typeof account.publicMetadata.credentialBindingRevision === "string"
      ? { credentialBindingRevision: account.publicMetadata.credentialBindingRevision }
      : {}),
  };
}

describe("ProviderRegistry startup validation and resolveModelPolicy", () => {
  it("resolves built-in offerings, custom templates, legacy compatible-api-key, and rejects unknowns", () => {
    const { registry } = createTestRegistry();

    const codexPolicy = registry.resolveModelPolicy({ providerId: "codex", offeringId: "codex" });
    const openAiPolicy = registry.resolveModelPolicy({
      providerId: "codex",
      offeringId: "openai-api-key",
    });
    expect(codexPolicy).toBe(codexModelPolicy);
    expect(openAiPolicy).toBe(openAiApiKeyModelPolicy);
    expect(codexPolicy).not.toBe(openAiPolicy);

    expect(
      registry.resolveModelPolicy({ providerId: "deepseek", offeringId: "deepseek-api-key" }),
    ).toBe(deepSeekModelPolicy);

    expect(registry.resolveModelPolicy({ providerId: "custom-relay", offeringId: "o-1" })).toBe(
      genericModelPolicy,
    );
    expect(
      registry.resolveModelPolicy({
        providerId: "custom-relay",
        offeringId: "o-1",
        templateKind: "generic",
      }),
    ).toBe(genericModelPolicy);
    expect(
      registry.resolveModelPolicy({
        providerId: "custom-relay",
        offeringId: "o-1",
        templateKind: "new-api",
      }),
    ).toBe(newApiModelPolicy);

    const compat = registry.resolveModelPolicy({
      providerId: "compatible-api-key",
      offeringId: "compatible-api-key",
    });
    expect(compat.offeringId).toBe("compatible-api-key");
    expect(registry.listReceiptPolicies()).toContain(openRouterReceiptPolicy);

    expect(() =>
      registry.resolveModelPolicy({ providerId: "unknown", offeringId: "unknown" }),
    ).toThrow(/未注册的模型策略/);
    expect(() =>
      registry.resolveModelPolicy({ providerId: "codex", offeringId: "non-existent" }),
    ).toThrow(/未注册的模型策略/);
    expect(() =>
      registry.resolveModelPolicy({
        providerId: "custom-relay",
        offeringId: "o-1",
        templateKind: "unknown-template" as "generic",
      }),
    ).toThrow(/未注册的自定义供应商模板策略/);
  });

  it("rejects invalid routeConfig, duplicate offerings, and mismatched policies at startup", () => {
    const baseContribution = (
      routeConfig: OfferingRouteConfig,
      policyOfferingId = "test-off",
    ): ProviderContribution => ({
      descriptor: {
        provider: "test-prov",
        displayName: "Test",
        capabilities: ["model-catalog", "inference"],
        offerings: [
          {
            id: "test-off",
            provider: "test-prov",
            displayName: "Test Off",
            supportsSubscriptionUsage: false,
            routeConfig,
            authMethods: [{ method: "api-key", interaction: "secret-form" }],
            plans: [],
          },
        ],
      },
      modelPolicies: [{ offeringId: policyOfferingId, routeConfig }],
    });

    // Default protocol not in allowedProtocols
    expect(
      () =>
        new ProviderRegistry([
          baseContribution({
            mode: "fixed",
            allowedProtocols: ["openai-chat"],
            defaults: [{ protocol: "openai-responses", baseUrl: "https://test.example/v1" }],
          }),
        ]),
    ).toThrow(/not in allowedProtocols/);

    // Mismatched family roots (assertFamilyRoots)
    expect(
      () =>
        new ProviderRegistry([
          baseContribution({
            mode: "editable",
            allowedProtocols: ["openai-chat", "openai-responses"],
            defaults: [
              { protocol: "openai-chat", baseUrl: "https://a.example/v1" },
              { protocol: "openai-responses", baseUrl: "https://b.example/v1" },
            ],
          }),
        ]),
    ).toThrow(/familyBaseUrl|routes/);

    // Policy offeringId does not match descriptor offering
    expect(
      () =>
        new ProviderRegistry([
          baseContribution(
            {
              mode: "fixed",
              allowedProtocols: ["openai-chat"],
              defaults: [{ protocol: "openai-chat", baseUrl: "https://test.example/v1" }],
            },
            "wrong-off",
          ),
        ]),
    ).toThrow(/does not match any offering/);
  });
});

describe("DeepSeek 3-protocol truth table, native validation, and same-URL custom isolation", () => {
  const account = makeAccount();
  const envelope = makeEnvelope(account);
  const routes = resolveModelRoutes(account, envelope, undefined, deepSeekModelPolicy);
  const routeFor = (protocol: EndpointProtocol): ModelRoute =>
    routes.find((r) => r.protocol === protocol)!;

  it("covers all 3 protocols across all 5 scenarios in preview, send, and validateNativeBody", async () => {
    const baseParams: ModelParameters = {
      maxOutputTokens: 512,
      effort: "high",
      contextWindow: null,
      thinkingEnabled: true,
      returnFullReasoning: true,
    };

    // 1. Thinking enabled (with effort=high, returnFullReasoning=true)
    const chatEnabled = previewModelChat(
      account,
      routeFor("openai-chat"),
      "deepseek-flash",
      baseParams,
      undefined,
      {
        policy: deepSeekModelPolicy,
        facts: { reasoningMode: "effort", reasoningOutputMode: "full" },
      },
    );
    expect(chatEnabled.body).toEqual({
      model: "deepseek-flash",
      messages: [{ role: "user", content: "Hello from GraphAgent." }],
      max_tokens: 512,
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
    expect("ruleHeaders" in chatEnabled).toBe(false);
    expect(chatEnabled.body).not.toHaveProperty("returnFullReasoning");

    const responsesEnabled = previewModelChat(
      account,
      routeFor("openai-responses"),
      "deepseek-flash",
      baseParams,
      undefined,
      {
        policy: deepSeekModelPolicy,
        facts: { reasoningMode: "effort", reasoningOutputMode: "summary" },
      },
    );
    expect(responsesEnabled.body).toEqual({
      model: "deepseek-flash",
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello from GraphAgent." }] }],
      store: false,
      max_output_tokens: 512,
      reasoning: { effort: "high" },
    });

    const anthropicEnabled = previewModelChat(
      account,
      routeFor("anthropic-messages"),
      "deepseek-flash",
      baseParams,
      undefined,
      {
        policy: deepSeekModelPolicy,
        facts: { reasoningMode: "effort", reasoningOutputMode: "summary" },
      },
    );
    expect(anthropicEnabled.body).toEqual({
      model: "deepseek-flash",
      messages: [{ role: "user", content: "Hello from GraphAgent." }],
      max_tokens: 512,
      output_config: { effort: "high" },
      thinking: { type: "enabled" },
    });

    // 2. Thinking disabled (thinkingEnabled=false): no generic thinking-display-disabled warning!
    const disabledParams: ModelParameters = { ...baseParams, thinkingEnabled: false };
    const chatDisabled = previewModelChat(
      account,
      routeFor("openai-chat"),
      "deepseek-flash",
      disabledParams,
      undefined,
      {
        policy: deepSeekModelPolicy,
        facts: { reasoningMode: "effort" },
      },
    );
    expect(chatDisabled.body).toEqual({
      model: "deepseek-flash",
      messages: [{ role: "user", content: "Hello from GraphAgent." }],
      max_tokens: 512,
      thinking: { type: "disabled" },
    });
    expect(chatDisabled.warnings.some((w) => w.code === "thinking-display-disabled")).toBe(false);

    const responsesDisabled = previewModelChat(
      account,
      routeFor("openai-responses"),
      "deepseek-flash",
      disabledParams,
      undefined,
      { policy: deepSeekModelPolicy, facts: { reasoningMode: "effort" } },
    );
    expect(responsesDisabled.body).toEqual({
      model: "deepseek-flash",
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello from GraphAgent." }] }],
      store: false,
      max_output_tokens: 512,
      reasoning: { effort: "none" },
    });

    const anthropicDisabled = previewModelChat(
      account,
      routeFor("anthropic-messages"),
      "deepseek-flash",
      disabledParams,
      undefined,
      { policy: deepSeekModelPolicy, facts: { reasoningMode: "effort" } },
    );
    expect(anthropicDisabled.body).toEqual({
      model: "deepseek-flash",
      messages: [{ role: "user", content: "Hello from GraphAgent." }],
      max_tokens: 512,
      thinking: { type: "disabled" },
    });

    // 3. Explicit non-reasoning model (reasoningMode = "none")
    for (const protocol of ["openai-chat", "openai-responses", "anthropic-messages"] as const) {
      const preview = previewModelChat(
        account,
        routeFor(protocol),
        "deepseek-non-reasoner",
        baseParams,
        undefined,
        {
          policy: deepSeekModelPolicy,
          facts: { reasoningMode: "none" },
        },
      );
      expect(preview.body).not.toHaveProperty("thinking");
      expect(preview.body).not.toHaveProperty("reasoning");
      expect(preview.body).not.toHaveProperty("reasoning_effort");
      expect(preview.body).not.toHaveProperty("output_config");

      const plan = compileModelRequestPlan({
        providerId: account.provider,
        offeringId: account.offeringId,
        route: routeFor(protocol),
        localModelId: "deepseek-non-reasoner",
        facts: { reasoningMode: "none" },
        parameters: baseParams,
        policy: deepSeekModelPolicy,
      });
      expect(() => validateNativeBody(preview.body, plan, protocol)).not.toThrow();
      if (protocol === "openai-responses") {
        expect(() =>
          validateNativeBody({ ...preview.body, reasoning: { effort: "none" } }, plan, protocol),
        ).toThrow();
      } else {
        expect(() =>
          validateNativeBody({ ...preview.body, thinking: { type: "disabled" } }, plan, protocol),
        ).toThrow();
      }
    }

    // 4. Template consumes effort: skip effort field, keep thinking.type
    const templateRoute: ModelRoute = {
      ...routeFor("openai-chat"),
      requestRule: {
        operation: "chat",
        modelTemplate: "{model}-{effort}",
        targets: ["deepseek-flash-high"],
        consume: ["effort"],
      },
    };
    const consumedPreview = previewModelChat(
      account,
      templateRoute,
      "deepseek-flash",
      baseParams,
      undefined,
      {
        policy: deepSeekModelPolicy,
        facts: { reasoningMode: "effort" },
      },
    );
    expect(consumedPreview.upstreamModelId).toBe("deepseek-flash-high");
    expect(consumedPreview.body).toEqual({
      model: "deepseek-flash-high",
      messages: [{ role: "user", content: "Hello from GraphAgent." }],
      max_tokens: 512,
      thinking: { type: "enabled" },
    });
    const consumedPlan = compileModelRequestPlan({
      providerId: account.provider,
      offeringId: account.offeringId,
      route: templateRoute,
      localModelId: "deepseek-flash",
      facts: { reasoningMode: "effort" },
      parameters: baseParams,
      policy: deepSeekModelPolicy,
    });
    expect(() =>
      validateNativeBody(
        { ...consumedPreview.body, reasoning_effort: "high" },
        consumedPlan,
        "openai-chat",
      ),
    ).toThrow();

    // 5. returnFullReasoning = false does not alter request body; unknown emits warning
    const noFull = previewModelChat(
      account,
      routeFor("openai-chat"),
      "deepseek-flash",
      { ...baseParams, returnFullReasoning: false },
      undefined,
      { policy: deepSeekModelPolicy, facts: { reasoningMode: "unknown" } },
    );
    expect(noFull.body).toEqual(chatEnabled.body);
    expect(noFull.warnings.some((w) => w.code === "reasoning-unverified")).toBe(true);

    // sendModelChatDetailed executes the exact compiled body
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "deepseek-flash",
        messages: [{ role: "user", content: "你好" }],
        max_tokens: 512,
        thinking: { type: "disabled" },
      });
      return Response.json({
        choices: [{ message: { content: "hi", reasoning_content: "secret thought" } }],
      });
    });
    const sent = await sendModelChatDetailed(
      { fetch },
      account,
      envelope,
      routeFor("openai-chat"),
      "deepseek-flash",
      disabledParams,
      "你好",
      new AbortController().signal,
      undefined,
      { policy: deepSeekModelPolicy, facts: { reasoningMode: "effort" } },
    );
    expect(sent.text).toBe("hi");

    // validateNativeBody rejects mismatched required/forbidden fields on disabled thinking
    const disabledChatPlan = compileModelRequestPlan({
      providerId: account.provider,
      offeringId: account.offeringId,
      route: routeFor("openai-chat"),
      localModelId: "deepseek-flash",
      facts: { reasoningMode: "effort" },
      parameters: disabledParams,
      policy: deepSeekModelPolicy,
    });
    expect(() =>
      validateNativeBody(
        { model: "deepseek-flash", messages: [], thinking: { type: "disabled" }, tools: [] },
        disabledChatPlan,
        "openai-chat",
      ),
    ).not.toThrow();
    expect(() =>
      validateNativeBody(
        { model: "deepseek-flash", messages: [], thinking: { type: "enabled" } },
        disabledChatPlan,
        "openai-chat",
      ),
    ).toThrow();
    expect(() =>
      validateNativeBody(
        {
          model: "deepseek-flash",
          messages: [],
          thinking: { type: "disabled" },
          reasoning_effort: "low",
        },
        disabledChatPlan,
        "openai-chat",
      ),
    ).toThrow();
  });

  it("isolates a custom-* generic provider pointing at https://api.deepseek.com from DeepSeek policy", () => {
    const customAccount = makeAccount({
      id: "custom-acct",
      provider: "custom-relay",
      offeringId: "o-ds",
      publicMetadata: { credentialBindingRevision: "rev-custom" },
    });
    const customRoute: ModelRoute = {
      protocol: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      protocolVersion: null,
      bindingRevision: "custom-bind-1",
    };
    const preview = previewModelChat(
      customAccount,
      customRoute,
      "deepseek-flash",
      { maxOutputTokens: 512, effort: "high", contextWindow: null, thinkingEnabled: false },
      { routes: () => [customRoute], templateKind: () => "generic" },
      { policy: genericModelPolicy, facts: { reasoningMode: "effort" } },
    );
    expect(preview.body).toEqual({
      model: "deepseek-flash",
      messages: [{ role: "user", content: "Hello from GraphAgent." }],
      max_completion_tokens: 512,
    });
    expect(preview.body).not.toHaveProperty("thinking");
    expect(preview.warnings.some((w) => w.code === "thinking-display-disabled")).toBe(true);
  });
});

describe("Unified account.routes.<accountId> storage and 5-field default comparison", () => {
  it("persists official URL + non-empty requestRule under account.routes.<accountId> and cleans up on delete", async () => {
    const { storage, vault, registry } = createTestRegistry();
    const service = new CommonProviderApplicationService({
      storage,
      vault: undefined as never,
      credentials: vault,
      registry,
      auth: new AuthCoordinator(registry),
    } as ConstructorParameters<typeof CommonProviderApplicationService>[0]);

    // 1. Official defaults with no requestRule -> does NOT write account.routes.<accountId>
    const official = await service.createConnection({
      providerId: "deepseek",
      offeringId: "deepseek-api-key",
      displayName: "DeepSeek Official",
      operationId: "ds-official-rule-test",
      apiKey: "fictional-ds-key",
      routes: [],
    });
    expect(storage.settings.get(accountRoutesSettingKey(official.accountId))).toBeNull();
    const initialRevision = official.routes[0]!.bindingRevision;

    // 2. Edit with official URLs PLUS a non-empty requestRule -> MUST persist and change bindingRevision
    const edited = await service.editConnection(official.accountId, {
      providerId: "deepseek",
      offeringId: "deepseek-api-key",
      displayName: "DeepSeek Official",
      expectedRecordRevision: official.recordRevision,
      routes: [
        {
          protocol: "openai-chat",
          baseUrl: "https://api.deepseek.com",
          requestRule: {
            operation: "chat",
            aliases: { fast: "deepseek-chat" },
          },
        },
        {
          protocol: "openai-responses",
          baseUrl: "https://api.deepseek.com",
        },
        {
          protocol: "anthropic-messages",
          baseUrl: "https://api.deepseek.com/anthropic/v1",
          protocolVersion: "2023-06-01",
        },
      ],
    });

    const persistedRaw = storage.settings.get(accountRoutesSettingKey(official.accountId));
    expect(typeof persistedRaw).toBe("string");
    expect(edited.routes.find((r) => r.protocol === "openai-chat")?.requestRule).toEqual({
      operation: "chat",
      aliases: { fast: "deepseek-chat" },
    });
    expect(edited.routes[0]!.bindingRevision).not.toBe(initialRevision);

    // Round-trip through getConnection
    const reloaded = await service.getConnection(official.accountId);
    expect(reloaded.routes.find((r) => r.protocol === "openai-chat")?.requestRule).toEqual({
      operation: "chat",
      aliases: { fast: "deepseek-chat" },
    });

    // Reject disallowed protocol on editable offering
    await expect(
      service.editConnection(official.accountId, {
        providerId: "deepseek",
        offeringId: "deepseek-api-key",
        displayName: "DeepSeek Official",
        expectedRecordRevision: edited.recordRevision,
        routes: [{ protocol: "openai-embeddings", baseUrl: "https://api.deepseek.com" }],
      }),
    ).rejects.toThrow(/不受当前接入点支持/);

    // 3. Delete account -> cleans up account.routes.<accountId>
    await service.deleteAccount(official.accountId);
    expect(storage.settings.get(accountRoutesSettingKey(official.accountId))).toBeNull();
  });
});

describe("Multi-policy chain composition: Grok Build -> New API -> User Rules", () => {
  it("chains user defaults, Grok effort fallback, New API catalog model mapping, and user aliases cleanly", () => {
    const route: ModelRoute = {
      protocol: "openai-responses",
      baseUrl: "https://relay.example/v1",
      protocolVersion: null,
      bindingRevision: "bind-chain-1",
      requestRule: {
        operation: "chat",
        defaults: { maxOutputTokens: 2048 },
        aliases: { "xai/grok-4.6": "xai/grok-4.6-prod" },
      },
    };

    const plan = compileModelRequestPlan({
      providerId: "custom-newapi",
      offeringId: "o-main",
      route,
      localModelId: "grok-4.6",
      facts: { reasoningMode: "effort" },
      parameters: {
        maxOutputTokens: null,
        effort: null,
        contextWindow: null,
        thinkingEnabled: true,
      },
      extraPolicies: [grokBuildModelPolicy],
      policy: newApiModelPolicy,
      catalogModels: [
        { modelId: "xai/grok-4.6", endpointTypes: ["openai-response"] },
        { modelId: "openai/gpt-5", endpointTypes: ["openai-response"] },
      ],
    });

    // 1. User rule default applied
    expect(plan.parameters.maxOutputTokens).toBe(2048);
    // 2. Grok policy populated fallback effort & stream/include constraints
    expect(plan.parameters.effort).toBe("high");
    expect(plan.constraints.requiredFields).toMatchObject({
      stream: true,
      "reasoning.effort": "high",
    });
    expect(plan.constraints.requiredArrayItems).toEqual({
      include: ["reasoning.encrypted_content"],
    });
    // 3. New API mapped grok-4.6 -> xai/grok-4.6, then user alias mapped -> xai/grok-4.6-prod
    expect(plan.upstreamModelId).toBe("xai/grok-4.6-prod");
  });
});

describe("Fictional provider policy end-to-end with zero core changes", () => {
  it("runs discovery, preview, chat, validateNativeBody, chain composition, and delayed receipt", async () => {
    const fictionalRouteConfig: OfferingRouteConfig = {
      mode: "fixed",
      allowedProtocols: ["openai-chat"],
      defaults: [{ protocol: "openai-chat", baseUrl: "https://fictional.example/api/v1" }],
    };

    const fictionalPolicy: ProviderOfferingModelPolicy = {
      offeringId: "fictional-api",
      routeConfig: fictionalRouteConfig,
      catalogMode: "vendor",
      transformCatalogQuery: (q) => ({ ...q, api_channel: "stable" }),
      transformCatalogPage: (page, { raw }) => {
        const items = (raw as { items?: { code: string }[] }).items;
        if (!Array.isArray(items)) return { ...page, entries: null };
        return { ...page, entries: items.map((item) => ({ id: item.code })) };
      },
      transformCatalogCandidates: async (models) =>
        models.map((m) => ({ ...m, displayName: `Fictional ${m.modelId}` })),
      transformRequestPlan: (plan) => ({
        ...plan,
        outputLimitField: "max_tokens",
        constraints: {
          ...plan.constraints,
          requiredFields: { ...plan.constraints.requiredFields, fictional_mode: "v2" },
        },
      }),
      transformProtocolRequest: (draft) => ({
        ...draft,
        body: { ...draft.body, fictional_mode: "v2" },
        headers: { ...draft.headers, "x-fictional-client": "1" },
      }),
      transformAuthHeaders: (headers, { envelope, secret }) => ({
        ...headers,
        "x-fictional-auth": envelope ? `Key ${secret}` : "<redacted>",
      }),
      transformUsage: (usage) => ({ ...usage, reasoningTokens: usage.reasoningTokens ?? 5 }),
      transformReceipt: async (current, ctx) => {
        if (current) return current;
        const res = await ctx.http.fetch(
          `https://fictional.example/api/v1/receipts/${ctx.generationId}`,
          { headers: ctx.headers, signal: ctx.signal },
        );
        const body = (await res.json()) as { billed: string };
        return { amount: body.billed, currency: "USD", eventId: ctx.generationId };
      },
    };

    const registry = new ProviderRegistry([
      {
        descriptor: {
          provider: "fictional-provider",
          displayName: "Fictional Provider",
          capabilities: ["model-catalog", "inference"],
          offerings: [
            {
              id: "fictional-api",
              provider: "fictional-provider",
              displayName: "Fictional API",
              supportsSubscriptionUsage: false,
              routeConfig: fictionalRouteConfig,
              authMethods: [{ method: "api-key", interaction: "secret-form" }],
              plans: [],
            },
          ],
        },
        modelPolicies: [fictionalPolicy],
      },
    ]);

    const resolved = registry.resolveModelPolicy({
      providerId: "fictional-provider",
      offeringId: "fictional-api",
    });
    expect(resolved).toBe(fictionalPolicy);

    const account = makeAccount({
      id: "fict-1",
      provider: "fictional-provider",
      offeringId: "fictional-api",
      publicMetadata: { credentialBindingRevision: "default-fict" },
    });
    const envelope = makeEnvelope(account, "fictional-secret-token");
    const [route] = resolveModelRoutes(account, envelope, undefined, resolved);

    // 1. Discovery
    const discoverFetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe("https://fictional.example/api/v1/models?api_channel=stable");
      expect(new Headers(init?.headers).get("x-fictional-auth")).toBe("Key fictional-secret-token");
      return Response.json({ items: [{ code: "fict-pro" }] });
    });
    const discovered = await discoverRouteModels(
      { fetch: discoverFetch },
      account,
      envelope,
      route,
      undefined,
      undefined,
      "route",
      resolved,
    );
    expect(discovered).toMatchObject([{ modelId: "fict-pro", displayName: "Fictional fict-pro" }]);

    // 2. Preview
    const params: ModelParameters = { maxOutputTokens: 256, effort: null, contextWindow: null };
    const preview = previewModelChat(account, route, "fict-pro", params, undefined, {
      policy: resolved,
    });
    expect(preview.headers["x-fictional-auth"]).toBe("<redacted>");
    expect(preview.headers["x-fictional-client"]).toBe("1");
    expect(preview.body).toMatchObject({
      model: "fict-pro",
      max_tokens: 256,
      fictional_mode: "v2",
    });

    // 3. validateNativeBody
    const plan = compileModelRequestPlan({
      providerId: account.provider,
      offeringId: account.offeringId,
      route,
      localModelId: "fict-pro",
      parameters: params,
      policy: resolved,
    });
    expect(() => validateNativeBody(preview.body, plan, "openai-chat")).not.toThrow();
    expect(() =>
      validateNativeBody({ model: "fict-pro", messages: [] }, plan, "openai-chat"),
    ).toThrow(/fictional_mode/);

    // 4. Send + transformUsage + transformReceipt
    const chatFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: "rcpt-42",
          choices: [{ message: { content: "hello fictional" } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
      )
      .mockResolvedValueOnce(Response.json({ billed: "0.0012" }));

    const result = await sendModelChatDetailed(
      { fetch: chatFetch },
      account,
      envelope,
      route,
      "fict-pro",
      params,
      "ping",
      new AbortController().signal,
      undefined,
      { policy: resolved },
    );
    expect(result).toEqual({
      text: "hello fictional",
      responseId: "rcpt-42",
      usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 5 },
      actualCharge: { amount: "0.0012", currency: "USD", eventId: "rcpt-42" },
    });

    // 5. Chain helpers smoke check
    const base = buildBaseRequestPlan(
      "m",
      { reasoningMode: "none" },
      {
        maxOutputTokens: 10,
        effort: "high",
        contextWindow: null,
        thinkingEnabled: true,
        returnFullReasoning: true,
      },
    );
    expect(base.thinkingActive).toBe(false);
    expect(base.parameters.effort).toBeNull();
    expect(base.parameters.returnFullReasoning).toBe(false);
    expect(applyPolicyChain(1, {}, [(v) => v + 1, undefined, (v) => v * 3])).toBe(6);
    expect(
      await applyAsyncPolicyChain("a", {}, [async (v) => v + "b", undefined, (v) => v + "c"]),
    ).toBe("abc");
  });
});
