import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { BrokerCredential } from "@astra-conductor/credentials";
import type { PublicConnection } from "@astra-conductor/contract/common";
import { createProviderRoutes, installCommonMiddleware } from "../src/http/index.js";
import {
  AuthCoordinator,
  CommonProviderApplicationService,
  CredentialVault,
  MemoryStorage,
  ProviderRegistry,
  SharedCredentialService,
  createProviderContributions,
  decodeSharedCredential,
  discoverRouteModels,
  encodeSharedCredential,
  modelAuthorization,
  previewModelChat,
  recordFormat,
  resolveModelRoutes,
  sendModelChat,
  sendModelChatDetailed,
  supportsSubscriptionUsage,
  upgradeCredentialMetadata,
  type Account,
  type ConnectionProviderSource,
  type CredentialEnvelope,
} from "../src/internal.js";
import { providerServices } from "./service-helpers.js";

const key = "fictional-catalog-key";
function storedRoutes(connection: PublicConnection) {
  return connection.routes.map(
    ({ protocolFamily: _, familyBindingRevision: __, familyCatalog: ___, ...persisted }) =>
      persisted,
  );
}
const routeInputs = [
  { protocol: "openai-chat", baseUrl: "https://relay.example/custom/v1/" },
  {
    protocol: "anthropic-messages",
    baseUrl: "https://relay.example/claude/v1",
    protocolVersion: "2023-06-01",
  },
];
function setup(connectionProviders?: ConnectionProviderSource) {
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
    connectionProviders,
  });
  const app = new Hono();
  installCommonMiddleware(app);
  app.route(
    "/",
    createProviderRoutes(service, { assertContext: (context) => service.assertContext(context) }),
  );
  const post = async (path: string, input: Record<string, unknown>) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        instanceId: service.instanceId,
        contextId: service.getBackend().contextId,
      }),
    });
  const create = async (id = "operation-1") => {
    const response = await post("/api/v1/accounts/connections/create", {
      displayName: "Relay",
      operationId: id,
      apiKey: key,
      routes: routeInputs,
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(key);
    return (JSON.parse(text) as { value: PublicConnection }).value;
  };
  return { registry, service, storage, vault, post, create };
}

describe("managed API key offerings", () => {
  it.each([
    ["gemini", "gemini-api-key"],
    ["codex", "openai-api-key"],
    ["deepseek", "deepseek-api-key"],
  ])(
    "saves and reopens a shared %s API key without local account data",
    async (provider, offeringId) => {
      const { service, storage, vault } = setup();
      const connection = await service.createConnection({
        providerId: provider,
        offeringId,
        displayName: "Shared key",
        operationId: "shared-" + provider,
        apiKey: key,
        routes: [],
      });
      const account = storage.accounts.get(connection.accountId)!;
      const records: BrokerCredential[] = [];
      const broker = {
        listCredentials: async () => records.map((record) => record.description),
        createCredential: vi.fn(
          async ({ credentialId, contentType, payloadFormatVersion, metadata, payload }) => {
            const description = {
              credentialId,
              contentType,
              payloadFormatVersion,
              metadata,
              revision: "1",
              createdByClientId: "writer",
              lastUpdatedByClientId: "writer",
            };
            const record = { description, payload };
            records.push(record);
            return record;
          },
        ),
        getCredential: vi.fn(async () => records[0]),
        update: vi.fn(),
      };
      await new SharedCredentialService(broker).saveAccount(account, await vault.load(account.id));
      const reader = new SharedCredentialService(broker);
      expect(await reader.listAccounts()).toMatchObject([{ id: account.id, provider, offeringId }]);
      expect((await reader.load(account.id)).secrets.apiKey).toBe(key);
    },
  );

  it("keeps DeepSeek destinations local to the profile and uses its policy on custom roots", async () => {
    const { service, vault, storage, registry } = setup();
    for (const custom of [false, true]) {
      const created = await service.createConnection({
        providerId: "deepseek",
        offeringId: "deepseek-api-key",
        displayName: custom ? "DeepSeek relay" : "DeepSeek",
        operationId: "ds-" + custom,
        apiKey: key,
        routes: custom ? [{ protocol: "openai-chat", baseUrl: "https://relay.example/ds" }] : [],
      });
      const account = storage.accounts.get(created.accountId)!;
      const envelope = await vault.load(account.id);
      expect(supportsSubscriptionUsage(account, registry)).toBe(false);
      expect(envelope.modelRoutes).toBeUndefined();
      const policy = registry.resolveModelPolicy({
        providerId: "deepseek",
        offeringId: "deepseek-api-key",
      });
      for (const route of resolveModelRoutes(account, envelope, service.routeSource, policy)) {
        const preview = previewModelChat(
          account,
          route,
          "deepseek-flash",
          { maxOutputTokens: 512, contextWindow: null, effort: "high", thinkingEnabled: false },
          service.routeSource,
          { policy },
        );
        expect(preview.baseUrl).toBe(
          custom
            ? "https://relay.example/ds"
            : route.protocol === "anthropic-messages"
              ? "https://api.deepseek.com/anthropic/v1"
              : "https://api.deepseek.com",
        );
        expect(preview.body).toMatchObject(
          route.protocol === "openai-responses"
            ? { reasoning: { effort: "none" } }
            : { max_tokens: 512, thinking: { type: "disabled" } },
        );
        expect(preview.body.reasoning_effort).toBeUndefined();
      }
      expect(resolveModelRoutes(account, envelope, service.routeSource)).toHaveLength(
        custom ? 1 : 3,
      );
      expect(resolveModelRoutes(account, envelope)).toHaveLength(custom ? 0 : 3);
    }
  });
  it("new subscription exports retain vendor identity claims and exclude local profile settings", () => {
    const a: Account = {
      id: "example-account",
      provider: "codex",
      offeringId: "codex",
      authMethod: "cli-import",
      stableIdentity: "tenant-workspace",
      maskedIdentifier: "acct-example",
      displayName: "Local UI nickname",
      enabled: false,
      credentialState: "locked",
      publicMetadata: { workspaceId: "tenant-workspace", extraLocalFlag: true },
      createdAt: "2026-01-01",
      updatedAt: "2026-01-02",
    };
    const e: CredentialEnvelope = {
      version: 1,
      accountId: a.id,
      provider: a.provider,
      authMethod: a.authMethod,
      secrets: { accessToken: "fictional-token", refreshToken: "fictional-refresh" },
      expiresAt: null,
    };
    const format = recordFormat(a);
    const payload = encodeSharedCredential(a, e);
    expect(format.payloadFormatVersion).toBe(3);
    const raw = Buffer.from(payload, "base64url").toString();
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      "accountId",
      "accountIdentifier",
      "credential",
      "providerId",
      "version",
    ]);
    expect(raw).not.toMatch(/extraLocalFlag|Local UI nickname|enabled|createdAt|updatedAt|locked/);
    const restored = decodeSharedCredential({
      description: {
        credentialId: a.id,
        ...format,
        metadata: { provider: "codex", supportsUsage: "true" },
      },
      payload,
    });
    expect(restored.account).toMatchObject({
      id: a.id,
      offeringId: "codex",
      maskedIdentifier: a.maskedIdentifier,
      credentialProjection: "minimal",
      publicMetadata: { workspaceId: "tenant-workspace" },
    });
    expect(restored.credentials).toEqual(e);
  });
  it("creates an official OpenAI account, sends standard requests, and never refreshes Codex OAuth", async () => {
    const { post, storage, vault, registry, service } = setup();
    const create = {
      providerId: "codex",
      offeringId: "openai-api-key",
      displayName: "Official",
      accountIdentifier: "fixture-login",
      operationId: "openai-1",
      apiKey: key,
      routes: [],
    };
    const path = "/api/v1/accounts/connections/create";
    const response = await post(path, create);
    expect(response.status).toBe(200);
    const first = ((await response.json()) as { value: PublicConnection }).value;
    expect(
      ((await (await post(path, create)).json()) as { value: PublicConnection }).value,
    ).toEqual(first);
    expect((await post(path, { ...create, routes: routeInputs })).status).toBe(400);
    const account = storage.accounts.get(first.accountId)!;
    const envelope = await vault.load(account.id);
    expect(envelope.modelRoutes).toBeUndefined();
    expect(supportsSubscriptionUsage(account, registry)).toBe(false);
    expect((await service.getSnapshot()).connections[0].actions.refreshCredentials.state).toBe(
      "hidden",
    );
    expect(first.routes.map((r) => r.protocol)).toEqual(["openai-chat", "openai-responses"]);
    expect(await service.refreshCredentials(account.id)).toMatchObject({ status: "failed" });
    const http = {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ data: [{ id: "test-model" }] }))
        .mockResolvedValueOnce(
          Response.json({
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "reply" }],
              },
            ],
            usage: {
              input_tokens: 14,
              input_tokens_details: { cached_tokens: 3 },
              output_tokens: 7,
              output_tokens_details: { reasoning_tokens: 2 },
            },
          }),
        ),
    };
    const openAiPolicy = registry.resolveModelPolicy({
      providerId: "codex",
      offeringId: "openai-api-key",
    });
    const [route, responses] = resolveModelRoutes(account, envelope, undefined, openAiPolicy);
    expect(
      await discoverRouteModels(
        http,
        account,
        envelope,
        route,
        undefined,
        undefined,
        "route",
        openAiPolicy,
      ),
    ).toHaveLength(1);
    expect(String(http.fetch.mock.calls[0][0])).toBe("https://api.openai.com/v1/models");
    const result = await sendModelChatDetailed(
      http,
      account,
      envelope,
      responses,
      "test-model",
      { effort: null, maxOutputTokens: 22, contextWindow: null },
      "hello",
      new AbortController().signal,
      undefined,
      { policy: openAiPolicy },
    );
    expect(result).toEqual({
      text: "reply",
      usage: { inputTokens: 14, cacheReadTokens: 3, outputTokens: 7, reasoningTokens: 2 },
    });
    const [url, request] = http.fetch.mock.calls[1];
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer " + key);
    expect(new Headers(request?.headers).has("chatgpt-account-id")).toBe(false);
    expect(JSON.parse(String(request?.body))).toMatchObject({ max_output_tokens: 22 });
    expect(JSON.parse(String(request?.body))).not.toHaveProperty("stream");
    const rotated = await service.editConnection(account.id, {
      providerId: "codex",
      offeringId: "openai-api-key",
      displayName: "Official",
      expectedRecordRevision: first.recordRevision,
      apiKey: "new-fixture-secret",
      routes: [],
    });
    expect(
      rotated.routes.every((r, i) => r.bindingRevision !== first.routes[i].bindingRevision),
    ).toBe(true);
  });
  it("stores a relay's named endpoints outside its shareable credential, invalidates only the changed endpoint, and rejects media transport", async () => {
    const provider = "custom-test-gateway";
    let revision = "edit-v1";
    const routes: ConnectionProviderSource["routes"] = (p, o) =>
      p === provider && o === "cn"
        ? [
            {
              protocol: "openai-images-generations",
              baseUrl: "https://cn.example/v1",
              bindingRevision: "generate-v1",
              protocolVersion: null,
            },
            {
              protocol: "openai-images-edits",
              baseUrl: "https://edit.example/" + revision,
              bindingRevision: revision,
              protocolVersion: null,
            },
          ]
        : undefined;
    const source = { routes };
    const { service, storage, registry, vault } = setup(source);
    const request = {
      providerId: provider,
      offeringId: "cn",
      accountIdentifier: "test-login",
      operationId: "region-cn",
      displayName: "Local nickname",
      apiKey: key,
      routes: [],
    };
    const first = await service.createConnection(request);
    await expect(service.createConnection({ ...request, offeringId: "us" })).rejects.toThrow();
    const account = storage.accounts.get(first.accountId)!;
    const credential = await vault.load(account.id);
    const format = recordFormat(account);
    const payload = encodeSharedCredential(account, credential);
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    expect(Object.keys(parsed).sort()).toEqual([
      "accountId",
      "accountIdentifier",
      "credential",
      "providerId",
      "version",
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/example|Local nickname|modelRoutes|offeringId/);
    const brokerRecord = {
      description: {
        ...format,
        credentialId: account.id,
        metadata: { provider },
        revision: "1",
        createdByClientId: "a",
        lastUpdatedByClientId: "a",
      },
      payload,
    };
    expect(decodeSharedCredential(brokerRecord).account).toMatchObject({
      provider,
      offeringId: "",
      maskedIdentifier: "test-login",
    });
    const broker = {
      listCredentials: vi.fn().mockResolvedValue([brokerRecord.description]),
      getCredential: vi.fn().mockResolvedValue(brokerRecord),
      createCredential: vi.fn(),
      update: vi.fn(),
    };
    expect(
      await new SharedCredentialService(broker, { includeCustomProviders: false }).listAccounts(),
    ).toEqual([]);
    expect(broker.getCredential).not.toHaveBeenCalled();
    revision = "edit-v2";
    const current = (await service.getConnection(account.id)).routes;
    expect(current[0].bindingRevision).toBe(first.routes[0].bindingRevision);
    expect(current[1].bindingRevision).not.toBe(first.routes[1].bindingRevision);
    expect(resolveModelRoutes(account, credential)).toEqual([]);
    const fetch = vi.fn();
    await expect(
      discoverRouteModels({ fetch }, account, credential, current[0], undefined, source),
    ).rejects.toThrow();
    await expect(
      sendModelChat(
        { fetch },
        account,
        credential,
        current[1],
        "test",
        { maxOutputTokens: null, contextWindow: null, effort: null },
        "hi",
        new AbortController().signal,
        source,
        { policy: registry.resolveModelPolicy({ providerId: provider, offeringId: "cn" }) },
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("ordinary API key connections", () => {
  it("creates independent identities, atomically keeps or invalidates route revisions, and rejects stale edits", async () => {
    const { create, post, service, registry, storage, vault } = setup();
    const first = await create();
    expect((await create()).accountId).toBe(first.accountId);
    const second = await create("op-2");
    expect(second.accountId).not.toBe(first.accountId);
    expect(first.routes[0].baseUrl).toBe("https://relay.example/custom/v1");
    expect(JSON.stringify(await service.getSnapshot())).not.toMatch(
      /relay\.example|fictional-catalog-key/,
    );
    const account = storage.accounts.get(first.accountId)!;
    expect(supportsSubscriptionUsage(account, registry)).toBe(false);
    expect(JSON.stringify(account)).not.toContain("relay.example");
    expect((await vault.load(first.accountId)).modelRoutes).toEqual(storedRoutes(first));
    const path = `/api/v1/accounts/${account.id}/connection/edit`;
    const edit = {
      expectedRecordRevision: first.recordRevision,
      displayName: "Renamed",
      routes: [routeInputs[0], { ...routeInputs[1], baseUrl: "http://127.0.0.1:8011/v1" }],
    };
    expect((await post(path, edit)).status).toBe(200);
    const edited = await service.getConnection(account.id);
    expect(edited.routes[0].bindingRevision).toBe(first.routes[0].bindingRevision);
    expect(edited.routes[1].bindingRevision).not.toBe(first.routes[1].bindingRevision);
    expect((await post(path, edit)).status).toBe(409);
    expect(
      (
        await post(path, {
          ...edit,
          expectedRecordRevision: edited.recordRevision,
          apiKey: "rotated-fixture-key",
        })
      ).status,
    ).toBe(200);
    const rotated = await service.getConnection(account.id);
    expect(
      rotated.routes.every(
        (r) => !edited.routes.some((old) => old.bindingRevision === r.bindingRevision),
      ),
    ).toBe(true);
    expect((await vault.load(first.accountId)).secrets.apiKey).toBe("rotated-fixture-key");
  });
  it.each([
    "ftp://relay.example/api",
    "https://secret@relay.example/v1",
    "https://relay.example/v1?token=private",
    "https://relay.example/#bad",
    "https://relay.example/" + key,
  ])("refuses unsafe destination without storing the key", async (baseUrl) => {
    const { post, storage } = setup();
    const result = await post("/api/v1/accounts/connections/create", {
      operationId: "unsafe",
      displayName: "Fixture",
      apiKey: key,
      routes: [{ protocol: "openai-chat", baseUrl }],
    });
    expect(result.status).toBe(400);
    expect(await result.text()).not.toContain(key);
    expect(storage.accounts.list()).toEqual([]);
  });
  it("finishes every Anthropic page at the bound prefix and parses sourced fields, including explicit zero prices", async () => {
    const { create, storage, vault } = setup();
    const connection = await create();
    const account = storage.accounts.get(connection.accountId)!;
    const envelope = await vault.load(account.id);
    const route = resolveModelRoutes(account, envelope)[1];
    const http = {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({
            data: [
              {
                id: "model-a",
                max_tokens: 42,
                capabilities: {
                  image_input: { supported: false },
                  effort: { supported: true, high: { supported: true } },
                },
              },
            ],
            has_more: true,
            last_id: "A / 1",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            data: [
              {
                id: "model-b",
                prices: [{ kind: "input", amount: "0", currency: "USD", unit: "token" }],
              },
            ],
            has_more: false,
          }),
        ),
    };
    const models = await discoverRouteModels(http, account, envelope, route);
    expect(models[0]).toMatchObject({
      modelId: "model-a",
      facts: { maxOutputTokens: 42, vision: "unsupported", effortLevels: ["high"] },
    });
    expect(models[1].prices[0]).toMatchObject({ amount: "0", durationSeconds: null });
    const urls = http.fetch.mock.calls.map(([url]) => String(url));
    expect(urls[1]).toBe("https://relay.example/claude/v1/models?after_id=A+%2F+1");
    expect(http.fetch.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    expect(() =>
      modelAuthorization(account, envelope, { ...route, baseUrl: "https://other.example" }),
    ).toThrow();
    await expect(
      discoverRouteModels(
        { fetch: async () => Response.json({ data: [{ id: "a" }], has_more: true, last_id: "x" }) },
        account,
        envelope,
        route,
      ),
    ).rejects.toMatchObject({ code: "upstream" });
    await expect(
      discoverRouteModels(
        { fetch: async () => Response.json({ data: [{ id: key }] }) },
        account,
        envelope,
        route,
      ),
    ).rejects.toMatchObject({ code: "upstream" });
  });
  it("discovers Codex and Grok models on their fixed OAuth routes with their provider-specific identifiers", async () => {
    const { create, storage } = setup();
    const connection = await create();
    for (const provider of ["codex", "grok-build"]) {
      const account = {
        ...storage.accounts.get(connection.accountId)!,
        provider,
        offeringId: provider,
        authMethod: "cli-import",
        publicMetadata: { workspaceId: "test-workspace" },
      };
      const envelope: CredentialEnvelope = {
        version: 1,
        accountId: account.id,
        provider,
        authMethod: account.authMethod,
        expiresAt: null,
        secrets: { accessToken: "fictional-oauth-token" },
      };
      const [route] = resolveModelRoutes(account, envelope);
      const items =
        provider === "codex"
          ? [
              {
                slug: "available",
                context_window: 100,
                visibility: "list",
                supported_reasoning_levels: [{ effort: "low" }],
              },
              { slug: "hidden", visibility: "hide" },
            ]
          : [
              {
                id: "catalog-id",
                model: "available",
                apiBackend: "responses",
                contextWindow: 100,
                reasoningEfforts: ["low"],
              },
              { model: "other-protocol", apiBackend: "messages" },
            ];
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ models: items }));
      const result = await discoverRouteModels({ fetch: fetchImpl }, account, envelope, route);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        modelId: "available",
        facts: { contextWindow: 100, effortLevels: ["low"] },
      });
      const [url, init] = fetchImpl.mock.calls[0];
      expect(new URL(String(url)).origin).toBe(
        provider === "codex" ? "https://chatgpt.com" : "https://cli-chat-proxy.grok.com",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fictional-oauth-token");
      if (provider === "codex")
        expect(new URL(String(url)).searchParams.has("client_version")).toBe(true);
    }
  });

  it("converts legacy purpose metadata idempotently, preserving unknown record bytes and extension keys", async () => {
    const { create, registry, storage, vault } = setup();
    const connection = await create();
    const account = storage.accounts.get(connection.accountId)!;
    const envelope = await vault.load(account.id);
    function record(a: Account, e: CredentialEnvelope): BrokerCredential {
      return {
        description: {
          credentialId: a.id,
          ...recordFormat(a, true),
          revision: "1",
          createdByClientId: "source",
          lastUpdatedByClientId: "source",
          metadata: {
            provider: a.provider,
            offeringId: a.offeringId,
            authMethod: a.authMethod,
            extension: "keep",
          },
        },
        payload: encodeSharedCredential(a, e, true),
      };
    }
    const relay = record(account, envelope);
    const legacyAccount = {
      ...account,
      provider: "glm",
      offeringId: "zai-coding-plan",
      publicMetadata: {},
    };
    const legacy = record(legacyAccount, { ...envelope, provider: "glm", modelRoutes: undefined });
    const unknown = record(
      { ...legacyAccount, provider: "unknown", offeringId: "unknown" },
      { ...envelope, provider: "unknown", modelRoutes: undefined },
    );
    const opaque = {
      ...relay,
      description: { ...relay.description, contentType: "application/example" },
      payload: "opaque-bytes",
    };
    for (const [original, expected] of [
      [relay, { supportsUsage: "false", supportsInference: "true" }],
      [legacy, { supportsUsage: "true", supportsInference: "true" }],
      [unknown, {}],
      [opaque, {}],
    ] as const) {
      const next = upgradeCredentialMetadata(original, registry);
      expect(next.payload).toBe(original.payload);
      expect(next.description.metadata).toEqual({ ...original.description.metadata, ...expected });
      expect(upgradeCredentialMetadata(next, registry)).toEqual(next);
    }
    expect(decodeSharedCredential(relay).credentials.modelRoutes).toEqual(storedRoutes(connection));
    const broker = {
      listCredentials: vi.fn(async () => [relay.description]),
      getCredential: vi.fn(async () => relay),
      createCredential: vi.fn(),
      update: vi.fn(),
    };
    const shared = new SharedCredentialService(broker, { providers: registry });
    expect((await shared.listAccounts()).map((a) => a.id)).toEqual([account.id]);
    expect((await shared.loadCurrent(account.id)).modelRoutes).toEqual(storedRoutes(connection));
    const usage = new SharedCredentialService(broker, { providers: registry, usageOnly: true });
    expect(await usage.listAccounts()).toEqual([]);
  });
});
