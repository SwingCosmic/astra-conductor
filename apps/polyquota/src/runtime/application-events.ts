import type {
  NotificationRequest,
  PolyQuotaChangedEvent,
} from "@astra-conductor/polyquota-contract";

export type ApplicationEvent =
  | { type: "changed"; data: PolyQuotaChangedEvent }
  | { type: "auth"; data: { sessionId: string } }
  | { type: "notification"; data: NotificationRequest };

export interface ApplicationEventSource {
  subscribe(listener: (event: ApplicationEvent) => void, closed?: () => void): () => void;
}

export class ApplicationEvents implements ApplicationEventSource {
  private readonly listeners = new Map<
    (event: ApplicationEvent) => void,
    (() => void) | undefined
  >();
  private closed = false;

  get subscriberCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: (event: ApplicationEvent) => void, closed?: () => void): () => void {
    if (this.closed) {
      closed?.();
      return () => undefined;
    }
    this.listeners.set(listener, closed);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: ApplicationEvent): void {
    if (this.closed) return;
    for (const listener of this.listeners.keys()) {
      try {
        listener(event);
      } catch {
        console.warn("PolyQuota event subscriber failed");
      }
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const callbacks = [...this.listeners.values()];
    this.listeners.clear();
    for (const closed of callbacks) closed?.();
  }
}
