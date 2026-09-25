import { ipcMain } from "electron";
import {
  AppError,
  toPublicAccount,
  toPublicError,
  toPublicUsage,
  type StoragePort,
  authMethods,
  providerIds,
  type AuthMethod,
  type ProviderId,
} from "@llm-usage/core/internal";
import type { CodexAuthService } from "./auth-service.js";
import type { PollingService } from "./polling-service.js";

export const ipcChannels = {
  listAccounts: "accounts:list",
  getUsage: "usage:get",
  setAccountEnabled: "accounts:set-enabled",
  deleteAccount: "accounts:delete",
  refreshAccount: "usage:refresh",
  startAuth: "auth:start",
  finishAuth: "auth:finish",
  cancelAuth: "auth:cancel",
  getSettings: "settings:get",
  saveSettings: "settings:save",
  getProxy: "system:proxy",
} as const;

interface IpcSuccess<T> {
  ok: true;
  value: T;
}

interface IpcFailure {
  ok: false;
  error: ReturnType<typeof toPublicError>;
}

function accountId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new AppError("validation", "Invalid account identifier");
  }
  return value;
}

function authStartInput(value: unknown): { provider: ProviderId; method: AuthMethod } {
  if (!value || typeof value !== "object") {
    throw new AppError("validation", "Invalid authorization request");
  }
  const input = value as { provider?: unknown; method?: unknown };
  if (!providerIds.includes(input.provider as ProviderId)) {
    throw new AppError("validation", "Invalid provider identifier");
  }
  if (!authMethods.includes(input.method as AuthMethod)) {
    throw new AppError("validation", "Invalid authorization method");
  }
  return { provider: input.provider as ProviderId, method: input.method as AuthMethod };
}

function response<T>(operation: () => T | Promise<T>): Promise<IpcSuccess<T> | IpcFailure> {
  return Promise.resolve()
    .then(operation)
    .then((value) => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, error: toPublicError(error) }));
}

export function registerIpcHandlers(
  storage: StoragePort,
  polling: PollingService,
  auth: CodexAuthService,
  resolveProxy: () => Promise<string>,
  now: () => Date = () => new Date(),
): void {
  ipcMain.handle(ipcChannels.listAccounts, () =>
    response(() => storage.accounts.list().map(toPublicAccount)),
  );
  ipcMain.handle(ipcChannels.getUsage, (_event, input: unknown) =>
    response(() => {
      const id = accountId(input);
      if (!storage.accounts.get(id)) throw new AppError("validation", "Account does not exist");
      const snapshot = storage.snapshots.get(id);
      return snapshot ? toPublicUsage(snapshot) : null;
    }),
  );
  ipcMain.handle(ipcChannels.setAccountEnabled, (_event, input: unknown) =>
    response(() => {
      if (!input || typeof input !== "object") {
        throw new AppError("validation", "Invalid account update");
      }
      const value = input as { accountId?: unknown; enabled?: unknown };
      const id = accountId(value.accountId);
      if (typeof value.enabled !== "boolean") {
        throw new AppError("validation", "Invalid enabled state");
      }
      storage.accounts.setEnabled(id, value.enabled, now().toISOString());
      return toPublicAccount(storage.accounts.get(id)!);
    }),
  );
  ipcMain.handle(ipcChannels.deleteAccount, (_event, input: unknown) =>
    response(() => {
      const id = accountId(input);
      if (!storage.accounts.get(id)) throw new AppError("validation", "Account does not exist");
      storage.transaction(() => storage.accounts.delete(id));
      return { accountId: id };
    }),
  );
  ipcMain.handle(ipcChannels.refreshAccount, (_event, input: unknown) =>
    response(() => polling.refresh(accountId(input))),
  );
  ipcMain.handle(ipcChannels.startAuth, (_event, input: unknown) =>
    response(async () => {
      const request = authStartInput(input);
      const result = await auth.start(request.provider, request.method);
      return result.status === "completed"
        ? { ...result, account: toPublicAccount(result.account) }
        : result;
    }),
  );
  ipcMain.handle(ipcChannels.finishAuth, (_event, input: unknown) =>
    response(async () => toPublicAccount(await auth.finish(accountId(input)))),
  );
  ipcMain.handle(ipcChannels.cancelAuth, (_event, input: unknown) =>
    response(() => {
      const sessionId = accountId(input);
      auth.cancel(sessionId);
      return { sessionId };
    }),
  );
  ipcMain.handle(ipcChannels.getSettings, () =>
    response(() => ({
      pollingEnabled: storage.settings.get("pollingEnabled") !== false,
      pollingIntervalMinutes: storage.settings.get("pollingIntervalMinutes") ?? 15,
    })),
  );
  ipcMain.handle(ipcChannels.saveSettings, (_event, input: unknown) =>
    response(() => {
      if (!input || typeof input !== "object") throw new AppError("validation", "Invalid settings");
      const value = input as { pollingEnabled?: unknown; pollingIntervalMinutes?: unknown };
      if (typeof value.pollingEnabled !== "boolean") {
        throw new AppError("validation", "Invalid polling setting");
      }
      if (
        typeof value.pollingIntervalMinutes !== "number" ||
        !Number.isInteger(value.pollingIntervalMinutes) ||
        value.pollingIntervalMinutes < 5 ||
        value.pollingIntervalMinutes > 1440
      ) {
        throw new AppError("validation", "Polling interval must be between 5 and 1440 minutes");
      }
      const pollingEnabled = value.pollingEnabled;
      const pollingIntervalMinutes = value.pollingIntervalMinutes;
      const timestamp = now().toISOString();
      storage.transaction(() => {
        storage.settings.save("pollingEnabled", pollingEnabled, timestamp);
        storage.settings.save("pollingIntervalMinutes", pollingIntervalMinutes, timestamp);
      });
      return {
        pollingEnabled,
        pollingIntervalMinutes,
      };
    }),
  );
  ipcMain.handle(ipcChannels.getProxy, () => response(resolveProxy));
}

export function unregisterIpcHandlers(): void {
  for (const channel of Object.values(ipcChannels)) ipcMain.removeHandler(channel);
}
