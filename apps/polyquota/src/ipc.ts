import { ipcMain } from "electron";
import {
  ContractValidationError,
  parseAccountId,
  parseSessionId,
  parseSetAccountEnabledRequest,
  parseSettings,
  parseStartAuthRequest,
  polyQuotaIpcChannels,
  type PublicError,
  type ServiceResult,
} from "@astra-conductor/polyquota-contract";
import { toPublicError } from "@astra-conductor/core/internal";
import type { PolyQuotaApplicationService } from "./polyquota-application-service.js";

const pendingResponses = new Set<Promise<unknown>>();

function publicError(error: unknown): PublicError {
  if (error instanceof ContractValidationError) {
    return { code: "validation", message: "请求参数无效", retryable: false };
  }
  const converted = toPublicError(error);
  return converted.code === "upstream" && converted.message === "Unexpected operation failure"
    ? { code: "internal", message: "操作未能完成", retryable: false }
    : converted;
}

function response<T>(operation: () => T | Promise<T>): Promise<ServiceResult<T>> {
  const pending = Promise.resolve()
    .then(operation)
    .then((value) => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, error: publicError(error) }));
  pendingResponses.add(pending);
  void pending.finally(() => pendingResponses.delete(pending));
  return pending;
}

export function registerIpcHandlers(service: PolyQuotaApplicationService): void {
  ipcMain.handle(polyQuotaIpcChannels.getSnapshot, () => response(() => service.getSnapshot()));
  ipcMain.handle(polyQuotaIpcChannels.setAccountEnabled, (_event, input: unknown) =>
    response(() => {
      const request = parseSetAccountEnabledRequest(input);
      service.setAccountEnabled(request.accountId, request.enabled);
    }),
  );
  ipcMain.handle(polyQuotaIpcChannels.deleteAccount, (_event, input: unknown) =>
    response(() => service.deleteAccount(parseAccountId(input))),
  );
  ipcMain.handle(polyQuotaIpcChannels.refreshAccount, (_event, input: unknown) =>
    response(() => service.refreshAccount(parseAccountId(input))),
  );
  ipcMain.handle(polyQuotaIpcChannels.refreshAll, () =>
    response(() => service.refreshAll("manual")),
  );
  ipcMain.handle(polyQuotaIpcChannels.refreshCredentials, (_event, input: unknown) =>
    response(() => service.refreshCredentials(parseAccountId(input))),
  );
  ipcMain.handle(polyQuotaIpcChannels.startAuth, (_event, input: unknown) =>
    response(() => service.startAuth(parseStartAuthRequest(input))),
  );
  ipcMain.handle(polyQuotaIpcChannels.finishAuth, (_event, input: unknown) =>
    response(() => service.finishAuth(parseSessionId(input))),
  );
  ipcMain.handle(polyQuotaIpcChannels.cancelAuth, (_event, input: unknown) =>
    response(() => service.cancelAuth(parseSessionId(input))),
  );
  ipcMain.handle(polyQuotaIpcChannels.saveSettings, (_event, input: unknown) =>
    response(() => service.saveSettings(parseSettings(input))),
  );
  ipcMain.handle(polyQuotaIpcChannels.getSystemStatus, () =>
    response(() => service.getSystemStatus()),
  );
}

export function unregisterIpcHandlers(): void {
  for (const channel of Object.values(polyQuotaIpcChannels)) ipcMain.removeHandler(channel);
}

export async function waitForIpcHandlersToDrain(): Promise<void> {
  while (pendingResponses.size) {
    await Promise.allSettled([...pendingResponses]);
  }
}
