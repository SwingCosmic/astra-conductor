import { ipcMain } from "electron";
import {
  AppError,
  toPublicAccount,
  toPublicError,
  toPublicUsage,
  type RefreshCoordinator,
  type StoragePort,
} from "@llm-usage/core/internal";

export const ipcChannels = {
  listAccounts: "accounts:list",
  getUsage: "usage:get",
  setAccountEnabled: "accounts:set-enabled",
  deleteAccount: "accounts:delete",
  refreshAccount: "usage:refresh",
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

function response<T>(operation: () => T | Promise<T>): Promise<IpcSuccess<T> | IpcFailure> {
  return Promise.resolve()
    .then(operation)
    .then((value) => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, error: toPublicError(error) }));
}

export function registerIpcHandlers(
  storage: StoragePort,
  coordinator: RefreshCoordinator,
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
    response(() => coordinator.refresh(accountId(input))),
  );
}

export function unregisterIpcHandlers(): void {
  for (const channel of Object.values(ipcChannels)) ipcMain.removeHandler(channel);
}
