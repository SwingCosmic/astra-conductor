import { inject, type InjectionKey } from "vue";
import type {
  IHostService,
  INotificationService,
  NotificationRequest,
} from "@astra-conductor/contract/polyquota";

export interface HostClient extends IHostService, INotificationService {
  subscribeNotifications(listener: (request: NotificationRequest) => void): () => void;
}

export const hostServiceKey: InjectionKey<HostClient> = Symbol("hostService");

export function useHostService(): HostClient | null {
  return inject(hostServiceKey, null);
}
