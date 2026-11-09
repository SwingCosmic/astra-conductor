import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrokerError,
  SharedBrokerClient,
  type BrokerCredential,
  type BrokerOperation,
} from "../src/index.js";

const credential = (revision = "1"): BrokerCredential => ({
  description: {
    credentialId: "record",
    revision,
    createdByClientId: "source",
    lastUpdatedByClientId: "source",
    metadata: { supportsUsage: "true", extension: "preserved" },
    contentType: "application/custom",
    payloadFormatVersion: 1,
  },
  payload: Buffer.from("C" + revision).toString("base64url"),
});
function operation(operationId: string, status = "granted"): BrokerOperation {
  return {
    operationId,
    credentialId: "record",
    clientId: "client",
    instanceId: "instance",
    status,
    leaseId: "lease",
    fence: "1",
    generation: "generation",
    baseRevision: "1",
    grantedAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    hardDeadline: Date.now() + 120_000,
    resultRevision: status === "committed" ? "2" : null,
    requestHash: null,
    failureCode: null,
    retryable: null,
    upstreamOutcome: null,
  };
}
function harness(
  override?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>,
) {
  const calls: { method: string; params: Record<string, unknown>; channel: number }[] = [];
  const closed = new Set<number>();
  let currentOperation = "";
  let connects = 0;
  const client = new SharedBrokerClient(async () => {
    const channel = ++connects;
    return {
      close() {
        closed.add(channel);
      },
      async call(method: string, params: unknown = {}) {
        const record = params as Record<string, unknown>;
        calls.push({ method, params: record, channel });
        const result = await override?.(method, record);
        if (result !== undefined) return result;
        if (method === "getCredential") return credential();
        if (method === "beginUpdate") {
          currentOperation = String(record.operationId);
          return {
            status: "granted",
            credential: credential(),
            operation: operation(currentOperation),
          };
        }
        if (method === "markUpdateStarted" || method === "renewUpdate")
          return operation(currentOperation, "started");
        if (method === "commitUpdate" || method === "getOperation")
          return operation(currentOperation, "committed");
        if (method === "abortUpdate") return operation(currentOperation, "failed-released");
        if (method === "cancelQueuedUpdate")
          return operation(String(record.operationId), "cancelled");
        throw new Error("Unexpected method: " + method);
      },
    };
  });
  return { client, calls, closed, connects: () => connects };
}
afterEach(() => vi.useRealTimers());

