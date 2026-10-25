import { describe, expect, it, vi } from "vitest";
import { eventStream } from "../src/http/event-stream.js";
import { ApplicationEvents } from "../src/runtime/application-events.js";
import type { PolyQuotaRuntime } from "../src/runtime/start-runtime.js";
import { POLYQUOTA_SCHEMA_VERSION } from "@astra-conductor/polyquota-contract";

function fixture() {
  const events = new ApplicationEvents();
  const runtime = {
    state: "ready",
    events,
    application: { instanceId: "runtime", getRevision: () => 1 },
    browserNotifications: { pending: () => [] },
  } as unknown as PolyQuotaRuntime;
  return { events, runtime };
}

describe("bounded backend event stream", () => {
  it("registers before ready, coalesces state under backpressure and cleans up on cancel", async () => {
    const { events, runtime } = fixture();
    const response = eventStream(runtime, new AbortController().signal);
    expect(events.subscriberCount).toBe(1);
    for (let revision = 2; revision <= 1000; revision += 1)
      events.publish({
        type: "changed",
        data: {
          schemaVersion: POLYQUOTA_SCHEMA_VERSION,
          instanceId: "runtime",
          revision,
          reasons: ["settings"],
          occurredAt: "now",
        },
      });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"revision":1000');
    await reader.cancel();
    await reader.cancel();
    expect(events.subscriberCount).toBe(0);
  });

  it("closes instead of dropping unbounded non-state events and clears heartbeat timers", async () => {
    vi.useFakeTimers();
    try {
      const { events, runtime } = fixture();
      const response = eventStream(runtime, new AbortController().signal);
      for (let number = 0; number < 70; number += 1)
        events.publish({ type: "auth", data: { sessionId: `session-${number}` } });
      expect(events.subscriberCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await response.body!.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases streams on request abort and runtime event shutdown", async () => {
    const { events, runtime } = fixture();
    const abort = new AbortController();
    const response = eventStream(runtime, abort.signal);
    abort.abort();
    expect(events.subscriberCount).toBe(0);
    await response.body!.cancel();
    const second = eventStream(runtime, new AbortController().signal);
    events.dispose();
    expect(events.subscriberCount).toBe(0);
    await second.body!.cancel();
  });
});
