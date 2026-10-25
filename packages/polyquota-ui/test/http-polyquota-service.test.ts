import { afterEach, describe, expect, it, vi } from "vitest";
import { POLYQUOTA_SCHEMA_VERSION } from "@astra-conductor/polyquota-contract";
import { HttpPolyQuotaService } from "../src/services/http-polyquota-service";
import { readEventStream } from "../src/services/event-stream";

afterEach(() => vi.useRealTimers());

describe("independent frontend HTTP client", () => {
  it("maps every business method to the shared logical route without IPC or backend imports", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true, value: null }));
    const service = new HttpPolyQuotaService("http://127.0.0.1:4877/api", fetchImpl);
    await service.setAccountEnabled("account-1", false);
    await service.deleteAccount("account-1");
    await service.refreshAccount("account-1");
    await service.refreshAll();
    await service.refreshCredentials("account-1");
    await service.redeemResetCredit("account-1", { kind: "aggregate" });
    await service.redeemResetCredit("account-1", { kind: "item", itemId: "item-1" });
    await service.startAuth({ offeringId: "codex", method: "browser-oauth" });
    await service.getAuthSession("session-1");
    await service.finishAuth("session-1");
    await service.cancelAuth("session-1");
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
        String(url).replace("http://127.0.0.1:4877/api", ""),
        init?.method,
        init?.body ? JSON.parse(String(init.body)) : null,
      ]),
    ).toEqual([
      ["/v1/polyquota/accounts/account-1/set-enabled", "POST", { enabled: false }],
      ["/v1/polyquota/accounts/account-1/delete", "POST", null],
      ["/v1/polyquota/accounts/account-1/refresh", "POST", null],
      ["/v1/polyquota/accounts/refresh-all", "POST", null],
      ["/v1/polyquota/credentials/refresh", "POST", { accountId: "account-1" }],
      [
        "/v1/polyquota/reset-credits/redeem",
        "POST",
        { accountId: "account-1", redemption: { kind: "aggregate" } },
      ],
      [
        "/v1/polyquota/reset-credits/redeem",
        "POST",
        { accountId: "account-1", redemption: { kind: "item", itemId: "item-1" } },
      ],
      [
        "/v1/polyquota/auth/sessions/start",
        "POST",
        { offeringId: "codex", method: "browser-oauth" },
      ],
      ["/v1/polyquota/auth/sessions/session-1", "GET", null],
      ["/v1/polyquota/auth/sessions/session-1/finish", "POST", null],
      ["/v1/polyquota/auth/sessions/session-1/cancel", "POST", null],
      ["/v1/polyquota/settings/save", "POST", settings],
      ["/v1/polyquota/system-status", "GET", null],
      ["/v1/host/capabilities", "GET", null],
      ["/v1/host/window/show", "POST", null],
      ["/v1/notifications/notification-1/acknowledge", "POST", { status: "delivered" }],
    ]);
  });

  it("reports transport/schema failures explicitly and never retries mutations or returns demo data", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const service = new HttpPolyQuotaService("polyquota-app://app", fetchImpl);
    expect((await service.getSnapshot()).ok).toBe(false);
    expect((await service.deleteAccount("account-1")).ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    fetchImpl.mockResolvedValue(
      Response.json({ ok: true, value: { schemaVersion: POLYQUOTA_SCHEMA_VERSION - 1 } }),
    );
    expect(await service.getSnapshot()).toMatchObject({
      ok: false,
      error: { code: "contract-mismatch" },
    });
  });

  it("decodes split UTF-8, CRLF, comments, multiline fields and multiple frames", async () => {
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

  it("waits for ready, invalidates on reconnect/restart and cancels the reader when the final subscriber leaves", async () => {
    vi.useFakeTimers();
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
    const client = new HttpPolyQuotaService("/api", fetchImpl);
    const events: unknown[] = [];
    const dispose = client.subscribe((event) => events.push(event));
    const emit = (index: number, instanceId: string, revision: number): void =>
      controllers[index]!.enqueue(
        new TextEncoder().encode(
          `event: ready\ndata: ${JSON.stringify({ schemaVersion: POLYQUOTA_SCHEMA_VERSION, instanceId, revision })}\n\n`,
        ),
      );
    await vi.advanceTimersByTimeAsync(0);
    const ready = client.waitForEvents();
    emit(0, "first", 20);
    await vi.advanceTimersByTimeAsync(0);
    await ready;
    controllers[0]!.close();
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    emit(1, "second", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toMatchObject([
      { instanceId: "first", revision: 20 },
      { instanceId: "second", revision: 0 },
    ]);
    dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
