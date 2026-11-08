import {
  hostOperations,
  notificationEventChannel,
  type NotificationDeliveryStatus,
  type NotificationRequest,
} from "@astra-conductor/contract/common";
import { defineServiceSlice, ServiceClientBase } from "@astra-conductor/shared-ui/services";
export const withHost = defineServiceSlice(
  ["getCapabilities", "showWindow", "acknowledge", "subscribeNotifications"],
  (Base: typeof ServiceClientBase) =>
    class extends Base {
      getCapabilities() {
        return this.transport.request(hostOperations.getCapabilities, undefined);
      }
      showWindow() {
        return this.transport.request(hostOperations.showWindow, undefined);
      }
      acknowledge(id: string, status: NotificationDeliveryStatus) {
        return this.transport.request(hostOperations.acknowledge, { notificationId: id, status });
      }
      subscribeNotifications(listener: (request: NotificationRequest) => void): () => void {
        return this.transport.subscribe(notificationEventChannel, listener);
      }
    },
);
