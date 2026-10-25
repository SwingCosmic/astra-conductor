import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  POLYQUOTA_SCHEMA_VERSION,
  polyQuotaIpcChannels,
  polyQuotaIpcEvents,
  type AuthStartResult,
  type CredentialRefreshOutcomeDto,
  type IPolyQuotaService,
  type PolyQuotaChangedEvent,
  type PolyQuotaSnapshot,
  type PublicAccount,
  type PublicAuthSession,
  type PublicError,
  type PublicSystemStatus,
  type RedeemResetCreditOutcomeDto,
  type RefreshBatchOutcomeDto,
  type RefreshOutcomeDto,
  type ServiceResult,
} from "@astra-conductor/polyquota-contract";

/**
 * 收包零解析（2026-10 校验归属定稿）：同一安装包内的主进程是可信源，响应
 * 方向只做 schemaVersion 比对与传输错误映射，不做逐字段运行期断言；请求
 * 方向由 main 的 ipc.ts 统一校验。传输形态异常一律折算为 transport 失败。
 */

function failure<T>(code: string, message: string): ServiceResult<T> {
  const error: PublicError = { code, message, retryable: false };
  return { ok: false, error };
}

const TRANSPORT_FAILURE_MESSAGE = "无法连接 PolyQuota 主进程";

function asServiceResult<T>(raw: unknown): ServiceResult<T> {
  if (raw && typeof raw === "object" && "ok" in raw) {
    const result = raw as ServiceResult<T>;
    if (result.ok === true || result.ok === false) return result;
  }
  return failure("transport", TRANSPORT_FAILURE_MESSAGE);
}

function schemaMismatch<T>(received: unknown): ServiceResult<T> {
  return failure(
    "contract-mismatch",
    `桌面通信协议版本不一致（期望 ${POLYQUOTA_SCHEMA_VERSION}，收到 ${String(received)}）`,
  );
}

async function invoke<T>(channel: string, input?: unknown): Promise<ServiceResult<T>> {
  let raw: unknown;
  try {
    raw =
      input === undefined
        ? await ipcRenderer.invoke(channel)
        : await ipcRenderer.invoke(channel, input);
  } catch {
    return failure("transport", TRANSPORT_FAILURE_MESSAGE);
  }
  return asServiceResult<T>(raw);
}

function asChangedEvent(payload: unknown): PolyQuotaChangedEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as PolyQuotaChangedEvent;
  return event.schemaVersion === POLYQUOTA_SCHEMA_VERSION ? event : null;
}

const service: IPolyQuotaService = {
  getSnapshot: async () => {
    const result = await invoke<PolyQuotaSnapshot>(polyQuotaIpcChannels.getSnapshot);
    if (!result.ok || result.value?.schemaVersion === POLYQUOTA_SCHEMA_VERSION) return result;
    return schemaMismatch(result.value?.schemaVersion);
  },
  subscribe(listener) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const event = asChangedEvent(payload);
      if (!event) {
        console.warn("Ignored invalid PolyQuota state event");
        return;
      }
      listener(event);
    };
    ipcRenderer.on(polyQuotaIpcEvents.stateChanged, handler);
    return () => ipcRenderer.removeListener(polyQuotaIpcEvents.stateChanged, handler);
  },
  setAccountEnabled(accountId, enabled) {
    return invoke<void>(polyQuotaIpcChannels.setAccountEnabled, { accountId, enabled });
  },
  deleteAccount: (accountId) => invoke<void>(polyQuotaIpcChannels.deleteAccount, accountId),
  refreshAccount: (accountId) =>
    invoke<RefreshOutcomeDto>(polyQuotaIpcChannels.refreshAccount, accountId),
  refreshAll: () => invoke<RefreshBatchOutcomeDto>(polyQuotaIpcChannels.refreshAll),
  refreshCredentials: (accountId) =>
    invoke<CredentialRefreshOutcomeDto>(polyQuotaIpcChannels.refreshCredentials, accountId),
  redeemResetCredit(accountId, redemption) {
    return invoke<RedeemResetCreditOutcomeDto>(polyQuotaIpcChannels.redeemResetCredit, {
      accountId,
      redemption,
    });
  },
  startAuth: (request) => invoke<AuthStartResult>(polyQuotaIpcChannels.startAuth, request),
  getAuthSession: (sessionId) =>
    invoke<PublicAuthSession>(polyQuotaIpcChannels.getAuthSession, sessionId),
  finishAuth: (sessionId) => invoke<PublicAccount>(polyQuotaIpcChannels.finishAuth, sessionId),
  cancelAuth: (sessionId) => invoke<void>(polyQuotaIpcChannels.cancelAuth, sessionId),
  saveSettings: (settings) => invoke<void>(polyQuotaIpcChannels.saveSettings, settings),
  getSystemStatus: () => invoke<PublicSystemStatus>(polyQuotaIpcChannels.getSystemStatus),
};

/** 暴露给 renderer 的桥接服务（导出仅供测试引用，安装即注册一次）。 */
export const polyQuotaElectronService: IPolyQuotaService = service;

contextBridge.exposeInMainWorld("polyQuotaElectronService", service);
