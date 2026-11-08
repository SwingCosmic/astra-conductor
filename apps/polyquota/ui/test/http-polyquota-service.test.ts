import { afterEach, describe, expect, it, vi } from "vitest";
import { POLYQUOTA_SCHEMA_VERSION } from "@astra-conductor/contract/polyquota";
import { FetchServiceTransport, readEventStream } from "@astra-conductor/shared-ui/services";
import { HttpPolyQuotaService } from "../src/services/http-polyquota-service";

afterEach(() => vi.useRealTimers());
const createClient = (fetchImpl: typeof fetch) =>
  new HttpPolyQuotaService(
    new FetchServiceTransport({ baseUrl: "http://127.0.0.1:4877/api", fetchImpl }),
  );
describe("PolyQuota composed HTTP client", () => {
  it("maps product methods and host notifications through the shared transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true, value: null }));
    const service = createClient(fetchImpl);
    await service.refreshAccount("account-1");
    await service.refreshAll();
    await service.redeemResetCredit("account-1", { kind: "aggregate" });
    const settings = {
      pollingEnabled: true,
      pollingIntervalMinutes: 15,
      taskbarProgressEnabled: false,
    };
    expect(await service.saveSettings(settings)).toEqual({ ok: true, value: undefined });
    await service.getSystemStatus();
    await service.getCapabilities();
    await service.showWindow();
    await service.acknowledge("notification-1", "delivered");
    expect(
      fetchImpl.mock.calls.map(([url, init]) => [
        String(url).replace("http://127.0.0.1:4877", ""),
        init?.method,
        init?.body ? JSON.parse(String(init.body)) : null,
      ]),
    ).toEqual([
      ["/api/v1/polyquota/accounts/account-1/refresh", "POST", null],
      ["/api/v1/polyquota/accounts/refresh-all", "POST", null],
      [
        "/api/v1/polyquota/reset-credits/redeem",
        "POST",
        { accountId: "account-1", redemption: { kind: "aggregate" } },
      ],
      ["/api/v1/polyquota/settings/save", "POST", settings],
      ["/api/v1/polyquota/system-status", "GET", null],
      ["/api/v1/host/capabilities", "GET", null],
      ["/api/v1/host/window/show", "POST", null],
      ["/api/v1/notifications/notification-1/acknowledge", "POST", { status: "delivered" }],
    ]);
    service.dispose();
  });
  it("exposes common operations through their public groups with the captured context", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      Response.json({
        ok: true,
        value: String(url).endsWith("/start")
          ? { status: "pending", sessionId: "session-1" }
          : null,
      }),
    );
    const service = createClient(fetchImpl);
    const context = { instanceId: "first", contextId: "private-first" };
    await service.providers.setAccountEnabled("account-1", false, context);
    await service.providers.deleteAccount("account-1", {
      ...context,
      expectedRecordRevision: "r1",
    });
    await service.providers.refreshCredentials("account-1", context);
    await service.providers.startAuth({ offeringId: "codex", method: "browser-oauth" }, context);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:4877/api/v1/accounts/account-1/set-enabled",
      "http://127.0.0.1:4877/api/v1/accounts/account-1/delete",
      "http://127.0.0.1:4877/api/v1/accounts/account-1/refresh-credentials",
      "http://127.0.0.1:4877/api/v1/auth/sessions/start",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[3]![1]?.body))).toMatchObject(context);
    expect(service).not.toHaveProperty("startAuth");
    service.dispose();
  });
  it("reports failures explicitly and never retries mutations", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const service = createClient(fetchImpl);
    expect((await service.getSnapshot()).ok).toBe(false);
    expect(
      (
        await service.providers.deleteAccount("account-1", {
          instanceId: "i",
          contextId: "c",
          expectedRecordRevision: "r1",
        })
      ).ok,
    ).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    fetchImpl.mockResolvedValue(
      Response.json({ ok: true, value: { schemaVersion: POLYQUOTA_SCHEMA_VERSION - 1 } }),
    );
    expect(await service.getSnapshot()).toMatchObject({
      ok: false,
      error: { code: "contract-mismatch" },
    });
    service.dispose();
  });
  it("decodes split UTF-8, comments, multiline fields and multiple frames", async () => {
    const encoded = new TextEncoder().encode(
      ": keepalive\r\nevent: changed\r\ndata: 中文\r\ndata: 第二行\r\n\r\nevent: ready\ndata: {}\n\n",
    );
    const received: unknown[] = [];
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    await readEventStream(response, (event) => received.push(event), new AbortController().signal);
    expect(received).toEqual([
      { type: "changed", data: "中文\n第二行" },
      { type: "ready", data: "{}" },
    ]);
  });
  it("shares one event connection across product and common pages until service disposal", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(next) {
              controller = next;
            },
            cancel,
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const service = createClient(fetchImpl);
    const common = vi.fn();
    const product = vi.fn();
    const stopCommon = service.providers.subscribe(common);
    const stopProduct = service.subscribe(product);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const ready = service.waitForEvents();
    controller.enqueue(
      new TextEncoder().encode(
        `event: ready\ndata: ${JSON.stringify({
          schemaVersion: 1,
          instanceId: "first",
          stamps: [
            { instanceId: "first", scope: "providers", revision: 0 },
            { instanceId: "first", scope: "polyquota", revision: 5 },
          ],
        })}\n\n`,
      ),
    );
    expect(await ready).toEqual({ ok: true, value: undefined });
    await vi.waitFor(() => {
      expect(common).toHaveBeenCalledOnce();
      expect(product).toHaveBeenCalledOnce();
    });
    stopCommon();
    expect(cancel).not.toHaveBeenCalled();
    stopProduct();
    expect(cancel).not.toHaveBeenCalled();
    service.dispose();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
});
