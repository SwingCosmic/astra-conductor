import { describe, expect, it, vi } from "vitest";
import type { RefreshBatchOutcomeDto } from "@astra-conductor/polyquota-contract";
import { RefreshScheduler } from "../src/refresh-scheduler.js";

function timerHarness() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  return {
    timers: {
      set(callback: () => void): number {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      clear(handle: unknown): void {
        callbacks.delete(handle as number);
      },
    },
    runNext(): void {
      const entry = callbacks.entries().next().value as [number, () => void] | undefined;
      if (!entry) throw new Error("No scheduled timer");
      callbacks.delete(entry[0]);
      entry[1]();
    },
    count: () => callbacks.size,
  };
}

describe("RefreshScheduler", () => {
  it("keeps one timer and applies settings immediately", () => {
    const harness = timerHarness();
    const scheduler = new RefreshScheduler(
      vi.fn(),
      vi.fn(),
      () => new Date("2026-09-27T00:00:00.000Z"),
      harness.timers,
    );

    scheduler.start({ pollingEnabled: true, pollingIntervalMinutes: 15 });
    expect(harness.count()).toBe(1);
    expect(scheduler.getState()).toMatchObject({
      status: "waiting",
      intervalMinutes: 15,
      nextRunAt: "2026-09-27T00:15:00.000Z",
    });

    scheduler.configure({ pollingEnabled: false, pollingIntervalMinutes: 30 });
    expect(harness.count()).toBe(0);
    expect(scheduler.getState()).toMatchObject({
      status: "disabled",
      intervalMinutes: 30,
      nextRunAt: null,
    });
  });

  it("coalesces concurrent batches and schedules only after completion", async () => {
    const harness = timerHarness();
    let finish!: (value: RefreshBatchOutcomeDto) => void;
    const execute = vi.fn(
      (source: RefreshBatchOutcomeDto["source"]) =>
        new Promise<RefreshBatchOutcomeDto>((resolve) => {
          finish = resolve;
          expect(source).toBe("automatic");
        }),
    );
    const scheduler = new RefreshScheduler(
      execute,
      vi.fn(),
      () => new Date("2026-09-27T00:00:00.000Z"),
      harness.timers,
    );
    scheduler.start({ pollingEnabled: true, pollingIntervalMinutes: 15 });

    harness.runNext();
    const joined = scheduler.run("manual");
    expect(execute).toHaveBeenCalledOnce();
    expect(harness.count()).toBe(0);

    finish({ source: "automatic", outcomes: [] });
    await joined;
    expect(harness.count()).toBe(1);
    expect(scheduler.getState()).toMatchObject({
      status: "waiting",
      lastResult: { source: "automatic", succeeded: 0, skipped: 0, failed: 0 },
    });
  });

  it("drains an active batch and refuses new work during shutdown", async () => {
    const harness = timerHarness();
    let finish!: (value: RefreshBatchOutcomeDto) => void;
    const scheduler = new RefreshScheduler(
      () =>
        new Promise<RefreshBatchOutcomeDto>((resolve) => {
          finish = resolve;
        }),
      vi.fn(),
      () => new Date("2026-09-27T00:00:00.000Z"),
      harness.timers,
    );
    scheduler.start({ pollingEnabled: true, pollingIntervalMinutes: 15 });
    const active = scheduler.run("manual");
    const drain = scheduler.stopAndDrain();

    await expect(scheduler.run("manual")).rejects.toThrow("stopping");
    finish({ source: "manual", outcomes: [] });
    await active;
    await drain;
    expect(scheduler.getState().status).toBe("stopped");
    expect(harness.count()).toBe(0);
  });
});
