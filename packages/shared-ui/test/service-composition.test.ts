import { describe, expect, it, vi } from "vitest";
import {
  apiOperation,
  credentialEventChannel,
  providerEventChannel,
  type ApiOperation,
  type EventChannel,
  type IServiceTransport,
  type IProviderService,
  type ProviderManagementSnapshot,
  type ServiceResult,
} from "@astra-conductor/contract/common";
import {
  FetchServiceTransport,
  ServiceClientBase,
  defineServiceSlice,
  mixin,
  withCredentialManagement,
  withProviderManagement,
} from "../src/services/index.js";

function fakeTransport(): IServiceTransport {
  return {
    request: async <I, O>(
      _operation: ApiOperation<I, O>,
      _input: I,
    ): Promise<ServiceResult<O>> => ({ ok: true, value: undefined as O }),
    subscribe: vi.fn(<T>(_channel: EventChannel<T>, _listener: (event: T) => void) => () => {}),
    waitForEvents: vi.fn(async () => ({ ok: true as const, value: undefined })),
    dispose: vi.fn(),
  };
}

describe("service slice composition", () => {
  it("sends the captured credential context for recovery and preserves a confirmed delivery's null result", async () => {
    const calls: { path: string; body?: unknown }[] = [];
    const delivery = { migrationKey: "fictional", storageVersion: "new-version" };
    const transport = new FetchServiceTransport({
      baseUrl: "http://127.0.0.1:4877",
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push({
          path,
          ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
        });
        return Response.json({
          ok: true,
          value: path.endsWith("/status")
            ? { instanceId: "host", contextId: "private" }
            : path.endsWith("/resume")
              ? null
              : delivery,
        });
      },
    });
    class Client extends mixin(ServiceClientBase, withCredentialManagement) {}
    const client = new Client(transport);
    await client.credentials.getStatus();
    expect(await client.credentials.resumeExport()).toEqual({ ok: true, value: null });
    expect(await client.credentials.restartExport("C:/new-vault")).toEqual({
      ok: true,
      value: delivery,
    });
    expect(calls.slice(1)).toEqual([
      {
        path: "/api/v1/credential-sharing/export/resume",
        body: { instanceId: "host", contextId: "private" },
      },
      {
        path: "/api/v1/credential-sharing/export/restart",
        body: { vaultDirectory: "C:/new-vault", instanceId: "host", contextId: "private" },
      },
    ]);
    client.dispose();
  });
  it("retains inferred members, own state, private fields, accessors and method binding", async () => {
    const withCounter = defineServiceSlice(
      ["increment", "count"],
      (Base: typeof ServiceClientBase) =>
        class extends Base {
          #count = 0;
          get count() {
            return this.#count;
          }
          increment(): number {
            return ++this.#count;
          }
        },
    );
    const withLabel = defineServiceSlice(
      ["label"],
      (Base: typeof ServiceClientBase) =>
        class extends Base {
          readonly label = "shared";
        },
    );
    class Client extends mixin(
      ServiceClientBase,
      withCounter,
      withLabel,
      withProviderManagement,
      withCredentialManagement,
    ) {}
    const transport = fakeTransport();
    const client = new Client(transport);
    const { increment, waitForEvents } = client;
    expect(increment()).toBe(1);
    expect(client.count).toBe(1);
    expect(client.label).toBe("shared");
    await waitForEvents();
    const provider: IProviderService = client.providers;
    expect(provider).toBe(client.providers);
    client.dispose();
    client.dispose();
    expect(transport.dispose).toHaveBeenCalledOnce();
    // A missing slice remains a compile-time error, rather than being asserted into a product facade.
    // @ts-expect-error The lifecycle alone is not a provider service.
    const invalid: IProviderService = new ServiceClientBase(transport);
    void invalid;
  });

  it("rejects repeated ownership, lifecycle overrides and factories that ignore their base", () => {
    expect(() => mixin(ServiceClientBase, withProviderManagement, withProviderManagement)).toThrow(
      "multiple owners: providers",
    );
    const lifecycle = defineServiceSlice(
      ["dispose"],
      (Base: typeof ServiceClientBase) => class extends Base {},
    );
    expect(() => mixin(ServiceClientBase, lifecycle)).toThrow("multiple owners: dispose");
    const ignoresBase = defineServiceSlice(
      ["other"],
      (_Base: typeof ServiceClientBase) =>
        class {
          readonly other = true;
        },
    );
    expect(() => mixin(ServiceClientBase, ignoresBase)).toThrow("must extend");
  });

  it("uses one transport and retains the auth session's original backend context", async () => {
    let contextId = "old";
    const snapshot = (): ProviderManagementSnapshot => ({
      schemaVersion: 1,
      instanceId: "host",
      revision: 1,
      generatedAt: "now",
      stamp: { instanceId: "host", scope: "providers", revision: 1 },
      backend: { contextId, selected: "private", active: "private" },
      providers: [],
      accounts: [],
      connections: [],
      actions: {},
    });
    const requests: { path: string; input: unknown }[] = [];
    const transport = fakeTransport();
    transport.request = async <I, O>(
      operation: ApiOperation<I, O>,
      input: I,
    ): Promise<ServiceResult<O>> => {
      const path = operation.path(input);
      requests.push({ path, input });
      return {
        ok: true,
        value: (path === "/api/v1/providers"
          ? snapshot()
          : path.endsWith("/start")
            ? {
                status: "pending",
                sessionId: "session-1",
                interaction: "device-code",
                userCode: "code",
                verificationUri: "https://provider.test",
              }
            : undefined) as O,
      };
    };
    class Client extends mixin(
      ServiceClientBase,
      withProviderManagement,
      withCredentialManagement,
    ) {}
    const client = new Client(transport);
    expect(await client.providers.deleteAccount("a")).toMatchObject({
      ok: false,
      error: { code: "stale-context" },
    });
    await client.providers.getSnapshot();
    await client.providers.startAuth({ offeringId: "codex", method: "device-code" });
    contextId = "new";
    await client.providers.getSnapshot();
    await client.providers.finishAuth("session-1");
    await client.providers.setAccountEnabled("a", false, {
      instanceId: "host",
      contextId: "form-baseline",
    });
    expect(requests.at(-2)).toEqual({
      path: "/api/v1/auth/sessions/session-1/finish",
      input: { sessionId: "session-1", instanceId: "host", contextId: "old" },
    });
    expect(requests.at(-1)?.input).toMatchObject({ contextId: "form-baseline" });
  });
});

