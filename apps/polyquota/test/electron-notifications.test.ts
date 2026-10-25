import { afterEach, describe, expect, it, vi } from "vitest";
import { ElectronSystemNotificationPort } from "../src/platform/electron/notifications.js";

const state = vi.hoisted(() => ({
  supported: true,
  throws: false,
  instances: [] as { emit(event: string): boolean; listenerCount(event: string): number }[],
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Notification: class extends EventEmitter {
      static isSupported() {
        return state.supported;
      }
      constructor() {
        super();
        if (state.throws) throw new Error("unavailable");
        state.instances.push(this);
      }
      show() {}
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  state.instances = [];
  state.supported = true;
  state.throws = false;
});

describe("Electron notification confirmation", () => {
  it("confirms only show and releases delivery listeners", async () => {
    vi.useFakeTimers();
    const result = new ElectronSystemNotificationPort().deliver({
      title: "quota",
      body: "remaining",
    });
    const settled = vi.fn();
    void result.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    const notification = state.instances[0]!;
    notification.emit("show");
    expect(await result).toBe(true);
    expect(notification.listenerCount("show")).toBe(0);
    expect(notification.listenerCount("failed")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not acknowledge unavailable or unconfirmed delivery", async () => {
    vi.useFakeTimers();
    const port = new ElectronSystemNotificationPort();
    state.supported = false;
    expect(await port.deliver({ title: "quota", body: "remaining" })).toBe(false);
    state.supported = true;
    state.throws = true;
    expect(await port.deliver({ title: "quota", body: "remaining" })).toBe(false);
    state.throws = false;
    const timeout = port.deliver({ title: "quota", body: "remaining" });
    await vi.advanceTimersByTimeAsync(3001);
    expect(await timeout).toBe(false);
    state.instances[0]!.emit("show");
    expect(vi.getTimerCount()).toBe(0);
  });
});
