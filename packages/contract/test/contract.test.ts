import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  POLYQUOTA_SCHEMA_VERSION,
  parseRedeemResetCreditRequest,
  parseResetCreditRedemption,
  parseSettings,
  parseAdoptVaultRequest,
  parseCredentialExportRequest,
  parseStartAuthRequest,
  parseCommandContext,
  endpointProtocols,
  protocolFamilies,
  protocolFamilyDescriptors,
  resolveEndpointProtocol,
  modelEndpointDescriptor,
  parseFamilyPolicy,
  parseModelRouteInput,
  parseConnectionRequest,
  resolveProviderRouteSelection,
} from "../src/polyquota/index";
import {
  parseModelExtensionBody,
  parseModelRequestRule,
} from "../src/common/dto/model-request-rule";
import { graphModelOperations, nativeChatOperation } from "../src/graph-agent/index";

/**
 * 请求侧（renderer → main）校验用例。响应方向零运行期解析（2026-10 校验
 * 归属定稿）：原 parseSnapshot / parseProviderDescriptor / parsePublicUsage
 * 等收包解析与 matchPublicPlan / publicPlanDisplayName 匹配助手已随解析点
 * 上移退役，快照断言移至 apps 的应用服务测试。
 */

describe("PolyQuota contract request validation", () => {
  it("bounds opaque write contexts without accepting filesystem paths or control characters", () => {
    expect(parseCommandContext({ instanceId: "instance-1", contextId: "private:epoch-2" })).toEqual(
      { instanceId: "instance-1", contextId: "private:epoch-2" },
    );
    for (const context of [
      {},
      { instanceId: "host", contextId: "C:/vault" },
      { instanceId: "host", contextId: "x".repeat(129) },
      { instanceId: "host\n", contextId: "private" },
    ]) {
      expect(() => parseCommandContext(context)).toThrow(ContractValidationError);
    }
  });
  it("keeps the schema version explicit so clients can compare it", () => {
    expect(POLYQUOTA_SCHEMA_VERSION).toBe(6);
  });

  it("accepts only explicit absolute shared directories and rejects extra export fields", () => {
    expect(parseCredentialExportRequest({ vaultDirectory: "C:/test/shared" })).toEqual({
      vaultDirectory: "C:/test/shared",
    });
    for (const request of [
      { vaultDirectory: "../relative" },
      { vaultDirectory: "C:/shared", accessToken: "forbidden" },
      { vaultDirectory: "" },
    ])
      expect(() => parseCredentialExportRequest(request)).toThrow(ContractValidationError);
  });

  it("accepts an optional client id when adopting an existing shared directory", () => {
    expect(parseAdoptVaultRequest({ vaultDirectory: "C:/test/shared" })).toEqual({
      vaultDirectory: "C:/test/shared",
    });
    expect(
      parseAdoptVaultRequest({ vaultDirectory: "C:/test/shared", clientId: "graph-agent-demo" }),
    ).toEqual({ vaultDirectory: "C:/test/shared", clientId: "graph-agent-demo" });
    for (const request of [
      { vaultDirectory: "C:/test/shared", clientId: "../other" },
      { vaultDirectory: "C:/test/shared", clientId: "" },
      { vaultDirectory: "C:/test/shared", extra: true },
      { vaultDirectory: "../relative", clientId: "graph-agent-demo" },
    ])
      expect(() => parseAdoptVaultRequest(request)).toThrow(ContractValidationError);
  });

  it("accepts shape-valid auth requests keyed by offering id", () => {
    expect(parseStartAuthRequest({ offeringId: "codex", method: "browser-oauth" })).toEqual({
      offeringId: "codex",
      method: "browser-oauth",
    });
    expect(
      parseStartAuthRequest({
        offeringId: "bigmodel-coding-plan",
        method: "api-key",
        apiKey: "secret",
      }),
    ).toEqual({ offeringId: "bigmodel-coding-plan", method: "api-key", apiKey: "secret" });
    expect(parseStartAuthRequest({ offeringId: "grok-build", method: "device-code" })).toEqual({
      offeringId: "grok-build",
      method: "device-code",
    });
    expect(() => parseStartAuthRequest({ offeringId: "Codex", method: "browser-oauth" })).toThrow(
      ContractValidationError,
    );
    expect(() =>
      parseStartAuthRequest({ offeringId: "c".repeat(65), method: "browser-oauth" }),
    ).toThrow(ContractValidationError);
  });

  it("checks auth method ids structurally and leaves availability to the catalog", () => {
    // 认证方式是动态集合：契约只约束 slug 结构，是否可用由主进程交叉查目录。
    expect(parseStartAuthRequest({ offeringId: "codex", method: "magic-link" })).toEqual({
      offeringId: "codex",
      method: "magic-link",
    });
    expect(() => parseStartAuthRequest({ offeringId: "codex", method: "Magic Link" })).toThrow(
      ContractValidationError,
    );
    expect(() => parseStartAuthRequest({ offeringId: "codex", method: "" })).toThrow(
      ContractValidationError,
    );
  });

  it("rejects unknown request fields, blank keys, and invalid polling intervals", () => {
    expect(
      parseSettings({
        pollingEnabled: true,
        pollingIntervalMinutes: 15,
        taskbarProgressEnabled: false,
      }),
    ).toEqual({
      pollingEnabled: true,
      pollingIntervalMinutes: 15,
      taskbarProgressEnabled: false,
    });
    expect(parseSettings({ pollingEnabled: true, pollingIntervalMinutes: 15 })).toEqual({
      pollingEnabled: true,
      pollingIntervalMinutes: 15,
      taskbarProgressEnabled: true,
    });
    expect(() => parseSettings({ pollingEnabled: true, pollingIntervalMinutes: 4 })).toThrow(
      ContractValidationError,
    );
    expect(() =>
      parseStartAuthRequest({ offeringId: "codex", method: "cli-import", token: "secret" }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseStartAuthRequest({ offeringId: "codex", method: "api-key", apiKey: "   " }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseStartAuthRequest({
        offeringId: "codex",
        method: "api-key",
        apiKey: "k".repeat(4097),
      }),
    ).toThrow(ContractValidationError);
    expect(
      parseStartAuthRequest({
        offeringId: "codex",
        method: "api-key",
        apiKey: "k".repeat(4096),
      }),
    ).toEqual({ offeringId: "codex", method: "api-key", apiKey: "k".repeat(4096) });
  });

  it("accepts only bounded reset-credit redemptions", () => {
    expect(parseResetCreditRedemption({ kind: "aggregate" })).toEqual({ kind: "aggregate" });
    expect(parseResetCreditRedemption({ kind: "aggregate", type: "five-hour" })).toEqual({
      kind: "aggregate",
      type: "five-hour",
    });
    expect(parseResetCreditRedemption({ kind: "aggregate", type: "t".repeat(64) })).toEqual({
      kind: "aggregate",
      type: "t".repeat(64),
    });
    expect(() => parseResetCreditRedemption({ kind: "aggregate", type: "   " })).toThrow(
      ContractValidationError,
    );
    expect(() => parseResetCreditRedemption({ kind: "aggregate", type: "t".repeat(65) })).toThrow(
      ContractValidationError,
    );
    expect(parseResetCreditRedemption({ kind: "item", itemId: "record-42" })).toEqual({
      kind: "item",
      itemId: "record-42",
    });
    expect(parseResetCreditRedemption({ kind: "item", itemId: "i".repeat(256) })).toEqual({
      kind: "item",
      itemId: "i".repeat(256),
    });
    expect(() => parseResetCreditRedemption({ kind: "item", itemId: "" })).toThrow(
      ContractValidationError,
    );
    expect(() => parseResetCreditRedemption({ kind: "item", itemId: "i".repeat(257) })).toThrow(
      ContractValidationError,
    );
    expect(() => parseResetCreditRedemption({ kind: "voucher" })).toThrow(ContractValidationError);
    expect(() =>
      parseResetCreditRedemption({ kind: "item", itemId: "record-42", token: "secret" }),
    ).toThrow(ContractValidationError);
  });

  it("wraps reset-credit redemptions with a bounded account id", () => {
    expect(
      parseRedeemResetCreditRequest({
        accountId: "glm-1",
        redemption: { kind: "item", itemId: "record-42" },
      }),
    ).toEqual({ accountId: "glm-1", redemption: { kind: "item", itemId: "record-42" } });
    expect(
      parseRedeemResetCreditRequest({ accountId: "glm-1", redemption: { kind: "aggregate" } }),
    ).toEqual({ accountId: "glm-1", redemption: { kind: "aggregate" } });
    expect(() =>
      parseRedeemResetCreditRequest({
        accountId: "../glm-1",
        redemption: { kind: "aggregate" },
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseRedeemResetCreditRequest({
        accountId: "glm-1",
        redemption: { kind: "voucher" },
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      parseRedeemResetCreditRequest({ accountId: "glm-1", selectionToken: "record-42" }),
    ).toThrow(ContractValidationError);
  });
});

describe("Contract naming refactor and simplified request validation", () => {
  it("exports renamed protocol enums, family descriptors, and resolver helpers", () => {
    expect(endpointProtocols).toContain("openai-chat");
    expect(protocolFamilies).toEqual(["openai", "anthropic", "gemini", "grok-video", "cohere"]);
    expect(protocolFamilyDescriptors.openai.family).toBe("openai");
    expect(protocolFamilyDescriptors["grok-video"].defaultProtocol).toBe("grok-video-generations");
    expect(resolveEndpointProtocol(null, "grok-video")).toBe("grok-video-generations");
    expect(resolveEndpointProtocol("openai-chat", "openai")).toBe("openai-chat");
    expect(() => resolveEndpointProtocol(null, "openai")).toThrow(ContractValidationError);

    const chatDesc = modelEndpointDescriptor("openai-chat");
    expect(chatDesc.protocol).toBe("openai-chat");
    expect(chatDesc.protocolFamily).toBe("openai");
    expect(chatDesc.operation).toBe("chat");
    expect(chatDesc.ioProfile).toBe("text");

    expect(
      resolveProviderRouteSelection({
        providerId: "openai",
        accountId: "acc-1",
        modelId: "grok-video-1",
        protocolFamily: "grok-video",
      }),
    ).toEqual({
      providerId: "openai",
      accountId: "acc-1",
      modelId: "grok-video-1",
      protocol: "grok-video-generations",
    });
  });

  it("rejects top-level protocol reserved keys in requestRule.body while allowing nested extension keys", () => {
    expect(
      parseModelExtensionBody({
        metadata: {
          store_id: "store-42",
          include_meta: true,
          cache_key: "k-1",
          target_url: "https://example.test",
          thinking: { mode: "custom" },
        },
        extra_option: "ok",
      }),
    ).toEqual({
      metadata: {
        store_id: "store-42",
        include_meta: true,
        cache_key: "k-1",
        target_url: "https://example.test",
        thinking: { mode: "custom" },
      },
      extra_option: "ok",
    });

    for (const key of [
      "model",
      "thinking",
      "messages",
      "store",
      "reasoning_effort",
      "output_config",
    ]) {
      expect(() => parseModelExtensionBody({ [key]: "x" })).toThrow(ContractValidationError);
    }

    // Prototype pollution keys are rejected at every depth
    expect(() => parseModelExtensionBody(JSON.parse('{"nested":{"__proto__":{}}}'))).toThrow(
      ContractValidationError,
    );
    expect(() => parseModelExtensionBody({ nested: { constructor: "x" } })).toThrow(
      ContractValidationError,
    );
    expect(() => parseModelExtensionBody({ nested: { prototype: "x" } })).toThrow(
      ContractValidationError,
    );

    // Secret-like values remain rejected
    expect(() => parseModelExtensionBody({ note: "sk-abcdefgh1234" })).toThrow(
      ContractValidationError,
    );
  });

  it("allows pure static aliases without targets while requiring targets for modelTemplate and rejecting cycles", () => {
    const parseHeaders = (headers: unknown) => parseFamilyPolicy({ headers }).headers ?? {};

    expect(
      parseModelRequestRule(
        {
          operation: "chat",
          aliases: { "fast-chat": "deepseek-chat" },
        },
        parseHeaders,
      ),
    ).toEqual({
      operation: "chat",
      aliases: { "fast-chat": "deepseek-chat" },
    });

    // Cycle in aliases without targets is still rejected
    expect(() =>
      parseModelRequestRule(
        {
          operation: "chat",
          aliases: { a: "b", b: "a" },
        },
        parseHeaders,
      ),
    ).toThrow(ContractValidationError);

    // Explicit targets list is still enforced against alias final targets when present
    expect(() =>
      parseModelRequestRule(
        {
          operation: "chat",
          aliases: { a: "b" },
          targets: ["c"],
        },
        parseHeaders,
      ),
    ).toThrow(ContractValidationError);

    // modelTemplate without targets is still rejected
    expect(() =>
      parseModelRequestRule(
        {
          operation: "chat",
          modelTemplate: "{model}-{effort}",
        },
        parseHeaders,
      ),
    ).toThrow(ContractValidationError);

    expect(
      parseModelRequestRule(
        {
          operation: "chat",
          modelTemplate: "{model}-{effort}",
          targets: ["gpt-5-high"],
        },
        parseHeaders,
      ),
    ).toEqual({
      operation: "chat",
      modelTemplate: "{model}-{effort}",
      targets: ["gpt-5-high"],
    });
  });

  it("validates familyPolicy headers via explicit blacklist and preserves query restrictions", () => {
    expect(
      parseFamilyPolicy({
        headers: {
          "X-Idempotency-Key": "idem-123",
          "X-Cache-Key": "cache-abc",
          "HTTP-Referer": "https://app.example",
          "Anthropic-Beta": "prompt-caching-2024-07-31",
          "X-Title": "GraphAgent",
          "Accept-Language": "en-US",
        },
        query: {
          region: "us",
          api_version: "2026-01",
        },
      }),
    ).toEqual({
      headers: {
        "accept-language": "en-US",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "http-referer": "https://app.example",
        "x-cache-key": "cache-abc",
        "x-idempotency-key": "idem-123",
        "x-title": "GraphAgent",
      },
      query: {
        api_version: "2026-01",
        region: "us",
      },
    });

    for (const forbidden of [
      "authorization",
      "Authorization",
      "x-api-key",
      "x-goog-api-key",
      "proxy-authorization",
      "host",
      "cookie",
      "set-cookie",
      "content-length",
      "transfer-encoding",
      "connection",
      "keep-alive",
      "upgrade",
      "te",
      "trailer",
      "proxy-connection",
      "x-graphagent-call-id",
      "X-GraphAgent-Context-Id",
      "constructor",
      "prototype",
    ]) {
      expect(() => parseFamilyPolicy({ headers: { [forbidden]: "value" } })).toThrow(
        ContractValidationError,
      );
    }

    expect(() => parseFamilyPolicy({ headers: { "x-custom": "Bearer sk-1234567890" } })).toThrow(
      ContractValidationError,
    );
    expect(() => parseFamilyPolicy({ headers: { "x-custom": "bad\nvalue" } })).toThrow(
      ContractValidationError,
    );

    for (const reservedParam of [
      "limit",
      "after",
      "before",
      "before_id",
      "after_id",
      "client_version",
      "constructor",
    ]) {
      expect(() => parseFamilyPolicy({ query: { [reservedParam]: "1" } })).toThrow(
        ContractValidationError,
      );
    }
  });

  it("parses scoped and unscoped connection requests without provider-specific hardcoding", () => {
    // Scoped request with omitted or empty routes
    expect(
      parseConnectionRequest(
        {
          providerId: "acme",
          offeringId: "acme-api-key",
          displayName: "Acme",
          apiKey: "secret-key",
          operationId: "op-1",
        },
        "create",
      ),
    ).toEqual({
      providerId: "acme",
      offeringId: "acme-api-key",
      displayName: "Acme",
      apiKey: "secret-key",
      operationId: "op-1",
      routes: [],
    });

    // Scoped request with arbitrary valid routes (no DeepSeek-only exception needed)
    expect(
      parseConnectionRequest(
        {
          providerId: "acme",
          offeringId: "acme-api-key",
          displayName: "Acme Custom",
          apiKey: "secret-key",
          operationId: "op-2",
          routes: [
            { protocol: "openai-chat", baseUrl: "https://relay.acme.test/v1/" },
            { protocol: "openai-responses", baseUrl: "https://relay.acme.test/v1" },
            { protocol: "anthropic-messages", baseUrl: "https://relay.acme.test/anthropic/v1" },
          ],
        },
        "create",
      ),
    ).toEqual({
      providerId: "acme",
      offeringId: "acme-api-key",
      displayName: "Acme Custom",
      apiKey: "secret-key",
      operationId: "op-2",
      routes: [
        { protocol: "openai-chat", baseUrl: "https://relay.acme.test/v1", protocolVersion: null },
        {
          protocol: "openai-responses",
          baseUrl: "https://relay.acme.test/v1",
          protocolVersion: null,
        },
        {
          protocol: "anthropic-messages",
          baseUrl: "https://relay.acme.test/anthropic/v1",
          protocolVersion: "2023-06-01",
        },
      ],
    });

    // Scoped request still enforces family root consistency
    expect(() =>
      parseConnectionRequest(
        {
          providerId: "acme",
          offeringId: "acme-api-key",
          displayName: "Acme Bad",
          apiKey: "secret-key",
          operationId: "op-3",
          routes: [
            { protocol: "openai-chat", baseUrl: "https://a.example/v1" },
            { protocol: "openai-responses", baseUrl: "https://b.example/v1" },
          ],
        },
        "create",
      ),
    ).toThrow(ContractValidationError);

    // Unscoped legacy compatible-api-key request still requires >= 1 route
    expect(() =>
      parseConnectionRequest(
        {
          displayName: "Legacy",
          apiKey: "secret-key",
          operationId: "op-4",
          routes: [],
        },
        "create",
      ),
    ).toThrow(ContractValidationError);

    expect(
      parseModelRouteInput({
        protocolFamily: "grok-video",
        baseUrl: "https://video.example/v1",
      }),
    ).toEqual({
      protocol: "grok-video-generations",
      baseUrl: "https://video.example/v1",
      protocolVersion: null,
    });
  });

  it("validates GraphAgent model and native chat operations with renamed fields", () => {
    const manual = graphModelOperations.editManualModel.parseInput({
      instanceId: "inst-1",
      contextId: "ctx-1",
      selection: {
        providerId: "deepseek",
        accountId: "acc-1",
        protocol: "openai-chat",
        modelId: "deepseek-chat",
      },
      expectedBindingRevision: "rev-1",
      expectedSettingsRevision: "set-1",
      change: {
        operation: "upsert",
        displayName: "DeepSeek Chat",
        modelType: "text-llm",
        modelOperation: "chat",
        ioProfile: "text",
      },
    });
    expect(manual.change).toEqual({
      operation: "upsert",
      displayName: "DeepSeek Chat",
      modelType: "text-llm",
      modelOperation: "chat",
      ioProfile: "text",
    });

    const draft = graphModelOperations.saveModelDraft.parseInput({
      instanceId: "inst-1",
      contextId: "ctx-1",
      selection: {
        providerId: "deepseek",
        accountId: "acc-1",
        protocol: "openai-chat",
        modelId: "deepseek-chat",
      },
      expectedBindingRevision: "rev-1",
      expectedSettingsRevision: "set-1",
      scope: "account",
      operation: "chat",
      ioProfile: "text",
      changes: [],
      priceChanges: [],
      parameterChanges: [],
    });
    expect(draft.operation).toBe("chat");
    expect(draft.ioProfile).toBe("text");

    const familyRefresh = graphModelOperations.refreshCatalog.parseInput({
      instanceId: "inst-1",
      contextId: "ctx-1",
      accountId: "acc-1",
      protocolFamily: "openai",
      expectedFamilyBindingRevision: "frev-1",
    });
    expect(familyRefresh).toEqual({
      instanceId: "inst-1",
      contextId: "ctx-1",
      accountId: "acc-1",
      protocolFamily: "openai",
      expectedFamilyBindingRevision: "frev-1",
    });

    expect(
      nativeChatOperation.path({
        instanceId: "inst-1",
        contextId: "ctx-1",
        expectedBindingRevision: "rev-1",
        expectedSettingsRevision: "set-1",
        protocol: "anthropic-messages",
        body: { model: "claude-3" },
      }),
    ).toBe("/api/v1/graph-agent/proxy/anthropic/v1/messages");
  });
});
