import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationEvents } from "../src/runtime/application-events.js";
import { BrowserNotificationService } from "../src/runtime/notification-service.js";
import type { NotificationRequest } from "@astra-conductor/polyquota-contract";

afterEach(() => vi.useRealTimers());

describe("browser notification receipts", () => {
  it("confirms delivery once and rejects fabricated or expired ids", async () => {
    vi.useFakeTimers();
    const events = new ApplicationEvents();
    let request: NotificationRequest | undefined;
    events.subscribe((event) => {
      if (event.type === "notification") request = event.data;
    });
    const notifications = new BrowserNotificationService(events, 1000);
    const delivered = notifications.deliver({ title: "quota", body: "remaining" });
    expect(request).toBeDefined();
    expect(() => notifications.acknowledge("unknown", "delivered")).toThrow("不存在");
    notifications.acknowledge(request!.notificationId, "delivered");
    notifications.acknowledge(request!.notificationId, "failed");
    expect(await delivered).toBe(true);
    await vi.advanceTimersByTimeAsync(1001);
    expect(() => notifications.acknowledge(request!.notificationId, "delivered")).toThrow("过期");
    notifications.dispose();
    events.dispose();
  });

  it("never reports success for missing pages, denial, timeout or shutdown", async () => {
    vi.useFakeTimers();
    const events = new ApplicationEvents();
    const notifications = new BrowserNotificationService(events, 1000);
    expect(await notifications.deliver({ title: "quota", body: "remaining" })).toBe(false);
    let id = "";
    events.subscribe((event) => {
      if (event.type === "notification") id = event.data.notificationId;
    });
    const denied = notifications.deliver({ title: "quota", body: "remaining" });
    notifications.acknowledge(id, "denied");
    expect(await denied).toBe(false);
    const timeout = notifications.deliver({ title: "quota", body: "remaining" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await timeout).toBe(false);
    const pending = notifications.deliver({ title: "quota", body: "remaining" });
    notifications.dispose();
    expect(await pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    events.dispose();
  });
});