describe("shared fetch and event transport", () => {
  it("multiplexes public/product listeners over one SSE, preserving other subscriptions on page release", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controllers.push(controller);
            },
            cancel,
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const transport = new FetchServiceTransport({ baseUrl: "/api", fetchImpl });
    const providers = vi.fn();
    const credentials = vi.fn();
    const releaseProviders = transport.subscribe(providerEventChannel, providers);
    transport.subscribe(credentialEventChannel, credentials);
    const ready = transport.waitForEvents();
    await vi.waitFor(() => expect(controllers).toHaveLength(1));
    const emit = (type: string, value: unknown) =>
      controllers[0].enqueue(
        new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`),
      );
    emit("ready", {
      schemaVersion: 1,
      instanceId: "host",
      stamps: [
        { instanceId: "host", scope: "providers", revision: 2 },
        { instanceId: "host", scope: "credentials", revision: 3 },
      ],
    });
    expect(await ready).toEqual({ ok: true, value: undefined });
    await vi.waitFor(() => expect(providers).toHaveBeenCalledOnce());
    expect(credentials).toHaveBeenCalledOnce();
    releaseProviders();
    emit("changed", {
      schemaVersion: 1,
      stamp: { instanceId: "host", scope: "credentials", revision: 4 },
      contextId: "private",
      reasons: ["credentials"],
    });
    await vi.waitFor(() => expect(credentials).toHaveBeenCalledTimes(2));
    expect(providers).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0][0])).toBe("/api/v1/events");
    expect(cancel).not.toHaveBeenCalled();
    transport.dispose();
    transport.dispose();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("preserves nullable reads, decodes void null, rejects invalid envelopes and never retries writes", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, value: null }));
    const transport = new FetchServiceTransport({ baseUrl: "https://app.test/api", fetchImpl });
    const nullable = apiOperation<void, string | null>("GET", "/api/v1/test");
    const mutation = apiOperation<{ value: number }, void>("POST", "/api/v1/test", {
      body: (value) => value,
      voidResult: true,
    });
    expect(await transport.request(nullable, undefined)).toEqual({ ok: true, value: null });
    fetchImpl.mockResolvedValue(Response.json({ ok: true, value: null }));
    expect(await transport.request(mutation, { value: 1 })).toEqual({ ok: true, value: undefined });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      cache: "no-store",
      body: '{"value":1}',
    });
    fetchImpl.mockRejectedValue(new Error("offline"));
    expect(await transport.request(mutation, { value: 2 })).toMatchObject({
      ok: false,
      error: { code: "transport" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    fetchImpl.mockResolvedValue(Response.json({ ok: true }));
    expect(await transport.request(nullable, undefined)).toMatchObject({
      ok: false,
      error: { code: "transport" },
    });
    transport.dispose();
  });

  it("aborts pending requests and settles event waiters when root service is disposed", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      requestSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) =>
        requestSignal!.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    });
    const transport = new FetchServiceTransport({ baseUrl: "", fetchImpl });
    const request = transport.request(
      apiOperation<void, void>("POST", "/api/v1/test", { voidResult: true }),
      undefined,
    );
    transport.dispose();
    expect(requestSignal?.aborted).toBe(true);
    expect((await request).ok).toBe(false);
    expect((await transport.waitForEvents()).ok).toBe(false);
  });
});
