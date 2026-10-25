import { randomUUID } from "node:crypto";
import { AppError } from "@astra-conductor/core/internal";
import type {
  NotificationDeliveryStatus,
  NotificationRequest,
} from "@astra-conductor/polyquota-contract";
import type { SystemNotificationOptions, SystemNotificationPort } from "../polling-service.js";
import type { ApplicationEvents } from "./application-events.js";

interface Delivery {
  request: NotificationRequest;
  resolve(delivered: boolean): void;
  timer: ReturnType<typeof setTimeout>;
  status?: NotificationDeliveryStatus;
}

/** Browser delivery is confirmed only by a live, pending notification id. */
export class BrowserNotificationService implements SystemNotificationPort {
  private readonly deliveries = new Map<string, Delivery>();
  private stopped = false;

  constructor(
    private readonly events: ApplicationEvents,
    private readonly timeoutMs = 3_000,
  ) {}

  deliver(options: SystemNotificationOptions): Promise<boolean> {
    if (this.stopped || this.events.subscriberCount === 0) return Promise.resolve(false);
    // Bound retained receipts independently of browser behaviour.
    for (const [id, delivery] of this.deliveries) {
      if (Date.parse(delivery.request.expiresAt) <= Date.now()) this.deliveries.delete(id);
    }
    if (this.deliveries.size >= 64) return Promise.resolve(false);
    return new Promise((resolve) => {
      const request: NotificationRequest = {
        notificationId: randomUUID(),
        ...options,
        expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
      };
      const timer = setTimeout(() => {
        resolve(false);
        this.deliveries.delete(request.notificationId);
      }, this.timeoutMs);
      this.deliveries.set(request.notificationId, { request, resolve, timer });
      this.events.publish({ type: "notification", data: request });
    });
  }

  pending(): NotificationRequest[] {
    return [...this.deliveries.values()].filter((item) => !item.status).map((item) => item.request);
  }

  acknowledge(id: string, status: NotificationDeliveryStatus): void {
    const delivery = this.deliveries.get(id);
    if (!delivery || Date.parse(delivery.request.expiresAt) <= Date.now())
      throw new AppError("not-found", "通知不存在或已过期");
    if (delivery.status) return;
    delivery.status = status;
    clearTimeout(delivery.timer);
    delivery.resolve(status === "delivered");
  }

  dispose(): void {
    this.stopped = true;
    for (const delivery of this.deliveries.values()) {
      clearTimeout(delivery.timer);
      delivery.resolve(false);
    }
    this.deliveries.clear();
  }
}
