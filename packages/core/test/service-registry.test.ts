import { describe, expect, it, vi } from "vitest";
import { CoreServices, ServiceRegistry, serviceId, CodexAdapter } from "../src/internal.js";

describe("application service registry", () => {
  const a = serviceId<{ value: number }>("a");
  const b = serviceId<{ value: number }>("b");

  it("validates missing, duplicate and cyclic dependencies with service chains", () => {
    const missing = new ServiceRegistry().register(a, [b], (services) => services.get(b));
    expect(() => missing.validate()).toThrow("a -> b");
    expect(() => missing.register(a, [], () => ({ value: 1 }))).toThrow("Duplicate");
    const cycle = new ServiceRegistry()
      .register(a, [b], (services) => services.get(b))
      .register(b, [a], (services) => services.get(a));
    expect(() => cycle.validate()).toThrow("a -> b -> a");
  });

  it("constructs lazily once per scope and allows only explicit pre-resolution overrides", () => {
    const factory = vi.fn(() => ({ value: 1 }));
    const first = new ServiceRegistry().register(a, [], factory);
    first.validate();
    expect(factory).not.toHaveBeenCalled();
    first.override(a, [], () => ({ value: 2 }));
    expect(first.get(a)).toBe(first.get(a));
    expect(first.get(a).value).toBe(2);
    const second = new ServiceRegistry().register(a, [], factory);
    expect(second.get(a)).not.toBe(first.get(a));
    expect(() => first.override(a, [], factory)).toThrow("Cannot override");
  });

  it("audits actual reads and rejects deferred resolution", async () => {
    const undeclared = new ServiceRegistry()
      .value(b, { value: 1 })
      .register(a, [], (services) => services.get(b));
    expect(() => undeclared.get(a)).toThrow("Undeclared dependency");
    const unused = new ServiceRegistry()
      .value(b, { value: 1 })
      .register(a, [b], () => ({ value: 2 }));
    expect(() => unused.get(a)).toThrow("Unused dependencies");
    expect(() => unused.get(a)).toThrow("Unused dependencies");
    let late = () => ({ value: 0 });
    const deferred = new ServiceRegistry().value(b, { value: 1 }).register(a, [b], (services) => {
      const value = services.get(b);
      late = () => services.get(b);
      return value;
    });
    deferred.get(a);
    expect(late).toThrow("Deferred service lookup");
    await Promise.all([undeclared.dispose(), unused.dispose(), deferred.dispose()]);
  });

  it("releases acquired dependencies in reverse order once, including factory failures", async () => {
    const order: string[] = [];
    const scope = new ServiceRegistry()
      .register(
        b,
        [],
        () => ({ value: 1 }),
        () => {
          order.push("b");
        },
      )
      .register(
        a,
        [b],
        (services) => {
          services.get(b);
          return { value: 2 };
        },
        () => {
          order.push("a");
          throw new Error("dispose");
        },
      );
    scope.get(a);
    await expect(scope.dispose()).rejects.toThrow("Service disposal failed");
    await expect(scope.dispose()).rejects.toThrow("Service disposal failed");
    expect(order).toEqual(["a", "b"]);
    const failed = new ServiceRegistry()
      .value(b, { value: 1 }, () => {
        order.push("failed.b");
      })
      .register(a, [b], (services) => {
        services.get(b);
        throw new Error("factory");
      });
    expect(() => failed.get(a)).toThrow("factory");
    await failed.dispose();
    expect(order.at(-1)).toBe("failed.b");
  });

  it("does not fall back to global fetch when the required HTTP service is missing", () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    expect(
      () =>
        new CodexAdapter(
          new ServiceRegistry().value(CoreServices.clock, { now: () => new Date() }),
        ),
    ).toThrow("Missing service: core.http");
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });
});
