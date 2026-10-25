import { Notification, type Event } from "electron";
import type { SystemNotificationPort, SystemNotificationOptions } from "../../polling-service.js";
const NOTIFICATION_DELIVERY_TIMEOUT_MS = 3_000;
export class ElectronSystemNotificationPort implements SystemNotificationPort {
  async deliver(options: SystemNotificationOptions): Promise<boolean> {
    if (!Notification.isSupported()) return false;
    return new Promise((resolve) => {
      let settled = false;
      let notification: Notification | null = null;
      const finish = (delivered: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        notification?.removeListener("show", onShow);
        notification?.removeListener("failed", onFailed);
        notification = null;
        resolve(delivered);
      };
      const onShow = (): void => finish(true);
      const onFailed = (_event: Event, error: string): void => {
        console.warn("System notification delivery failed", error);
        finish(false);
      };
      const timeout = setTimeout(() => {
        console.warn("System notification delivery was not confirmed");
        finish(false);
      }, NOTIFICATION_DELIVERY_TIMEOUT_MS);
      try {
        notification = new Notification(options);
        notification.once("show", onShow);
        notification.once("failed", onFailed);
        notification.show();
      } catch (error) {
        console.warn(
          "System notification delivery failed",
          error instanceof Error ? error.message : "unknown error",
        );
        finish(false);
      }
    });
  }
}
