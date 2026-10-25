export interface ServiceId<T> {
  readonly name: string;
  readonly type?: T;
}

export function serviceId<T>(name: string): ServiceId<T> {
  return Object.freeze({ name });
}

export interface ServiceResolver {
  get<T>(id: ServiceId<T>): T;
}

interface Registration {
  dependencies: readonly ServiceId<unknown>[];
  create: (resolver: ServiceResolver) => unknown;
  dispose?: (value: unknown) => void | Promise<void>;
}

/** Application scope only. Factories can access exactly their declared dependencies. */
export class ServiceRegistry implements ServiceResolver {
  private readonly registrations = new Map<ServiceId<unknown>, Registration>();
  private readonly instances = new Map<ServiceId<unknown>, unknown>();
  private readonly constructing: ServiceId<unknown>[] = [];
  private readonly failures = new Map<ServiceId<unknown>, unknown>();
  private sealed = false;
  private closing: Promise<void> | undefined;

  register<T>(
    id: ServiceId<T>,
    dependencies: readonly ServiceId<unknown>[],
    create: (resolver: ServiceResolver) => T,
    dispose?: (value: T) => void | Promise<void>,
  ): this {
    if (this.sealed) throw new Error("Service registry is sealed");
    if (this.registrations.has(id)) throw new Error(`Duplicate service: ${id.name}`);
    this.registrations.set(id, {
      dependencies,
      create,
      dispose: dispose ? (value) => dispose(value as T) : undefined,
    });
    return this;
  }

  value<T>(id: ServiceId<T>, value: T, dispose?: (value: T) => void | Promise<void>): this {
    return this.register(id, [], () => value, dispose);
  }

  override<T>(
    id: ServiceId<T>,
    dependencies: readonly ServiceId<unknown>[],
    create: (resolver: ServiceResolver) => T,
    dispose?: (value: T) => void | Promise<void>,
  ): this {
    if (this.sealed || this.instances.size) throw new Error("Cannot override resolved services");
    if (!this.registrations.delete(id)) throw new Error(`Unknown service: ${id.name}`);
    return this.register(id, dependencies, create, dispose);
  }

  validate(): void {
    const complete = new Set<ServiceId<unknown>>();
    const visit = (id: ServiceId<unknown>, chain: ServiceId<unknown>[]): void => {
      if (chain.includes(id)) {
        throw new Error(
          `Circular services: ${[...chain, id].map((item) => item.name).join(" -> ")}`,
        );
      }
      const entry = this.registrations.get(id);
      if (!entry)
        throw new Error(`Missing service: ${[...chain, id].map((item) => item.name).join(" -> ")}`);
      if (complete.has(id)) return;
      for (const dependency of entry.dependencies) visit(dependency, [...chain, id]);
      complete.add(id);
    };
    for (const id of this.registrations.keys()) visit(id, []);
  }

  get<T>(id: ServiceId<T>): T {
    if (this.closing) throw new Error("Service registry is disposed");
    if (!this.sealed) {
      this.validate();
      this.sealed = true;
    }
    if (this.failures.has(id)) throw this.failures.get(id);
    if (this.instances.has(id)) return this.instances.get(id) as T;
    if (this.constructing.includes(id)) throw new Error(`Circular construction: ${id.name}`);
    const entry = this.registrations.get(id);
    if (!entry) throw new Error(`Missing service: ${id.name}`);
    const accessed = new Set<ServiceId<unknown>>();
    let active = true;
    const resolver: ServiceResolver = {
      get: <U>(dependency: ServiceId<U>): U => {
        if (!active) throw new Error(`Deferred service lookup: ${id.name}`);
        if (!entry.dependencies.includes(dependency)) {
          throw new Error(`Undeclared dependency: ${id.name} -> ${dependency.name}`);
        }
        accessed.add(dependency);
        return this.get(dependency);
      },
    };
    this.constructing.push(id);
    try {
      const value = entry.create(resolver) as T;
      // Retain ownership even if the declaration audit below fails.
      this.instances.set(id, value);
      const unused = entry.dependencies.filter((dependency) => !accessed.has(dependency));
      if (unused.length)
        throw new Error(
          `Unused dependencies: ${id.name}: ${unused.map((item) => item.name).join(", ")}`,
        );
      return value;
    } catch (error) {
      this.failures.set(id, error);
      throw error;
    } finally {
      active = false;
      this.constructing.pop();
    }
  }

  dispose(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      for (const [id, value] of [...this.instances].reverse()) {
        try {
          await this.registrations.get(id)?.dispose?.(value);
        } catch (error) {
          errors.push(error);
        }
      }
      this.instances.clear();
      if (errors.length) throw new AggregateError(errors, "Service disposal failed");
    });
    return this.closing;
  }
}
