import { describe, expect, it, vi } from "vitest";
import type { EndpointProtocol, ModelParameters } from "@astra-conductor/contract/common";
import type { Account, CredentialEnvelope } from "../src/models.js";
import { openRouterReceiptPolicy } from "../src/providers/openrouter-receipt.js";
import {
  previewModelChat,
  sendModelChat,
  sendModelChatDetailed,
} from "../src/providers/model-chat.js";
import {
  bindModelRoutes,
  modelAuthorization,
  resolveModelRoutes,
  routeRevisionKey,
} from "../src/providers/model-routes.js";

const parameters: ModelParameters = { maxOutputTokens: 128, effort: "high", contextWindow: null };
const account: Account = {
  id: "test-account",
  provider: "compatible-api-key",
  offeringId: "compatible-api-key",
  authMethod: "api-key",
  displayName: "Relay",
  stableIdentity: "test-account",
  maskedIdentifier: "***",
  enabled: true,
  credentialState: "available",
  publicMetadata: {},
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const envelope: CredentialEnvelope = {
  version: 1,
  accountId: account.id,
  authMethod: account.authMethod,
  provider: account.provider,
  expiresAt: null,
  secrets: { apiKey: "fictional-test-key" },
};

function relay(protocol: EndpointProtocol) {
  const [route] = bindModelRoutes(
    [{ protocol, baseUrl: "https://relay.example/prefix/v1" }],
    envelope.secrets.apiKey!,
  );
  const boundAccount = {
    ...account,
    publicMetadata: { [routeRevisionKey(protocol)]: route.bindingRevision },
  };
  return { boundAccount, route, credential: { ...envelope, modelRoutes: [route] } };
}

describe("single-turn model calls", () => {
  it("uses one native preparation for alias templates, extension defaults and both reasoning switches", async () => {
    const { boundAccount, route, credential } = relay("openai-chat");
    route.familyPolicy = { body: { vendor_options: { cache: false, source: "test-chat" } } };
    route.requestRule = {
      operation: "chat",
      models: ["work"],
      aliases: { work: "atlas" },
      modelTemplate: "vendor/{model}-{effort}-{windowLabel}",
      targets: ["vendor/atlas-high-128k"],
      windowLabels: { "131072": "128k" },
      consume: ["effort", "window"],
      headers: { "x-relay-mode": "interactive" },
      body: { vendor_options: { cache: true } },
      defaults: { topP: 0.5 },
      byModel: { work: { defaults: { topP: 0 } } },
    };
    const params = { ...parameters, contextWindow: 131072 };
    const preview = previewModelChat(boundAccount, route, "work", params);
    expect(preview.upstreamModelId).toBe("vendor/atlas-high-128k");
    expect(preview.body).toMatchObject({
      model: preview.upstreamModelId,
      top_p: 0,
      vendor_options: { cache: true, source: "test-chat" },
    });
    expect(preview.body).not.toHaveProperty("reasoning_effort");
    expect(preview.consumedParameters).toEqual(["effort", "window"]);
    expect(() =>
      previewModelChat(boundAccount, route, "work", { ...params, thinkingEnabled: false }),
    ).toThrow();
    const http = {
      fetch: vi.fn<typeof fetch>(async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          ...preview.body,
          messages: [{ role: "user", content: "prompt" }],
        });
        expect(new Headers(init?.headers).get("x-relay-mode")).toBe("interactive");
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      }),
    };
    await expect(
      sendModelChat(
        http,
        boundAccount,
        credential,
        route,
        "work",
        params,
        "prompt",
        new AbortController().signal,
      ),
    ).resolves.toBe("ok");
  });
  it("looks up a late OpenRouter receipt only for the original generation and route", async () => {
    const [route] = bindModelRoutes(
      [{ protocol: "openai-chat", baseUrl: "https://openrouter.ai/api/v1" }],
      envelope.secrets.apiKey!,
    );
    const bound = {
      ...account,
      publicMetadata: { [routeRevisionKey("openai-chat")]: route.bindingRevision },
    };
    const credentials = { ...envelope, modelRoutes: [route] };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: "gen-verified-1",
          choices: [{ message: { content: "answer" } }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 300 },
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: { id: "gen-other", total_cost: 2 } }))
      .mockResolvedValueOnce(
        Response.json({ data: { id: "gen-verified-1", total_cost: 0.0000007 } }),
      );
    const signal = new AbortController().signal;
    const result = await sendModelChatDetailed(
      { fetch },
      bound,
      credentials,
      route,
      "model",
      parameters,
      "prompt",
      signal,
    );
    expect(result).toMatchObject({
      responseId: "gen-verified-1",
      usage: { inputTokens: 1000, cacheReadTokens: 300, outputTokens: 10 },
    });
    const receipt = (r = route, id = "gen-verified-1") =>
      openRouterReceiptPolicy.transformReceipt!(null, {
        http: { fetch },
        account: bound,
        envelope: credentials,
        route: r,
        modelId: "model",
        generationId: id,
        signal,
        headers: modelAuthorization(bound, credentials, route, "model", "chat"),
      });
    expect(await receipt({ ...route, baseUrl: "https://relay.example/api/v1" })).toBeNull();
    expect(await receipt(route, "../gen-other")).toBeNull();
    expect(await receipt()).toBeNull();
    expect(await receipt()).toEqual({
      amount: "0.0000007",
      currency: "USD",
      eventId: "gen-verified-1",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[2];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/generation?id=gen-verified-1");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fictional-test-key");
  });
  it("normalizes Anthropic total input including cached tokens and preserves an explicit zero charge", async () => {
    const { boundAccount, route, credential } = relay("anthropic-messages");
    const fetch = vi.fn(async () =>
      Response.json({
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 4,
          cache_read_input_tokens: 11,
          cache_creation_input_tokens: 3,
          output_tokens: 2,
        },
        billing: { actual_charge: { amount: "0", currency: "USD", event_id: "bill-zero" } },
      }),
    );
    const response = await sendModelChatDetailed(
      { fetch },
      boundAccount,
      credential,
      route,
      "model",
      parameters,
      "prompt",
      new AbortController().signal,
    );
    expect(response.usage).toEqual({
      inputTokens: 18,
      cacheReadTokens: 11,
      cacheWriteTokens: 3,
      outputTokens: 2,
    });
    expect(response.actualCharge).toEqual({ amount: "0", currency: "USD", eventId: "bill-zero" });
  });
  it.each([
    {
      protocol: "openai-chat",
      path: "/chat/completions",
      auth: "authorization",
      key: "Bearer fictional-test-key",
      response: { choices: [{ message: { role: "assistant", content: "answer" } }] },
      fields: {
        messages: [{ role: "user", content: "ask once" }],
        max_completion_tokens: 128,
        reasoning_effort: "high",
      },
    },
    {
      protocol: "openai-responses",
      path: "/responses",
      auth: "authorization",
      key: "Bearer fictional-test-key",
      response: {
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
      },
      fields: {
        input: [{ role: "user", content: [{ type: "input_text", text: "ask once" }] }],
        store: false,
        max_output_tokens: 128,
        reasoning: { effort: "high" },
      },
    },
    {
      protocol: "anthropic-messages",
      path: "/messages",
      auth: "x-api-key",
      key: "fictional-test-key",
      response: {
        content: [
          { type: "thinking", thinking: "not an answer" },
          { type: "text", text: "answer" },
        ],
      },
      fields: {
        messages: [{ role: "user", content: "ask once" }],
        max_tokens: 128,
        output_config: { effort: "high" },
      },
    },
  ] as const)(
    "compiles the bound $protocol preview and sends only the current prompt",
    async (sample) => {
      const { boundAccount, route, credential } = relay(sample.protocol);
      const settings = { ...parameters, temperature: 0, topP: 0.85 };
      const preview = previewModelChat(boundAccount, route, "vendor/model", settings);
      expect(JSON.stringify(preview)).not.toContain(credential.secrets.apiKey);
      expect(new Headers(preview.headers).get(sample.auth)).toBe("<redacted>");
      const http = {
        fetch: vi.fn<typeof fetch>(async (url, init) => {
          expect(url).toBe(route.baseUrl + sample.path);
          const headers = new Headers(init!.headers);
          expect(headers.get(sample.auth)).toBe(sample.key);
          if (sample.protocol === "anthropic-messages")
            expect(headers.get("anthropic-version")).toBe("2023-06-01");
          const body = JSON.parse(String(init!.body));
          expect(body).toEqual({
            model: "vendor/model",
            temperature: 0,
            top_p: 0.85,
            ...sample.fields,
          });
          expect(preview.body).toEqual(
            JSON.parse(JSON.stringify(body).replace("ask once", "Hello from GraphAgent.")),
          );
          expect(init!.redirect).toBe("manual");
          return Response.json(sample.response);
        }),
      };
      await expect(
        sendModelChat(
          http,
          boundAccount,
          credential,
          route,
          "vendor/model",
          settings,
          "ask once",
          new AbortController().signal,
        ),
      ).resolves.toBe("answer");
    },
  );

  it("never follows a redirect and excludes upstream bodies from errors", async () => {
    const { boundAccount, route, credential } = relay("openai-chat");
    for (const status of [302, 401, 403, 429, 503]) {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(credential.secrets.apiKey, {
            status,
            headers: { Location: "https://another.example" },
          }),
      );
      const result = sendModelChat(
        { fetch },
        boundAccount,
        credential,
        route,
        "model",
        parameters,
        "hello",
        new AbortController().signal,
      );
      await expect(result).rejects.toThrow(`HTTP ${status}`);
      await expect(result).rejects.not.toThrow(credential.secrets.apiKey);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1]!.redirect).toBe("manual");
    }
  });

  it("redacts an echoed key in a successful reply and rejects wrong account bindings", async () => {
    const { boundAccount, route, credential } = relay("openai-chat");
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ choices: [{ message: { content: "Echo fictional-test-key" } }] }),
    );
    const call = (target: typeof route) =>
      sendModelChat(
        { fetch },
        boundAccount,
        credential,
        target,
        "model",
        parameters,
        "prompt",
        new AbortController().signal,
      );
    await expect(call(route)).resolves.toBe("Echo <redacted>");
    await expect(call({ ...route, baseUrl: "https://another.example" })).rejects.toMatchObject({
      code: "stale-binding",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("consumes fragmented Codex SSE only up to a terminal event and detects truncation", async () => {
    const boundAccount = {
      ...account,
      provider: "codex",
      offeringId: "codex",
      authMethod: "cli-import",
    };
    const credential = {
      ...envelope,
      provider: "codex",
      authMethod: "cli-import",
      secrets: { accessToken: "fictional-token" },
    };
    const [route] = resolveModelRoutes(boundAccount, credential);
    const settings = { ...parameters, maxOutputTokens: null };
    expect(() => previewModelChat(boundAccount, route, "model", parameters)).toThrow("Codex");
    const delta = 'data: {"type":"response.output_text.delta","delta":"回答"}\r\n\r\n';
    const end =
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\r\n\r\n';
    const call = (frames: string) =>
      sendModelChat(
        {
          fetch: async (_url, init) => {
            expect(JSON.parse(String(init!.body))).toMatchObject({
              stream: true,
              store: false,
              instructions: expect.any(String),
            });
            return new Response(
              new ReadableStream({
                start(controller) {
                  for (const byte of new TextEncoder().encode(frames))
                    controller.enqueue(Uint8Array.of(byte));
                  controller.close();
                },
              }),
            );
          },
        },
        boundAccount,
        credential,
        route,
        "model",
        settings,
        "one",
        new AbortController().signal,
      );
    await expect(call(delta + end)).resolves.toBe("回答");
    await expect(call(delta)).rejects.toThrow("完成前结束");
  });

  it("sends the Grok Build credential on its fixed Responses route and hides identity in previews", async () => {
    const boundAccount = {
      ...account,
      provider: "grok-build",
      offeringId: "grok-build",
      authMethod: "cli-import",
      publicMetadata: { userId: "fictional-user", email: "fixture@example.com" },
    };
    const credential = {
      ...envelope,
      provider: "grok-build",
      authMethod: "cli-import",
      secrets: { accessToken: "fictional-oauth" },
    };
    const [route] = resolveModelRoutes(boundAccount, credential);
    const settings = { ...parameters, effort: null };
    const preview = previewModelChat(boundAccount, route, "grok-4.6", settings);
    expect(preview.headers["x-userid"]).toBe("<redacted>");
    expect(preview.headers["x-email"]).toBe("<redacted>");
    expect(preview.body).toMatchObject({
      stream: true,
      include: ["reasoning.encrypted_content"],
      store: false,
      reasoning: { effort: "high" },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe("https://cli-chat-proxy.grok.com/v1/responses");
      const headers = new Headers(init!.headers);
      expect(headers.get("authorization")).toBe("Bearer fictional-oauth");
      expect(headers.get("x-grok-model-override")).toBe("grok-4.6");
      expect(headers.get("accept")).toBe("text/event-stream");
      expect(headers.get("x-userid")).toBe("fictional-user");
      return new Response(
        'data: {"type":"response.completed","response":{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}\n\n',
      );
    });
    await expect(
      sendModelChat(
        { fetch },
        boundAccount,
        credential,
        route,
        "grok-4.6",
        settings,
        "question",
        new AbortController().signal,
      ),
    ).resolves.toBe("ok");
  });

  it("does not send an already cancelled request or expose network exception text", async () => {
    const { boundAccount, route, credential } = relay("openai-chat");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("fictional-test-key in socket diagnostics");
    });
    const call = (signal: AbortSignal) =>
      sendModelChat(
        { fetch },
        boundAccount,
        credential,
        route,
        "model",
        parameters,
        "prompt",
        signal,
      );
    await expect(call(AbortSignal.abort())).rejects.toMatchObject({ code: "network" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(call(new AbortController().signal)).rejects.not.toThrow("fictional-test-key");
  });
});
