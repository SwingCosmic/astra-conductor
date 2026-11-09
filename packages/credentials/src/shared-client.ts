import type { InitialRecord } from "./transfer.js";
import { randomUUID } from "node:crypto";
import { BrokerError, canonical, id, object, requireValue, text, unb64 } from "./format.js";

export interface BrokerConnection {
  call(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}
export interface CredentialDescription {
  credentialId: string;
  revision: string;
  createdByClientId: string;
  lastUpdatedByClientId: string;
  metadata: Record<string, string>;
  contentType: string;
  payloadFormatVersion: number;
}
export interface BrokerCredential {
  description: CredentialDescription;
  payload: string;
}
export interface CredentialFilter {
  createdByClientId?: string;
  lastUpdatedByClientId?: string;
  metadataEquals?: Record<string, string>;
}
export interface CredentialPatch {
  payload?: string;
  contentType?: string;
  payloadFormatVersion?: number;
  setMetadata?: Record<string, string>;
  removeKeys?: string[];
  delete?: boolean;
}
export interface LeaseRef {
  operationId: string;
  leaseId: string;
  fence: string;
  generation: string;
  baseRevision: string;
}
export interface BrokerOperation {
  operationId: string;
  credentialId: string;
  clientId: string;
  instanceId: string;
  status: string;
  leaseId: string | null;
  fence: string;
  generation: string;
  baseRevision: string;
  grantedAt: number;
  expiresAt: number;
  hardDeadline: number;
  resultRevision: string | null;
  requestHash: string | null;
  failureCode: string | null;
  retryable: boolean | null;
  upstreamOutcome: string | null;
}
export interface CredentialEvent {
  credentialId: string;
  revision: string;
  eventSequence: string;
  kind: "credentialChanged" | "credentialDeleted";
}
export interface CredentialEventPage {
  items: CredentialEvent[];
  nextCursor: string;
}
export interface SharingState {
  vaultId: string;
  storageVersion: string;
  attemptId: string;
  keyId: string;
  sourceWatermark: string;
  sourceClientId: string;
  preparedClientIds: string[];
  ownership: "source" | "broker";
}

export function revision(value: unknown): string {
  const result = text(value);
  requireValue(/^(?:0|[1-9][0-9]{0,18})$/.test(result));
  requireValue(BigInt(result) <= 9223372036854775807n);
  return result;
}
function metadata(value: unknown): Record<string, string> {
  const record = object(value);
  requireValue(Object.keys(record).length <= 64);
  for (const [key, item] of Object.entries(record)) {
    requireValue(Buffer.byteLength(text(key)) > 0 && Buffer.byteLength(key) <= 128);
    requireValue(Buffer.byteLength(text(item)) <= 1024);
  }
  requireValue(Buffer.byteLength(canonical(record)) <= 16 * 1024);
  return record as Record<string, string>;
}
export function parseCredentialDescription(value: unknown): CredentialDescription {
  const d = object(value, [
    "credentialId",
    "revision",
    "createdByClientId",
    "lastUpdatedByClientId",
    "metadata",
    "contentType",
    "payloadFormatVersion",
  ]);
  id(d.credentialId);
  revision(d.revision);
  id(d.createdByClientId);
  id(d.lastUpdatedByClientId);
  metadata(d.metadata);
  requireValue(text(d.contentType).length > 0 && text(d.contentType).length <= 256);
  requireValue(
    Number.isSafeInteger(d.payloadFormatVersion) &&
      Number(d.payloadFormatVersion) >= 1 &&
      Number(d.payloadFormatVersion) <= 1000,
  );
  return d as unknown as CredentialDescription;
}
export function parseBrokerCredential(value: unknown): BrokerCredential {
  const record = object(value, ["description", "payload"]);
  parseCredentialDescription(record.description);
  const bytes = unb64(record.payload);
  try {
    requireValue(bytes.length <= 1024 * 1024);
  } finally {
    bytes.fill(0);
  }
  return record as unknown as BrokerCredential;
}
function operation(value: unknown): BrokerOperation {
  const op = object(value, [
    "operationId",
    "credentialId",
    "clientId",
    "instanceId",
    "status",
    "leaseId",
    "fence",
    "generation",
    "baseRevision",
    "grantedAt",
    "expiresAt",
    "hardDeadline",
    "resultRevision",
    "requestHash",
    "failureCode",
    "retryable",
    "upstreamOutcome",
  ]);
  for (const key of ["operationId", "credentialId", "clientId", "instanceId", "generation"])
    id(op[key]);
  requireValue(
    [
      "queued",
      "granted",
      "started",
      "committed",
      "failed-released",
      "expired",
      "cancelled",
      "stale",
    ].includes(text(op.status)),
  );
  if (op.leaseId !== null) id(op.leaseId);
  for (const key of ["fence", "baseRevision"]) revision(op[key]);
  if (op.resultRevision !== null) revision(op.resultRevision);
  for (const key of ["grantedAt", "expiresAt", "hardDeadline"])
    requireValue(Number.isSafeInteger(op[key]) && Number(op[key]) >= 0);
  return op as unknown as BrokerOperation;
}
function eventPage(value: unknown, cursor: string): CredentialEventPage {
  const page = object(value, ["items", "nextCursor"]);
  requireValue(Array.isArray(page.items) && page.items.length <= 200);
  const next = revision(page.nextCursor);
  requireValue(BigInt(next) >= BigInt(cursor));
  for (const value of page.items) {
    const item = object(value, ["credentialId", "revision", "eventSequence", "kind"]);
    id(item.credentialId);
    revision(item.revision);
    requireValue(BigInt(revision(item.eventSequence)) <= BigInt(next));
    requireValue(item.kind === "credentialChanged" || item.kind === "credentialDeleted");
  }
  return page as unknown as CredentialEventPage;
}
function transportFailure(error: unknown): boolean {
  return (
    error instanceof BrokerError &&
    (/^broker-(?:disconnected|request-timeout|pipe-|handshake-)/.test(error.code) ||
      error.code === "session-expired")
  );
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new BrokerError("cancelled"));
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(new BrokerError("cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** Queue only RPC frames on each authenticated pipe; provider callbacks run outside those queues. */
export class SharedBrokerClient {
  private connection?: Promise<BrokerConnection>;
  private updateChannel?: SharedBrokerClient;
  private closed = false;
  private disconnecting?: Promise<void>;
  private readonly operations = new Set<AbortController>();
  private readonly completions = new Set<Promise<void>>();
  private tracking(): () => void {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.completions.add(pending);
    return () => {
      this.completions.delete(pending);
      complete();
    };
  }
  constructor(private readonly connect: () => Promise<BrokerConnection>) {}

  private async rpc(method: string, params: unknown = {}): Promise<unknown> {
    requireValue(!this.closed && (!this.disconnecting || method === "disconnect"), "client-closed");
    const pending = (this.connection ??= this.connect());
    let connection: BrokerConnection;
    try {
      connection = await pending;
    } catch (error) {
      if (this.connection === pending) this.connection = undefined;
      throw error;
    }
    try {
      requireValue(
        !this.closed && (!this.disconnecting || method === "disconnect"),
        "client-closed",
      );
      return await connection.call(method, params);
    } catch (error) {
      if (transportFailure(error)) {
        connection.close();
        if (this.connection === pending) this.connection = undefined;
      }
      throw error;
    }
  }
  /** Replay only operations whose protocol semantics are explicitly idempotent. */
  private async replay(method: string, params: unknown = {}): Promise<unknown> {
    try {
      return await this.rpc(method, params);
    } catch (error) {
      if (!transportFailure(error)) throw error;
      return this.rpc(method, params);
    }
  }
  async getSnapshotWatermark(): Promise<{
    vaultId: string;
    storageVersion: string;
    watermark: string;
  }> {
    const response = object(await this.replay("getSnapshotWatermark"), [
      "vaultId",
      "storageVersion",
      "watermark",
    ]);
    return {
      vaultId: id(response.vaultId),
      storageVersion: id(response.storageVersion),
      watermark: text(response.watermark),
    };
  }
  async createCredential(request: InitialRecord): Promise<BrokerCredential> {
    return parseBrokerCredential(
      await this.replay("createCredential", { ...request, operationId: randomUUID() }),
    );
  }
  async getCredential(credentialId: string): Promise<BrokerCredential> {
    return parseBrokerCredential(
      await this.replay("getCredential", { credentialId: id(credentialId) }),
    );
  }
  async listCredentials(filter: CredentialFilter = {}): Promise<CredentialDescription[]> {
    const items: CredentialDescription[] = [];
    let afterCredentialId: string | undefined;
    for (;;) {
      const page = object(
        await this.replay("listCredentials", {
          ...filter,
          limit: 200,
          ...(afterCredentialId ? { afterCredentialId } : {}),
        }),
        ["items", "nextCursor"],
      );
      requireValue(Array.isArray(page.items) && page.items.length <= 200);
      items.push(...page.items.map(parseCredentialDescription));
      if (page.nextCursor === null) return items;
      const next = id(page.nextCursor);
      requireValue(
        afterCredentialId === undefined || next > afterCredentialId,
        "invalid-page-cursor",
      );
      afterCredentialId = next;
    }
  }
  async getSharingState(): Promise<SharingState> {
    const state = object(await this.replay("getSharingState"), [
      "vaultId",
      "storageVersion",
      "attemptId",
      "keyId",
      "sourceWatermark",
      "sourceClientId",
      "preparedClientIds",
      "ownership",
    ]);
    for (const key of ["vaultId", "storageVersion", "attemptId", "keyId", "sourceClientId"])
      id(state[key]);
    text(state.sourceWatermark);
    requireValue(Array.isArray(state.preparedClientIds));
    state.preparedClientIds.forEach(id);
    requireValue(state.ownership === "source" || state.ownership === "broker");
    return state as unknown as SharingState;
  }
  async getEvents(cursor = "0"): Promise<CredentialEventPage> {
    return eventPage(
      await this.replay("getEvents", { cursor: revision(cursor), limit: 200 }),
      cursor,
    );
  }
  /** Catch up before long polling; reconnect preserves the cursor. Callback must persist before resolving. */
  async watchEvents(
    onPage: (page: CredentialEventPage) => Promise<void>,
    options: { cursor?: string; signal: AbortSignal; onError?: (code: string) => void },
  ): Promise<void> {
    requireValue(!this.closed && !this.disconnecting, "client-closed");
    const watcher = new SharedBrokerClient(this.connect);
    const finish = this.tracking();
    const controller = new AbortController();
    this.operations.add(controller);
    let cursor = options.cursor ?? "0";
    const revisions = new Map<string, string>();
    const stop = () => controller.abort();
    controller.signal.addEventListener(
      "abort",
      () => {
        watcher.close();
        finish();
      },
      { once: true },
    );
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) stop();
    try {
      while (!controller.signal.aborted) {
        try {
          const page = eventPage(
            await watcher.replay("watchEvents", { cursor, limit: 200, waitMilliseconds: 5000 }),
            cursor,
          );
          if (controller.signal.aborted) break;
          const latest = new Map<string, CredentialEvent>();
          for (const item of page.items) {
            const known =
              latest.get(item.credentialId)?.revision ?? revisions.get(item.credentialId) ?? "0";
            if (BigInt(item.revision) > BigInt(known)) latest.set(item.credentialId, item);
          }
          const fresh = [...latest.values()];
          await onPage({ items: fresh, nextCursor: page.nextCursor });
          for (const item of fresh) revisions.set(item.credentialId, item.revision);
          cursor = page.nextCursor;
        } catch (error) {
          if (controller.signal.aborted) break;
          options.onError?.(error instanceof BrokerError ? error.code : "event-sync-failed");
          await delay(1000, controller.signal);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      this.operations.delete(controller);
      options.signal.removeEventListener("abort", stop);
      watcher.close();
      finish();
    }
  }
  async update<T>(
    credentialId: string,
    observedRevision: string | undefined,
    callback: (
      credential: BrokerCredential,
      context: { signal: AbortSignal; operationId: string },
    ) => Promise<{ value: T; commit?: CredentialPatch }>,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ value: T; operation: BrokerOperation }> {
    requireValue(!this.closed && !this.disconnecting, "client-closed");
    // Lease RPCs are short and correlated by operation ID. Keep long polls on their own pipe.
    const worker = (this.updateChannel ??= new SharedBrokerClient(() => {
      requireValue(!this.closed, "client-closed");
      return this.connect();
    }));
    const finish = this.tracking();
    const controller = new AbortController();
    this.operations.add(controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const operationId = randomUUID();
    let lease: LeaseRef | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let renewing: Promise<unknown> | undefined;
    let committing = false;
    let providerStarted = false;
    let ticketMayExist = false;
    try {
      requireValue(!controller.signal.aborted, "cancelled");
      const observed =
        observedRevision ?? (await worker.getCredential(credentialId)).description.revision;
      const request = {
        credentialId: id(credentialId),
        observedRevision: revision(observed),
        operationId,
      };
      let current: BrokerCredential;
      let granted: BrokerOperation;
      for (;;) {
        requireValue(!controller.signal.aborted, "cancelled");
        ticketMayExist = true;
        const result = object(await worker.replay("beginUpdate", request), [
          "status",
          "credential",
          "operation",
        ]);
        if (result.status === "stale") {
          ticketMayExist = false;
          throw new BrokerError("stale-revision");
        }
        if (result.status === "queued") {
          await delay(200, controller.signal);
          continue;
        }
        requireValue(
          result.status === "granted" || result.status === "started",
          "operation-terminal",
        );
        current = parseBrokerCredential(result.credential);
        granted = operation(result.operation);
        requireValue(
          granted.operationId === operationId &&
            granted.credentialId === credentialId &&
            granted.baseRevision === observed &&
            granted.leaseId !== null,
        );
        lease = {
          operationId,
          leaseId: granted.leaseId!,
          fence: granted.fence,
          generation: granted.generation,
          baseRevision: granted.baseRevision,
        };
        break;
      }
      requireValue(!controller.signal.aborted, "cancelled");
      const started = operation(await worker.replay("markUpdateStarted", lease));
      requireValue(started.status === "started", "update-not-started");
      const remaining = Math.max(0, Math.min(120_000, granted.hardDeadline - Date.now()));
      requireValue(
        !controller.signal.aborted && remaining > 0 && started.expiresAt > Date.now(),
        "lease-expired",
      );
      deadline = setTimeout(abort, remaining);
      timer = setInterval(() => {
        if (renewing || controller.signal.aborted || committing) return;
        renewing = worker
          .replay("renewUpdate", lease)
          .then(operation)
          .catch(() => abort())
          .finally(() => {
            renewing = undefined;
          });
      }, 10_000);
      providerStarted = true;
      const work = callback(current, { signal: controller.signal, operationId });
      const cancelled = new Promise<never>((_, reject) => {
        const cancel = () => reject(new BrokerError("request-timeout"));
        if (controller.signal.aborted) cancel();
        else controller.signal.addEventListener("abort", cancel, { once: true });
      });
      const result = await Promise.race([work, cancelled]);
      requireValue(!controller.signal.aborted, "lease-expired");
      if (renewing) await renewing;
      requireValue(!controller.signal.aborted, "lease-expired");
      if (!result.commit) {
        const released = operation(
          await worker.replay("abortUpdate", {
            lease,
            result: "failed",
            failureCode: "cancelled",
            retryable: false,
            upstreamOutcome: "unchanged",
          }),
        );
        return { value: result.value, operation: released };
      }
      committing = true;
      let committed: BrokerOperation;
      try {
        committed = operation(await worker.replay("commitUpdate", { lease, ...result.commit }));
      } catch (error) {
        // A commit response may be lost. Never report upstream failure or repeat the provider call.
        try {
          committed = operation(await worker.replay("getOperation", { operationId }));
        } catch {
          throw new BrokerError("commit-outcome-unknown");
        }
        if (committed.status !== "committed") throw error;
      }
      requireValue(committed.status === "committed", "commit-outcome-unknown");
      return { value: result.value, operation: committed };
    } catch (error) {
      if (!lease && ticketMayExist) {
        // Cancelling one wait must not disconnect another refresh or the event subscriber.
        const pending = await worker
          .replay("cancelQueuedUpdate", { operationId })
          .then(operation)
          .catch(() => undefined);
        if (pending?.leaseId && (pending.status === "granted" || pending.status === "started"))
          lease = {
            operationId,
            leaseId: pending.leaseId,
            fence: pending.fence,
            generation: pending.generation,
            baseRevision: pending.baseRevision,
          };
      }
      if (lease && !committing) {
        await worker
          .replay("abortUpdate", {
            lease,
            result: "failed",
            failureCode: controller.signal.aborted ? "request-timeout" : "provider-error",
            retryable: true,
            upstreamOutcome: providerStarted ? "unknown" : "unchanged",
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      this.operations.delete(controller);
      if (timer) clearInterval(timer);
      if (deadline) clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      finish();
    }
  }
  disconnect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.disconnecting ??= Promise.resolve().then(async () => {
      for (const operation of this.operations) operation.abort();
      await Promise.allSettled([...this.completions]);
      if (this.closed) return;
      try {
        // All pipes have the same client/instance session. Send exactly one logical disconnect.
        const existing = this.connection ? this : (this.updateChannel ?? this);
        await existing.replay("disconnect");
      } finally {
        this.close();
      }
    });
    return this.disconnecting;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const operation of this.operations) operation.abort();
    void this.connection?.then(
      (connection) => connection.close(),
      () => undefined,
    );
    this.connection = undefined;
    const worker = this.updateChannel;
    this.updateChannel = undefined;
    if (worker) {
      if (this.completions.size === 0) worker.close();
      else void Promise.all([...this.completions]).then(() => worker.close());
    }
  }
}
