import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationRequest } from "@astra-conductor/polyquota-contract";
import HostStatus from "../src/components/HostStatus.vue";
import { startBrowserNotifications } from "../src/services/browser-notifications";
import { hostServiceKey, type HostClient } from "../src/services/host-service-vue";

class BrowserNotification extends EventTarget {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => BrowserNotification.permission);
  static instances: BrowserNotification[] = [];
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    BrowserNotification.instances.push(this);
  }
}

function setup() {
  vi.useFakeTimers();
  BrowserNotification.permission = "granted";
  BrowserNotification.instances = [];
  BrowserNotification.requestPermission.mockClear();
  vi.stubGlobal("Notification", BrowserNotification);
  let receive: (request: NotificationRequest) => void = () => undefined;
  const unsubscribe = vi.fn();
  const acknowledge = vi.fn<HostClient["acknowledge"]>(async () => ({
    ok: true,
    value: undefined,
  }));
  const client: HostClient = {
    getCapabilities: async () => ({
      ok: true,
      value: { desktop: false, notifications: "browser", credentials: false },
    }),
    showWindow: async () => ({ ok: true, value: undefined }),
    acknowledge,
    subscribeNotifications(listener) {
      receive = listener;
      return unsubscribe;
    },
  };
  const send = (id = "notice") =>
    receive({
      notificationId: id,
      title: "用量提醒",
      body: "剩余额度偏低",
      expiresAt: new Date(Date.now() + 3000).toISOString(),
    });
  return { client, acknowledge, send, unsubscribe };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser notification delivery", () => {
  it("acknowledges only show, deduplicates reconnect replay and ignores later errors", () => {
    const { client, send, acknowledge } = setup();
    const stop = startBrowserNotifications(client);
    send();
    send();
    expect(BrowserNotification.instances).toHaveLength(1);
    expect(acknowledge).not.toHaveBeenCalled();
    const notification = BrowserNotification.instances[0]!;
    notification.dispatchEvent(new Event("show"));
    notification.dispatchEvent(new Event("error"));
    expect(acknowledge.mock.calls).toEqual([["notice", "delivered"]]);
    send();
    expect(BrowserNotification.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it.each(["default", "denied", "unsupported"] as const)(
    "never prompts or reports success with %s permission",
    (permission) => {
      const { client, send, acknowledge } = setup();
      if (permission === "unsupported") vi.stubGlobal("Notification", undefined);
      else BrowserNotification.permission = permission;
      const stop = startBrowserNotifications(client);
      send();
      expect(acknowledge.mock.calls).toEqual([["notice", "denied"]]);
      expect(BrowserNotification.requestPermission).not.toHaveBeenCalled();
      expect(BrowserNotification.instances).toHaveLength(0);
      stop();
    },
  );

  it("handles errors, close before show, timeout and late show without a success receipt", async () => {
    const { client, send, acknowledge } = setup();
    const stop = startBrowserNotifications(client);
    send("error");
    BrowserNotification.instances[0]!.dispatchEvent(new Event("error"));
    send("close");
    BrowserNotification.instances[1]!.dispatchEvent(new Event("close"));
    send("timeout");
    await vi.advanceTimersByTimeAsync(2001);
    BrowserNotification.instances[2]!.dispatchEvent(new Event("show"));
    expect(acknowledge.mock.calls).toEqual([
      ["error", "failed"],
      ["close", "failed"],
      ["timeout", "failed"],
    ]);
    stop();
  });

  it("releases pending listeners and timers on page disposal and ignores expired messages", async () => {
    const { client, send, acknowledge, unsubscribe } = setup();
    const stop = startBrowserNotifications(client);
    send();
    stop();
    BrowserNotification.instances[0]!.dispatchEvent(new Event("show"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(BrowserNotification.instances[0]!.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requests permission only after the settings button is clicked and explains unavailable credentials", async () => {
    const { client } = setup();
    BrowserNotification.permission = "default";
    BrowserNotification.requestPermission.mockImplementationOnce(async () => "granted");
    const wrapper = mount(HostStatus, {
      global: { provide: { [hostServiceKey as symbol]: client } },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("未配置，账号保存与解密暂不可用");
    expect(wrapper.text()).toContain("当前运行环境不提供");
    expect(BrowserNotification.requestPermission).not.toHaveBeenCalled();
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(BrowserNotification.requestPermission).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("已允许");
    wrapper.unmount();
  });

  it("shows host notification capability without offering browser permission", async () => {
    const { client } = setup();
    client.getCapabilities = async () => ({
      ok: true,
      value: { desktop: true, notifications: "host", credentials: true },
    });
    const wrapper = mount(HostStatus, {
      global: { provide: { [hostServiceKey as symbol]: client } },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("系统通知");
    expect(wrapper.find("button").exists()).toBe(false);
    expect(BrowserNotification.requestPermission).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
