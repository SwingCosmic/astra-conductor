import type { ServiceResult } from "./errors.js";

export interface HostCapabilities {
  desktop: boolean;
  notifications: "host" | "browser";
  credentials: boolean;
}

export interface IHostService {
  getCapabilities(): Promise<ServiceResult<HostCapabilities>>;
  showWindow(): Promise<ServiceResult<void>>;
}

export interface NotificationRequest {
  notificationId: string;
  title: string;
  body: string;
  expiresAt: string;
}

export type NotificationDeliveryStatus = "delivered" | "denied" | "failed";

export interface INotificationService {
  acknowledge(
    notificationId: string,
    status: NotificationDeliveryStatus,
  ): Promise<ServiceResult<void>>;
}
