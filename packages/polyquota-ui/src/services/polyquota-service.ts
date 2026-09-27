import {
  POLYQUOTA_SCHEMA_VERSION,
  type IPolyQuotaService,
  type PolyQuotaSnapshot,
  type PublicRefreshSchedulerState,
  type ServiceResult,
} from "@astra-conductor/polyquota-contract";

export type { IPolyQuotaService } from "@astra-conductor/polyquota-contract";

const unavailableError = {
  code: "service-unavailable",
  message: "桌面功能仅在 PolyQuota Electron 应用中可用",
  retryable: false,
} as const;

function unavailable<T>(): Promise<ServiceResult<T>> {
  return Promise.resolve({ ok: false, error: unavailableError });
}

const emptyScheduler: PublicRefreshSchedulerState = {
  status: "disabled",
  intervalMinutes: 15,
  nextRunAt: null,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  lastResult: null,
};

function emptySnapshot(): PolyQuotaSnapshot {
  return {
    schemaVersion: POLYQUOTA_SCHEMA_VERSION,
    revision: 0,
    generatedAt: new Date(0).toISOString(),
    accounts: [],
    usageByAccountId: {},
    operations: [],
    settings: { pollingEnabled: false, pollingIntervalMinutes: 15 },
    scheduler: emptyScheduler,
  };
}

export class EmptyPolyQuotaService implements IPolyQuotaService {
  getSnapshot(): Promise<ServiceResult<PolyQuotaSnapshot>> {
    return Promise.resolve({ ok: true, value: emptySnapshot() });
  }

  subscribe(_listener: Parameters<IPolyQuotaService["subscribe"]>[0]): () => void {
    return () => undefined;
  }

  setAccountEnabled(): Promise<ServiceResult<void>> {
    return unavailable();
  }

  deleteAccount(): Promise<ServiceResult<void>> {
    return unavailable();
  }

  refreshAccount(): ReturnType<IPolyQuotaService["refreshAccount"]> {
    return unavailable();
  }

  refreshAll(): ReturnType<IPolyQuotaService["refreshAll"]> {
    return unavailable();
  }

  refreshCredentials(): ReturnType<IPolyQuotaService["refreshCredentials"]> {
    return unavailable();
  }

  startAuth(): ReturnType<IPolyQuotaService["startAuth"]> {
    return unavailable();
  }

  finishAuth(): ReturnType<IPolyQuotaService["finishAuth"]> {
    return unavailable();
  }

  cancelAuth(): Promise<ServiceResult<void>> {
    return unavailable();
  }

  saveSettings(): Promise<ServiceResult<void>> {
    return unavailable();
  }

  getSystemStatus(): ReturnType<IPolyQuotaService["getSystemStatus"]> {
    return Promise.resolve({ ok: true, value: { proxy: "" } });
  }
}

const methodNames = [
  "getSnapshot",
  "subscribe",
  "setAccountEnabled",
  "deleteAccount",
  "refreshAccount",
  "refreshAll",
  "refreshCredentials",
  "startAuth",
  "finishAuth",
  "cancelAuth",
  "saveSettings",
  "getSystemStatus",
] as const satisfies readonly (keyof IPolyQuotaService)[];

function isPolyQuotaService(value: unknown): value is IPolyQuotaService {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return methodNames.every((name) => typeof candidate[name] === "function");
}

export function resolvePolyQuotaService(candidate: unknown): IPolyQuotaService {
  return isPolyQuotaService(candidate) ? candidate : new EmptyPolyQuotaService();
}
