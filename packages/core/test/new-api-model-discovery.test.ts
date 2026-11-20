import { describe, expect, it, vi } from "vitest";
import type { EndpointProtocol } from "@astra-conductor/contract/common";
import {
  discoverRouteModels,
  readNewApiCatalog,
  resolveModelRoutes,
  type Account,
  type ConnectionProviderSource,
  type CredentialEnvelope,
} from "../src/internal.js";

const site = "https://relay.example/tenant";
const key = "fixture-private-relay-key";
const account: Account = {
  id: "account-1",
  provider: "custom-relay",
  offeringId: "tenant",
  authMethod: "api-key",
  stableIdentity: "local",
  displayName: "Relay",
  maskedIdentifier: "masked",
  enabled: true,
  credentialState: "available",
  publicMetadata: { credentialBindingRevision: "revision" },
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const envelope: CredentialEnvelope = {
  version: 1,
  accountId: account.id,
  provider: account.provider,
  authMethod: "api-key",
  expiresAt: null,
  secrets: { apiKey: key },
  credentialBindingRevision: "revision",
};
function fixture(protocol: EndpointProtocol, newApi: boolean = true, root = site) {
  const source: ConnectionProviderSource = {
    routes: () => [
      {
        protocol,
        baseUrl: root + "/v1",
        bindingRevision: "binding",
        protocolVersion: protocol === "anthropic-messages" ? "2023-06-01" : null,
      },
    ],
    templateKind: () => (newApi ? "new-api" : "generic"),
    ...(newApi && { newApiSite: () => site }),
  };
  const [route] = resolveModelRoutes(account, envelope, source);
  const fetch = vi.fn<typeof globalThis.fetch>();
  return {
    fetch,
    run: (signal?: AbortSignal) =>
      discoverRouteModels({ fetch }, account, envelope, route, signal, source),
  };
}
const priceResponse = () =>
  Response.json({
    success: true,
    group_ratio: { standard: 0.8, vip: 0.2 },
    data: [
      {
        model_name: "both",
        supported_endpoint_types: ["anthropic", "openai"],
        quota_type: 0,
        model_ratio: 0.1,
        completion_ratio: 3,
        cache_ratio: 0,
        enable_groups: ["standard"],
        context_length: 123,
        capabilities: ["tools"],
      },
      {
        model_name: "chat-only",
        supported_endpoint_types: ["openai"],
        model_price: 0.05,
        quota_type: 1,
      },
      { model_name: "site-only", supported_endpoint_types: ["anthropic"] },
    ],
  });

describe("New API site listings and selected-key model discovery", () => {
  it("browses the anonymous site catalog with group-scoped quotes and native billing semantics", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(priceResponse());
    const rows = await readNewApiCatalog({ fetch }, site + "/");
    expect(String(fetch.mock.calls[0][0])).toBe(site + "/api/pricing");
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "error" });
    expect([...new Headers(fetch.mock.calls[0][1]?.headers).keys()]).toEqual(["accept"]);
    expect(rows.map((r) => r.modelId)).toEqual(["both", "chat-only", "site-only"]);
    expect(rows[0].prices).toMatchObject([
      { kind: "input", amount: "0.16", tier: "standard", currency: "USD", unit: "million-tokens" },
      { kind: "output", amount: "0.48", tier: "standard" },
      { kind: "cache-read", amount: "0", tier: "standard" },
    ]);
    expect(rows[1]).toMatchObject({
      prices: [],
      billing: { kind: "per-request", modelPrice: 0.05 },
    });
  });
  it("keeps the Anthropic key scope, uses the native headers and omits all credentials from pricing", async () => {
    const { run, fetch } = fixture("anthropic-messages");
    fetch
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { id: "both", display_name: "Key name", max_tokens: 32 },
            { id: "chat-only" },
            { id: "key-only" },
          ],
          has_more: false,
        }),
      )
      .mockResolvedValueOnce(priceResponse());
    const rows = await run();
    expect(rows.map((r) => r.modelId)).toEqual(["both", "key-only"]);
    expect(rows[0]).toMatchObject({
      displayName: "Key name",
      facts: {
        contextWindow: 123,
        maxOutputTokens: 32,
        operations: ["chat"],
        toolCalling: "supported",
      },
    });
    expect(rows[0].prices).toHaveLength(3);
    expect(rows.map((r) => r.routeSupport)).toEqual(["confirmed", "unconfirmed"]);
    expect(String(fetch.mock.calls[0][0])).toBe(site + "/v1/models");
    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.get("x-api-key")).toBe(key);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("authorization")).toBeNull();
    expect([...new Headers(fetch.mock.calls[1][1]?.headers).keys()]).toEqual(["accept"]);
  });
  it("key-specific endpoints win over public pricing and the current API key controls candidates", async () => {
    const { run, fetch } = fixture("openai-responses");
    fetch
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { id: "both", supported_endpoint_types: ["openai-response"] },
            { id: "key-chat", supported_endpoint_types: ["openai"] },
          ],
        }),
      )
      .mockResolvedValueOnce(priceResponse());
    expect((await run()).map((r) => r.modelId)).toEqual(["both"]);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer " + key);
  });
  it.each([401, 403, 429, 503])(
    "preserves the selected key list on pricing HTTP %s",
    async (status) => {
      const { run, fetch } = fixture("openai-chat");
      fetch
        .mockResolvedValueOnce(Response.json({ data: [{ id: "allowed" }] }))
        .mockResolvedValueOnce(new Response("private", { status }));
      expect((await run()).map((r) => r.modelId)).toEqual(["allowed"]);
    },
  );
  it.each([
    Response.json({ success: false, data: [{ id: "unknown" }] }),
    new Response("error", { status: 403 }),
  ])("does not fall back to pricing when authorization fails", async (response) => {
    const { run, fetch } = fixture("openai-chat");
    fetch.mockResolvedValueOnce(response);
    await expect(run()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("accepts confirmed media endpoints only and preserves manual registration for generic media routes", async () => {
    const media = fixture("openai-images-generations");
    media.fetch
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { id: "confirmed", supported_endpoint_types: ["image-generation"] },
            { id: "unknown" },
            { id: "embeddings", supported_endpoint_types: ["embeddings"] },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response("invalid JSON"));
    expect(await media.run()).toMatchObject([
      { modelId: "confirmed", facts: { operations: ["image-generation"] } },
    ]);
    const generic = fixture("openai-images-generations", false);
    await expect(generic.run()).rejects.toMatchObject({ code: "capability-unavailable" });
    expect(generic.fetch).not.toHaveBeenCalled();
  });
  it.each(["https://other.example", "https://relay.example/another-tenant"])(
    "keeps a separately configured relay isolated from site metadata (%s)",
    async (root) => {
      const { run, fetch } = fixture("openai-chat", true, root);
      fetch.mockResolvedValueOnce(Response.json({ data: [{ id: "key-only" }] }));
      expect((await run())[0].modelId).toBe("key-only");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("aborts with no partial result even if the optional pricing transport swallows cancellation", async () => {
    const controller = new AbortController();
    const { run, fetch } = fixture("openai-chat");
    fetch
      .mockResolvedValueOnce(Response.json({ data: [{ id: "key-only" }] }))
      .mockImplementationOnce(async () => {
        controller.abort();
        return priceResponse();
      });
    await expect(run(controller.signal)).rejects.toMatchObject({ code: "network" });
  });
  it("retains key facts on an invalid pricing envelope or a reflected credential in public metadata", async () => {
    for (const body of [
      { data: [{ model_name: "allowed" }] },
      { success: true, data: [{ model_name: "allowed", display_name: key }] },
    ]) {
      const { run, fetch } = fixture("openai-chat");
      fetch
        .mockResolvedValueOnce(Response.json({ data: [{ id: "allowed" }] }))
        .mockResolvedValueOnce(Response.json(body));
      expect(await run()).toEqual([
        {
          modelId: "allowed",
          displayName: "allowed",
          facts: {},
          prices: [],
          routeSupport: "unconfirmed",
        },
      ]);
    }
  });
  it.each([null, [], [7], [""]])(
    "keeps models visible but unconfirmed when key endpoint evidence is invalid (%j)",
    async (supported_endpoint_types) => {
      const { run, fetch } = fixture("openai-chat");
      fetch
        .mockResolvedValueOnce(
          Response.json({ data: [{ id: "key-id", object: "model", supported_endpoint_types }] }),
        )
        .mockResolvedValueOnce(new Response("", { status: 403 }));
      expect(await run()).toMatchObject([
        { modelId: "key-id", routeSupport: "unconfirmed", facts: {} },
      ]);
    },
  );
  it("rejects a non-model object on the native Anthropic listing without querying a site catalog", async () => {
    const { run, fetch } = fixture("anthropic-messages");
    fetch.mockResolvedValueOnce(Response.json({ data: [{ id: "wrong", type: "tool" }] }));
    await expect(run()).rejects.toMatchObject({ code: "upstream" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps large group tables browsable without exceeding the remote entry price limit", async () => {
    const quote = { kind: "input", amount: "0.19", currency: "USD", unit: "million-tokens" };
    const groups = Object.fromEntries(Array.from({ length: 33 }, (_, i) => ["group-" + i, 0.5]));
    const listing = {
      success: true,
      group_ratio: groups,
      data: [
        {
          model_name: "many-groups",
          supported_endpoint_types: ["openai"],
          quota_type: 0,
          model_ratio: 1,
          completion_ratio: 2,
          enable_groups: ["all"],
        },
      ],
    };
    const { run, fetch } = fixture("openai-chat");
    fetch
      .mockResolvedValueOnce(Response.json({ data: [{ id: "many-groups", prices: [quote] }] }))
      .mockResolvedValueOnce(Response.json(listing))
      .mockResolvedValueOnce(Response.json(listing));
    expect((await run())[0].prices).toMatchObject([quote]);
    expect((await readNewApiCatalog({ fetch }, site))[0].prices).toHaveLength(66);
  });
  it("leaves missing pricing dimensions and plugin billing unquoted", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json({
        success: true,
        data: [
          { model_name: "no-group", quota_type: 0, model_ratio: 5, completion_ratio: 3 },
          { model_name: "unknown-unit", model_price: 30 },
          {
            model_name: "dynamic",
            quota_type: 1,
            model_price: 1,
            billing_mode: "tiered_expr",
            billing_expr: "expression",
          },
        ],
      }),
    );
    const rows = await readNewApiCatalog({ fetch }, site);
    expect(rows.map((r) => r.prices)).toEqual([[], [], []]);
    expect(rows.map((r) => r.billing.kind)).toEqual(["token-ratio", "unknown", "dynamic"]);
    expect(rows[2].billing.modelPrice).toBeNull();
  });
});