describe("shared broker updates", () => {
  it("uses one independent lease pipe across sequential and simultaneous provider callbacks", async () => {
    const ids = new Map<string, string>();
    const { client, calls, connects, closed } = harness((method, params) => {
      if (method === "beginUpdate") {
        const id = String(params.credentialId),
          op = String(params.operationId);
        ids.set(op, id);
        const body = credential();
        body.description.credentialId = id;
        return {
          status: "granted",
          credential: body,
          operation: { ...operation(op), credentialId: id },
        };
      }
      if (method === "markUpdateStarted" || method === "abortUpdate" || method === "commitUpdate") {
        const lease = (params.lease ?? params) as { operationId: string };
        return {
          ...operation(
            lease.operationId,
            method === "markUpdateStarted"
              ? "started"
              : method === "abortUpdate"
                ? "failed-released"
                : "committed",
          ),
          credentialId: ids.get(lease.operationId),
        };
      }
      if (method === "disconnect") return {};
    });
    const cancel = new AbortController();
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = client.update(
      "slow",
      "1",
      async () => {
        started();
        return new Promise<never>(() => undefined);
      },
      { signal: cancel.signal },
    );
    const cancelled = expect(slow).rejects.toThrow("request-timeout");
    await active;
    await client.getCredential("record");
    const updateFast = () =>
      client.update("fast", "1", async () => ({ value: "ok", commit: { payload: "QzI" } }));
    expect((await updateFast()).value).toBe("ok");
    cancel.abort();
    await cancelled;
    expect((await updateFast()).value).toBe("ok");
    expect(
      new Set(calls.filter((call) => call.method === "beginUpdate").map((call) => call.channel))
        .size,
    ).toBe(1);
    expect(calls.find((call) => call.method === "getCredential")?.channel).not.toBe(
      calls[0]?.channel,
    );
    expect(connects()).toBe(2);
    expect(closed.size).toBe(0);
    await Promise.all([client.disconnect(), client.disconnect()]);
    expect(calls.filter((call) => call.method === "disconnect")).toHaveLength(1);
    expect(closed.size).toBe(2);
  });

  it("can disconnect during a long poll without waiting on the subscriber's external signal", async () => {
    let resolvePage!: () => void;
    let began!: () => void;
    const ready = new Promise<void>((resolve) => {
      began = resolve;
    });
    const page = new Promise<void>((resolve) => {
      resolvePage = resolve;
    });
    const { client, calls, connects, closed } = harness(async (method) => {
      if (method === "watchEvents") {
        began();
        await page;
        return { items: [], nextCursor: "0" };
      }
      if (method === "disconnect") return {};
    });
    const seen = vi.fn(async () => undefined);
    const watching = client.watchEvents(seen, { signal: new AbortController().signal });
    await ready;
    await client.getCredential("record");
    await client.update("record", "1", async () => ({ value: true }));
    expect(connects()).toBe(3);
    await client.disconnect();
    resolvePage();
    await watching;
    expect(closed.size).toBe(3);
    expect(calls.filter((call) => call.method === "disconnect")).toHaveLength(1);
    expect(connects()).toBe(3);
    expect(seen).not.toHaveBeenCalled();
  });

  it("never opens a transport for an update cancelled before the first RPC", async () => {
    const { client, connects } = harness();
    await expect(
      client.update("record", undefined, vi.fn(), { signal: AbortSignal.abort() }),
    ).rejects.toThrow("cancelled");
    expect(connects()).toBe(0);
    client.close();
  });

  it("does not reopen the lease pipe if cleanup loses its connection after close", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { client, calls, connects, closed } = harness((method) => {
      if (method === "abortUpdate") throw new BrokerError("broker-disconnected");
    });
    const updating = client.update("record", "1", async () => {
      entered();
      return new Promise<never>(() => undefined);
    });
    const result = expect(updating).rejects.toThrow("request-timeout");
    await ready;
    client.close();
    await result;
    expect(calls.filter((call) => call.method === "abortUpdate")).toHaveLength(1);
    expect(connects()).toBe(1);
    expect(closed.size).toBe(1);
  });
  it("drains update cleanup before disconnect so late cleanup cannot reopen the session", async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const { client, calls } = harness((method) =>
      method === "disconnect" ? { disconnected: true } : undefined,
    );
    const updating = client.update("record", "1", async () => {
      ready();
      return new Promise<never>(() => undefined);
    });
    const stopped = expect(updating).rejects.toThrow("request-timeout");
    await started;
    await client.disconnect();
    await stopped;
    expect(calls.slice(-2).map((call) => call.method)).toEqual(["abortUpdate", "disconnect"]);
    await expect(client.update("record", "1", async () => ({ value: true }))).rejects.toThrow(
      "client-closed",
    );
  });
  it("obtains and starts a lease before calling the provider and preserves unspecified metadata", async () => {
    const { client, calls } = harness();
    const result = await client.update("record", "1", async (current) => {
      expect(calls.map((call) => call.method)).toEqual(["beginUpdate", "markUpdateStarted"]);
      expect(current).toEqual(credential());
      return { value: "refreshed", commit: { payload: Buffer.from("C2").toString("base64url") } };
    });
    expect(result.value).toBe("refreshed");
    expect(result.operation.status).toBe("committed");
    expect(calls.find((call) => call.method === "commitUpdate")?.params).not.toHaveProperty(
      "setMetadata",
    );
    client.close();
  });
  it("does not refresh the provider when the observed revision became stale", async () => {
    const { client, calls } = harness((method, params) =>
      method === "beginUpdate"
        ? {
            status: "stale",
            credential: credential("2"),
            operation: operation(String(params.operationId), "stale"),
          }
        : undefined,
    );
    const provider = vi.fn();
    await expect(client.update("record", "1", provider)).rejects.toThrow("stale-revision");
    expect(provider).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "markUpdateStarted")).toBe(false);
    client.close();
  });
  it("releases immediately on provider failure without recording its message or changing payload", async () => {
    const { client, calls } = harness();
    await expect(
      client.update("record", undefined, async () => {
        throw new Error("secret-provider-token");
      }),
    ).rejects.toThrow("secret-provider-token");
    const abort = calls.find((call) => call.method === "abortUpdate")!;
    expect(abort.params).toMatchObject({
      failureCode: "provider-error",
      upstreamOutcome: "unknown",
    });
    expect(JSON.stringify(calls)).not.toContain("secret-provider-token");
    expect(calls.some((call) => call.method === "commitUpdate")).toBe(false);
    client.close();
  });
  it("releases an unchanged result without creating a revision", async () => {
    const { client, calls } = harness();
    expect((await client.update("record", "1", async () => ({ value: "unchanged" }))).value).toBe(
      "unchanged",
    );
    expect(calls.find((call) => call.method === "abortUpdate")?.params).toMatchObject({
      upstreamOutcome: "unchanged",
      retryable: false,
    });
    expect(calls.some((call) => call.method === "commitUpdate")).toBe(false);
    client.close();
  });
  it("replays the identical commit after a lost response and never repeats the provider", async () => {
    let commits = 0;
    const { client, calls, connects } = harness((method) => {
      if (method === "commitUpdate" && commits++ === 0)
        throw new BrokerError("broker-disconnected");
    });
    const provider = vi.fn(async () => ({ value: "done", commit: { payload: "QzI" } }));
    expect((await client.update("record", "1", provider)).operation.status).toBe("committed");
    expect(provider).toHaveBeenCalledTimes(1);
    expect(connects()).toBe(2);
    const requests = calls.filter((call) => call.method === "commitUpdate");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.params).toEqual(requests[1]!.params);
    expect(calls.some((call) => call.method === "abortUpdate")).toBe(false);
    client.close();
  });
  it("queries a durable receipt after both commit responses are lost", async () => {
    const { client, calls } = harness((method) => {
      if (method === "commitUpdate") throw new BrokerError("broker-disconnected");
    });
    expect(
      (
        await client.update("record", "1", async () => ({
          value: true,
          commit: { payload: "QzI" },
        }))
      ).operation.status,
    ).toBe("committed");
    expect(calls.at(-1)?.method).toBe("getOperation");
    client.close();
  });
  it("retains unknown commit outcome instead of aborting or calling the provider again", async () => {
    const { client, calls } = harness((method) => {
      if (method === "commitUpdate" || method === "getOperation")
        throw new BrokerError("broker-disconnected");
    });
    await expect(
      client.update("record", "1", async () => ({ value: true, commit: { payload: "QzI" } })),
    ).rejects.toThrow("commit-outcome-unknown");
    expect(calls.some((call) => call.method === "abortUpdate")).toBe(false);
    client.close();
  });
  it("cancels only its queued ticket while another connection remains alive", async () => {
    const signal = new AbortController();
    const { client, calls } = harness((method, params) => {
      if (method === "beginUpdate") {
        signal.abort();
        return {
          status: "queued",
          credential: null,
          operation: operation(String(params.operationId), "queued"),
        };
      }
    });
    const provider = vi.fn();
    await expect(client.update("record", "1", provider, { signal: signal.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(calls.at(-1)?.method).toBe("cancelQueuedUpdate");
    expect(calls.some((call) => call.method === "disconnect")).toBe(false);
    expect(provider).not.toHaveBeenCalled();
    client.close();
  });
  it("renews every ten seconds and rejects provider results beyond the fixed hard deadline", async () => {
    vi.useFakeTimers();
    let complete!: (value: { value: string; commit: { payload: string } }) => void;
    const { client, calls } = harness();
    const provider = vi.fn(
      () =>
        new Promise<{ value: string; commit: { payload: string } }>((resolve) => {
          complete = resolve;
        }),
    );
    const updating = client.update("record", "1", provider);
    const failure = expect(updating).rejects.toThrow("request-timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.filter((call) => call.method === "renewUpdate")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(110_000);
    await failure;
    complete({ value: "late", commit: { payload: "QzI" } });
    await Promise.resolve();
    expect(calls.some((call) => call.method === "commitUpdate")).toBe(false);
    expect(calls.at(-1)?.method).toBe("abortUpdate");
    client.close();
  });
});

describe("descriptions and event catch-up", () => {
  it("retains filters over all pages without reading any payload", async () => {
    const { client, calls } = harness((method, params) => {
      if (method === "listCredentials")
        return {
          items: [credential().description],
          nextCursor: params.afterCredentialId ? null : "record",
        };
    });
    expect(
      await client.listCredentials({ metadataEquals: { supportsUsage: "true" } }),
    ).toHaveLength(2);
    expect(
      calls.every(
        (call) =>
          call.method === "listCredentials" &&
          JSON.stringify(call.params.metadataEquals) === '{"supportsUsage":"true"}',
      ),
    ).toBe(true);
    client.close();
  });
  it("reconnects from the acknowledged cursor and suppresses old record revisions", async () => {
    const signal = new AbortController();
    let watches = 0;
    const pages: string[][] = [];
    const { client, calls } = harness((method) => {
      if (method !== "watchEvents") return;
      watches++;
      if (watches === 2) throw new BrokerError("broker-disconnected");
      return {
        items: [
          {
            credentialId: "record",
            revision: watches === 1 ? "3" : "2",
            eventSequence: watches === 1 ? "3" : "4",
            kind: "credentialChanged",
          },
        ],
        nextCursor: watches === 1 ? "3" : "4",
      };
    });
    await client.watchEvents(
      async (page) => {
        pages.push(page.items.map((item) => item.revision));
        if (pages.length === 2) signal.abort();
      },
      { signal: signal.signal },
    );
    expect(pages).toEqual([["3"], []]);
    expect(
      calls.filter((call) => call.method === "watchEvents").map((call) => call.params.cursor),
    ).toEqual(["0", "3", "3"]);
    client.close();
  });
});
