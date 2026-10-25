import {
  POLYQUOTA_SCHEMA_VERSION,
  type IPolyQuotaService,
  type IHostService,
  type INotificationService,
  type AuthStartResult,
  type PublicAuthSession,
  type PublicAccount,
  type PublicSystemStatus,
  type PolyQuotaSnapshot,
  type PolyQuotaChangedEvent,
  type ServiceResult,
  type Settings,
  type RefreshOutcomeDto,
  type RefreshBatchOutcomeDto,
  type CredentialRefreshOutcomeDto,
  type RedeemResetCreditOutcomeDto,
  type ResetCreditRedemption,
  type StartAuthRequest,
  type HostCapabilities,
  type NotificationRequest,
  type NotificationDeliveryStatus,
} from "@astra-conductor/polyquota-contract";
import { readEventStream } from "./event-stream";

function failure<T>(code: string, message: string): ServiceResult<T> {
  return { ok: false, error: { code, message, retryable: code === "transport" } };
}

export class HttpPolyQuotaService implements IPolyQuotaService, IHostService, INotificationService {
  private readonly listeners = new Set<(event: PolyQuotaChangedEvent) => void>();
  private readonly notificationListeners = new Set<(request: NotificationRequest) => void>();
  private readonly readyListeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private ready = false;
  private mismatch = false;

  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  private async request<T>(path: string, body?: unknown, post = false): Promise<ServiceResult<T>> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method: post ? "POST" : "GET",
        cache: "no-store",
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = (await response.json()) as ServiceResult<T>;
      if (!result || (result.ok !== true && result.ok !== false))
        return failure("transport", "服务响应无效");
      if (result.ok && (!response.ok || !("value" in result)))
        return failure("transport", "服务响应无效");
      return result.ok && result.value === null ? { ok: true, value: undefined as T } : result;
    } catch {
      return failure("transport", "无法连接 PolyQuota 服务");
    }
  }

  async getSnapshot(): Promise<ServiceResult<PolyQuotaSnapshot>> {
    const result = await this.request<PolyQuotaSnapshot>("/v1/polyquota/snapshot");
    return result.ok && result.value?.schemaVersion !== POLYQUOTA_SCHEMA_VERSION
      ? failure("contract-mismatch", "服务通信协议版本不一致")
      : result;
  }
  setAccountEnabled(id: string, enabled: boolean) {
    return this.request<void>(
      `/v1/polyquota/accounts/${encodeURIComponent(id)}/set-enabled`,
      { enabled },
      true,
    );
  }
  deleteAccount(id: string) {
    return this.request<void>(
      `/v1/polyquota/accounts/${encodeURIComponent(id)}/delete`,
      undefined,
      true,
    );
  }
  refreshAccount(id: string) {
    return this.request<RefreshOutcomeDto>(
      `/v1/polyquota/accounts/${encodeURIComponent(id)}/refresh`,
      undefined,
      true,
    );
  }
  refreshAll() {
    return this.request<RefreshBatchOutcomeDto>(
      "/v1/polyquota/accounts/refresh-all",
      undefined,
      true,
    );
  }
  refreshCredentials(accountId: string) {
    return this.request<CredentialRefreshOutcomeDto>(
      "/v1/polyquota/credentials/refresh",
      { accountId },
      true,
    );
  }
  redeemResetCredit(accountId: string, redemption: ResetCreditRedemption) {
    return this.request<RedeemResetCreditOutcomeDto>(
      "/v1/polyquota/reset-credits/redeem",
      { accountId, redemption },
      true,
    );
  }
  startAuth(request: StartAuthRequest) {
    return this.request<AuthStartResult>("/v1/polyquota/auth/sessions/start", request, true);
  }
  finishAuth(id: string) {
    return this.request<PublicAccount>(
      `/v1/polyquota/auth/sessions/${encodeURIComponent(id)}/finish`,
      undefined,
      true,
    );
  }
  cancelAuth(id: string) {
    return this.request<void>(
      `/v1/polyquota/auth/sessions/${encodeURIComponent(id)}/cancel`,
      undefined,
      true,
    );
  }
  getAuthSession(id: string) {
    return this.request<PublicAuthSession>(`/v1/polyquota/auth/sessions/${encodeURIComponent(id)}`);
  }
  saveSettings(settings: Settings) {
    return this.request<void>("/v1/polyquota/settings/save", settings, true);
  }
  getSystemStatus() {
    return this.request<PublicSystemStatus>("/v1/polyquota/system-status");
  }
  getCapabilities() {
    return this.request<HostCapabilities>("/v1/host/capabilities");
  }
  showWindow() {
    return this.request<void>("/v1/host/window/show", undefined, true);
  }
  acknowledge(id: string, status: NotificationDeliveryStatus) {
    return this.request<void>(
      `/v1/notifications/${encodeURIComponent(id)}/acknowledge`,
      { status },
      true,
    );
  }

  subscribe(listener: (event: PolyQuotaChangedEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.controller) {
      this.controller = new AbortController();
      void this.connect(this.controller.signal);
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.controller?.abort();
        this.controller = null;
        this.ready = false;
      }
    };
  }

  subscribeNotifications(listener: (request: NotificationRequest) => void): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  waitForEvents(timeoutMs = 5_000): Promise<void> {
    if (this.mismatch) return Promise.reject(new Error("服务通信协议版本不一致"));
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ready = (): void => {
        clearTimeout(timeout);
        this.readyListeners.delete(ready);
        this.mismatch ? reject(new Error("服务通信协议版本不一致")) : resolve();
      };
      const timeout = setTimeout(() => {
        this.readyListeners.delete(ready);
        reject(new Error("事件流尚未就绪，请检查后端连接"));
      }, timeoutMs);
      this.readyListeners.add(ready);
    });
  }

  private async connect(signal: AbortSignal): Promise<void> {
    let attempts = 0;
    while (!signal.aborted && !this.mismatch) {
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl.replace(/\/$/, "")}/v1/polyquota/events`,
          { signal, cache: "no-store" },
        );
        await readEventStream(
          response,
          ({ type, data }) => {
            if (signal.aborted) return;
            const parsed = JSON.parse(data) as PolyQuotaChangedEvent & NotificationRequest;
            if (type === "ready" || type === "changed") {
              if (parsed.schemaVersion !== POLYQUOTA_SCHEMA_VERSION) {
                this.mismatch = true;
                for (const resolve of this.readyListeners) resolve();
                throw new Error("服务通信协议版本不一致");
              }
              if (type === "ready") {
                this.ready = true;
                attempts = 0;
                for (const resolve of [...this.readyListeners]) resolve();
              }
              const event: PolyQuotaChangedEvent = {
                ...parsed,
                ...(type === "ready" ? { resync: true } : {}),
                reasons: parsed.reasons ?? [],
                occurredAt: parsed.occurredAt ?? new Date().toISOString(),
              };
              for (const listener of this.listeners) listener(event);
            }
            if (type === "notification")
              for (const listener of this.notificationListeners) listener(parsed);
          },
          signal,
        );
      } catch {
        /* retry reads only; POST operations are never replayed */
      }
      if (signal.aborted) return;
      this.ready = false;
      if (this.mismatch) return;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(
          done,
          Math.min(30_000, 1_000 * 2 ** Math.min(attempts++, 5)) * (0.8 + Math.random() * 0.4),
        );
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}
