import type {
  AuthMethod,
  AuthStartResult,
  GlmRegion,
  IpcResult,
  ProviderId,
  PublicAccount,
  PublicUsage,
  Settings,
} from "../models";

export interface IPolyQuotaService {
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
}

const unavailableError = {
  code: "service-unavailable",
  message: "桌面功能仅在 PolyQuota Electron 应用中可用",
  retryable: false,
} as const;

function unavailable<T>(): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: false, error: unavailableError });
}

export class EmptyPolyQuotaService implements IPolyQuotaService {
  listAccounts(): Promise<IpcResult<PublicAccount[]>> {
    return Promise.resolve({ ok: true, value: [] });
  }

  getUsage(_accountId: string): Promise<IpcResult<PublicUsage | null>> {
    return Promise.resolve({ ok: true, value: null });
  }

  setAccountEnabled(_accountId: string, _enabled: boolean): Promise<IpcResult<PublicAccount>> {
    return unavailable();
  }

  deleteAccount(_accountId: string): Promise<IpcResult<{ accountId: string }>> {
    return unavailable();
  }

  refreshAccount(_accountId: string): Promise<IpcResult<unknown>> {
    return unavailable();
  }

  refreshCredentials(_accountId: string): Promise<IpcResult<unknown>> {
    return unavailable();
  }

  startAuth(
    _provider: ProviderId,
    _method: AuthMethod,
    _options?: { region?: GlmRegion; apiKey?: string },
  ): Promise<IpcResult<AuthStartResult>> {
    return unavailable();
  }

  finishAuth(_sessionId: string): Promise<IpcResult<PublicAccount>> {
    return unavailable();
  }

  cancelAuth(_sessionId: string): Promise<IpcResult<{ sessionId: string }>> {
    return unavailable();
  }

  getSettings(): Promise<IpcResult<Settings>> {
    return Promise.resolve({
      ok: true,
      value: { pollingEnabled: false, pollingIntervalMinutes: 15 },
    });
  }

  saveSettings(_settings: Settings): Promise<IpcResult<Settings>> {
    return unavailable();
  }

  getProxy(): Promise<IpcResult<string>> {
    return Promise.resolve({ ok: true, value: "" });
  }
}

const methodNames = [
  "listAccounts",
  "getUsage",
  "setAccountEnabled",
  "deleteAccount",
  "refreshAccount",
  "refreshCredentials",
  "startAuth",
  "finishAuth",
  "cancelAuth",
  "getSettings",
  "saveSettings",
  "getProxy",
] as const satisfies readonly (keyof IPolyQuotaService)[];

function isPolyQuotaService(value: unknown): value is IPolyQuotaService {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return methodNames.every((name) => typeof candidate[name] === "function");
}

export function resolvePolyQuotaService(candidate: unknown): IPolyQuotaService {
  return isPolyQuotaService(candidate) ? candidate : new EmptyPolyQuotaService();
}
