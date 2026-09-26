/// <reference types="vite/client" />

import type {
  AuthMethod,
  AuthStartResult,
  IpcResult,
  PublicAccount,
  PublicUsage,
  Settings,
  GlmRegion,
  ProviderId,
} from "./models";

declare global {
  interface Window {
    llmUsage?: {
      listAccounts(): Promise<IpcResult<PublicAccount[]>>;
      getUsage(accountId: string): Promise<IpcResult<PublicUsage | null>>;
      setAccountEnabled(accountId: string, enabled: boolean): Promise<IpcResult<PublicAccount>>;
      deleteAccount(accountId: string): Promise<IpcResult<{ accountId: string }>>;
      refreshAccount(accountId: string): Promise<IpcResult<unknown>>;
      refreshCredentials(accountId: string): Promise<IpcResult<unknown>>;
      startAuth(
        provider: ProviderId,
        method: AuthMethod,
        options?: { region?: GlmRegion; apiKey?: string },
      ): Promise<IpcResult<AuthStartResult>>;
      finishAuth(sessionId: string): Promise<IpcResult<PublicAccount>>;
      cancelAuth(sessionId: string): Promise<IpcResult<{ sessionId: string }>>;
      getSettings(): Promise<IpcResult<Settings>>;
      saveSettings(settings: Settings): Promise<IpcResult<Settings>>;
      getProxy(): Promise<IpcResult<string>>;
    };
  }
}
