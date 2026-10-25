import type {
  NotificationDeliveryStatus,
  NotificationRequest,
} from "@astra-conductor/polyquota-contract";
import type { HostClient } from "./host-service-vue";

export type NotificationPermissionState = NotificationPermission | "unsupported";

export function notificationPermission(): NotificationPermissionState {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Called only from the permission button's user gesture. */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  return typeof Notification === "undefined" ? "unsupported" : Notification.requestPermission();
}

/** One page-local receipt per id; reconnect replay never displays the same item twice. */
export function startBrowserNotifications(client: HostClient): () => void {
  const seen = new Map<string, number>();
  const active = new Map<string, () => void>();
  let disposed = false;
  const receive = (request: NotificationRequest): void => {
    const now = Date.now();
    const expiry = Date.parse(request.expiresAt);
    for (const [id, expires] of seen) if (expires <= now) seen.delete(id);
    if (disposed || !Number.isFinite(expiry) || expiry <= now || seen.has(request.notificationId))
      return;
    // Receipts are bounded independently of the server and retained until expiry.
    if (seen.size >= 64) return;
    seen.set(request.notificationId, expiry);
    const acknowledge = (status: NotificationDeliveryStatus): void => {
      if (!disposed && Date.now() < expiry)
        void client.acknowledge(request.notificationId, status).catch(() => undefined);
    };
    if (notificationPermission() !== "granted") {
      acknowledge("denied");
      return;
    }
    try {
      const notification = new Notification(request.title, { body: request.body });
      let settled = false;
      const finish = (status: NotificationDeliveryStatus): void => {
        if (settled) return;
        settled = true;
        cleanup();
        acknowledge(status);
      };
      const shown = (): void => finish("delivered");
      const failed = (): void => finish("failed");
      const cleanup = (): void => {
        clearTimeout(timer);
        notification.removeEventListener("show", shown);
        notification.removeEventListener("error", failed);
        notification.removeEventListener("close", failed);
        active.delete(request.notificationId);
      };
      const timer = setTimeout(
        () => {
          finish("failed");
          notification.close();
        },
        Math.min(2_000, expiry - now),
      );
      notification.addEventListener("show", shown);
      notification.addEventListener("error", failed);
      notification.addEventListener("close", failed);
      active.set(request.notificationId, () => {
        cleanup();
        notification.close();
      });
    } catch {
      acknowledge("failed");
    }
  };
  const unsubscribe = client.subscribeNotifications(receive);
  return () => {
    disposed = true;
    unsubscribe();
    for (const cancel of [...active.values()]) cancel();
    seen.clear();
  };
}
