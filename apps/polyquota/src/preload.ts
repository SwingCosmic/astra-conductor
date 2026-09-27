import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  ContractValidationError,
  parseAuthStartResult,
  parseChangedEvent,
  parseCredentialRefreshOutcome,
  parsePublicAccount,
  parseRefreshBatchOutcome,
  parseRefreshOutcome,
  parseServiceResult,
  parseSnapshot,
  parseSystemStatus,
  parseVoid,
  polyQuotaIpcChannels,
  polyQuotaIpcEvents,
  type IPolyQuotaService,
  type PublicError,
  type ServiceResult,
} from "@astra-conductor/polyquota-contract";

type Parser<T> = (value: unknown) => T;

function failure<T>(code: string, message: string): ServiceResult<T> {
  const error: PublicError = { code, message, retryable: false };
  return { ok: false, error };
}

async function invoke<T>(
  channel: string,
  parser: Parser<T>,
  input?: unknown,
): Promise<ServiceResult<T>> {
  try {
    const raw =
      input === undefined
        ? await ipcRenderer.invoke(channel)
        : await ipcRenderer.invoke(channel, input);
    return parseServiceResult(raw, parser);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      return failure("contract-mismatch", "桌面通信契约不一致，请完整重启 PolyQuota");
    }
    return failure("transport", "无法连接 PolyQuota 主进程");
  }
}

const service: IPolyQuotaService = {
  getSnapshot: () => invoke(polyQuotaIpcChannels.getSnapshot, parseSnapshot),
  subscribe(listener) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      try {
        listener(parseChangedEvent(payload));
      } catch (error) {
        console.warn(
          "Ignored invalid PolyQuota state event",
          error instanceof ContractValidationError ? "contract-mismatch" : "unknown",
        );
      }
    };
    ipcRenderer.on(polyQuotaIpcEvents.stateChanged, handler);
    return () => ipcRenderer.removeListener(polyQuotaIpcEvents.stateChanged, handler);
  },
  setAccountEnabled(accountId, enabled) {
    return invoke(polyQuotaIpcChannels.setAccountEnabled, parseVoid, { accountId, enabled });
  },
  deleteAccount: (accountId) => invoke(polyQuotaIpcChannels.deleteAccount, parseVoid, accountId),
  refreshAccount: (accountId) =>
    invoke(polyQuotaIpcChannels.refreshAccount, parseRefreshOutcome, accountId),
  refreshAll: () => invoke(polyQuotaIpcChannels.refreshAll, parseRefreshBatchOutcome),
  refreshCredentials: (accountId) =>
    invoke(polyQuotaIpcChannels.refreshCredentials, parseCredentialRefreshOutcome, accountId),
  startAuth: (request) => invoke(polyQuotaIpcChannels.startAuth, parseAuthStartResult, request),
  finishAuth: (sessionId) => invoke(polyQuotaIpcChannels.finishAuth, parsePublicAccount, sessionId),
  cancelAuth: (sessionId) => invoke(polyQuotaIpcChannels.cancelAuth, parseVoid, sessionId),
  saveSettings: (settings) => invoke(polyQuotaIpcChannels.saveSettings, parseVoid, settings),
  getSystemStatus: () => invoke(polyQuotaIpcChannels.getSystemStatus, parseSystemStatus),
};

contextBridge.exposeInMainWorld("polyQuotaElectronService", service);
