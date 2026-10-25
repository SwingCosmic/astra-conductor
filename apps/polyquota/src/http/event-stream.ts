import { POLYQUOTA_SCHEMA_VERSION } from "@astra-conductor/polyquota-contract";
import type { PolyQuotaRuntime } from "../runtime/start-runtime.js";
import type { ApplicationEvent } from "../runtime/application-events.js";

export function eventStream(runtime: PolyQuotaRuntime, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let cleanup = (): void => undefined;
  let flush = (): void => undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let unsubscribe = (): void => undefined;
        const queue: { type: string; text: string }[] = [];
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          signal.removeEventListener("abort", cleanup);
          queue.length = 0;
          try {
            controller.close();
          } catch {
            /* reader already cancelled */
          }
        };
        flush = () => {
          while (!closed && queue.length && (controller.desiredSize ?? 0) > 0) {
            controller.enqueue(encoder.encode(queue.shift()!.text));
          }
        };
        const send = (type: string, data: unknown): void => {
          if (closed) return;
          if (type === "changed") {
            const existing = queue.findIndex((item) => item.type === type);
            if (existing >= 0) queue.splice(existing, 1);
          }
          // Disconnect instead of silently dropping auth/notification messages.
          if (queue.length >= 64) {
            cleanup();
            return;
          }
          queue.push({
            type,
            text:
              type === "heartbeat"
                ? ": heartbeat\n\n"
                : `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
          });
          flush();
        };
        unsubscribe = runtime.events.subscribe(
          (event: ApplicationEvent) => send(event.type, event.data),
          cleanup,
        );
        if (closed) return;
        signal.addEventListener("abort", cleanup, { once: true });
        if (signal.aborted || runtime.state !== "ready") {
          cleanup();
          return;
        }
        // Listener is installed before publishing the current revision barrier.
        send("ready", {
          schemaVersion: POLYQUOTA_SCHEMA_VERSION,
          instanceId: runtime.application.instanceId,
          revision: runtime.application.getRevision(),
        });
        for (const request of runtime.browserNotifications.pending()) send("notification", request);
        if (closed) return;
        heartbeat = setInterval(() => {
          if (!queue.length) send("heartbeat", null);
        }, 15_000);
        heartbeat.unref?.();
      },
      pull() {
        flush();
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: 1 },
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
