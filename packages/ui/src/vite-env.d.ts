/// <reference types="vite/client" />

import type {
  DeviceAuthorization,
  IpcResult,
  PublicAccount,
  PublicUsage,
  Settings,
} from "./models";

declare global {
  interface Window {
    llmUsage?: {
      listAccounts(): Promise<IpcResult<PublicAccount[]>>;
      getUsage(accountId: string): Promise<IpcResult<PublicUsage | null>>;
      setAccountEnabled(accountId: string, enabled: boolean): Promise<IpcResult<PublicAccount>>;
      deleteAccount(accountId: string): Promise<IpcResult<{ accountId: string }>>;
      refreshAccount(accountId: string): Promise<IpcResult<unknown>>;
      importCodexCli(): Promise<IpcResult<PublicAccount>>;
      loginCodexBrowser(): Promise<IpcResult<PublicAccount>>;
      startCodexDevice(): Promise<IpcResult<DeviceAuthorization>>;
      finishCodexDevice(sessionId: string): Promise<IpcResult<PublicAccount>>;
      getSettings(): Promise<IpcResult<Settings>>;
      saveSettings(settings: Settings): Promise<IpcResult<Settings>>;
      getProxy(): Promise<IpcResult<string>>;
    };
  }
}
