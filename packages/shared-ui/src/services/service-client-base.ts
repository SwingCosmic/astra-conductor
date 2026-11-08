import type { IServiceTransport, IProductServiceLifecycle } from "@astra-conductor/contract/common";

export class ServiceClientBase implements IProductServiceLifecycle {
  private disposed = false;

  constructor(protected readonly transport: IServiceTransport) {
    // Preserve native inheritance and accessors while allowing event handlers to receive methods.
    const bound = new Set<PropertyKey>();
    for (
      let prototype = Object.getPrototypeOf(this);
      prototype && prototype !== Object.prototype;
      prototype = Object.getPrototypeOf(prototype)
    ) {
      for (const key of Reflect.ownKeys(prototype)) {
        if (key === "constructor" || bound.has(key)) continue;
        bound.add(key);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
        if (typeof descriptor?.value === "function") {
          Object.defineProperty(this, key, { ...descriptor, value: descriptor.value.bind(this) });
        }
      }
    }
  }

  waitForEvents() {
    return this.transport.waitForEvents();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transport.dispose();
  }
}
