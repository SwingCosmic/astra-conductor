import { COMMON_SCHEMA_VERSION } from "./vocabularies.js";
import type {
  ApiOperation,
  CommandContext,
  EventChannel,
  ProviderChangedEvent,
  ProviderManagementSnapshot,
} from "./service.js";
import type { AuthStartResult, PublicAuthSession, StartAuthRequest } from "./dto/auth.js";
import type { PublicAccount } from "./dto/account.js";
import type { CredentialRefreshOutcomeDto } from "./dto/operations.js";
import type {
  CredentialExportDelivery,
  CredentialImportPreview,
  CredentialManagementStatus,
} from "./dto/credential-sharing.js";
import { ContractValidationError, parseAccountId, parseSessionId } from "./validation/request.js";
import type {
  HostCapabilities,
  NotificationDeliveryStatus,
  NotificationRequest,
} from "./dto/host.js";

export function apiOperation<TInput, TOutput>(
  method: "GET" | "POST",
  path: string | ((input: TInput) => string),
  options: Omit<ApiOperation<TInput, TOutput>, "method" | "path"> = {},
): ApiOperation<TInput, TOutput> {
  return Object.freeze({ method, path: typeof path === "string" ? () => path : path, ...options });
}

type WithContext<T> = T & CommandContext;
type AccountCommand = WithContext<{ accountId: string }>;
type SessionCommand = WithContext<{ sessionId: string }>;
const accountPath = (input: { accountId: string }): string =>
  encodeURIComponent(parseAccountId(input.accountId));
const sessionPath = (input: { sessionId: string }): string =>
  encodeURIComponent(parseSessionId(input.sessionId));
const body = <T>(input: T): T => input;
const contextBody = (input: CommandContext): CommandContext => ({
  instanceId: input.instanceId,
  contextId: input.contextId,
});

export const providerOperations = {
  getSnapshot: apiOperation<void, ProviderManagementSnapshot>("GET", "/api/v1/providers", {
    parseOutput: (value) => {
      if (
        !value ||
        typeof value !== "object" ||
        (value as { schemaVersion?: unknown }).schemaVersion !== COMMON_SCHEMA_VERSION
      )
        throw new ContractValidationError("服务通信协议版本不一致");
      return value as ProviderManagementSnapshot;
    },
  }),
  startAuth: apiOperation<WithContext<StartAuthRequest>, AuthStartResult>(
    "POST",
    "/api/v1/auth/sessions/start",
    { body },
  ),
  getAuthSession: apiOperation<{ sessionId: string }, PublicAuthSession>(
    "GET",
    (input) => `/api/v1/auth/sessions/${sessionPath(input)}`,
  ),
  finishAuth: apiOperation<SessionCommand, PublicAccount>(
    "POST",
    (input) => `/api/v1/auth/sessions/${sessionPath(input)}/finish`,
    { body: contextBody },
  ),
  cancelAuth: apiOperation<SessionCommand, void>(
    "POST",
    (input) => `/api/v1/auth/sessions/${sessionPath(input)}/cancel`,
    { body: contextBody, voidResult: true },
  ),
  setAccountEnabled: apiOperation<WithContext<{ accountId: string; enabled: boolean }>, void>(
    "POST",
    (input) => `/api/v1/accounts/${accountPath(input)}/set-enabled`,
    { body: (input) => ({ ...contextBody(input), enabled: input.enabled }), voidResult: true },
  ),
  deleteAccount: apiOperation<AccountCommand & { expectedRecordRevision: string }, void>(
    "POST",
    (input) => `/api/v1/accounts/${accountPath(input)}/delete`,
    {
      body: (input) => ({
        ...contextBody(input),
        expectedRecordRevision: input.expectedRecordRevision,
      }),
      voidResult: true,
    },
  ),
  refreshCredentials: apiOperation<AccountCommand, CredentialRefreshOutcomeDto>(
    "POST",
    (input) => `/api/v1/accounts/${accountPath(input)}/refresh-credentials`,
    { body: contextBody },
  ),
} as const;

const credentialPath = "/api/v1/credential-sharing";
const credentialVoid = (path: string) =>
  apiOperation<CommandContext, void>("POST", `${credentialPath}/${path}`, {
    body,
    voidResult: true,
  });
export const credentialOperations = {
  getStatus: apiOperation<void, CredentialManagementStatus>("GET", `${credentialPath}/status`),
  selectDirectory: apiOperation<CommandContext, string | null>(
    "POST",
    `${credentialPath}/select-directory`,
    { body, timeoutMs: 300_000 },
  ),
  install: credentialVoid("install"),
  uninstall: credentialVoid("uninstall"),
  exportCredentials: apiOperation<
    WithContext<{ vaultDirectory: string }>,
    CredentialExportDelivery
  >("POST", `${credentialPath}/export`, { body }),
  acknowledgeDelivery: credentialVoid("acknowledge-delivery"),
  cancelExport: credentialVoid("export/cancel"),
  resumeExport: apiOperation<CommandContext, CredentialExportDelivery | null>(
    "POST",
    `${credentialPath}/export/resume`,
    { body },
  ),
  restartExport: apiOperation<WithContext<{ vaultDirectory: string }>, CredentialExportDelivery>(
    "POST",
    `${credentialPath}/export/restart`,
    { body },
  ),
  enableShared: credentialVoid("enable-shared"),
  returnToPrivate: apiOperation<WithContext<{ acceptIndependentRefreshRisk: boolean }>, void>(
    "POST",
    `${credentialPath}/return-to-private`,
    { body, voidResult: true },
  ),
  rejoinShared: apiOperation<WithContext<{ migrationKey: string }>, void>(
    "POST",
    `${credentialPath}/rejoin-shared`,
    { body, voidResult: true },
  ),
  verifyImport: apiOperation<
    WithContext<{ vaultDirectory: string; migrationKey: string }>,
    CredentialImportPreview
  >("POST", `${credentialPath}/import/verify`, { body }),
  confirmImport: apiOperation<WithContext<{ previewId: string }>, void>(
    "POST",
    `${credentialPath}/import/confirm`,
    { body, voidResult: true },
  ),
  cancelPreview: credentialVoid("import/cancel"),
  retry: credentialVoid("retry"),
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function commonEventChannel(
  scope: "providers" | "credentials",
): EventChannel<ProviderChangedEvent> {
  return {
    type: "changed",
    accepts(value) {
      const event = record(value);
      if (!event) return false;
      const stamp = record(event.stamp);
      return (
        stamp?.scope === scope ||
        event.scope === scope ||
        (Array.isArray(event.stamps) &&
          event.stamps.some((value) => record(value)?.scope === scope))
      );
    },
    parse(value, resync) {
      const event = record(value)!;
      const stamp = (record(event.stamp) ??
        (Array.isArray(event.stamps)
          ? event.stamps.map(record).find((item) => item?.scope === scope)
          : null))!;
      return {
        schemaVersion:
          typeof event.schemaVersion === "number" ? event.schemaVersion : COMMON_SCHEMA_VERSION,
        instanceId: String(stamp?.instanceId ?? event.instanceId ?? ""),
        revision: Number(stamp?.revision ?? event.revision ?? 0),
        occurredAt:
          typeof event.occurredAt === "string" ? event.occurredAt : new Date().toISOString(),
        reasons: Array.isArray(event.reasons)
          ? event.reasons.filter((item): item is string => typeof item === "string")
          : [],
        ...(stamp
          ? {
              stamp: {
                instanceId: String(stamp.instanceId),
                scope,
                revision: Number(stamp.revision),
              },
            }
          : {}),
        ...(typeof event.contextId === "string" ? { contextId: event.contextId } : {}),
        ...(resync ? { resync: true } : {}),
      };
    },
  };
}

export const providerEventChannel = commonEventChannel("providers");
export const credentialEventChannel = commonEventChannel("credentials");

export const hostOperations = {
  getCapabilities: apiOperation<void, HostCapabilities>("GET", "/api/v1/host/capabilities"),
  showWindow: apiOperation<void, void>("POST", "/api/v1/host/window/show", { voidResult: true }),
  acknowledge: apiOperation<{ notificationId: string; status: NotificationDeliveryStatus }, void>(
    "POST",
    (input) => `/api/v1/notifications/${encodeURIComponent(input.notificationId)}/acknowledge`,
    { body: (input) => ({ status: input.status }), voidResult: true },
  ),
} as const;

export const notificationEventChannel: EventChannel<NotificationRequest> = {
  type: "notification",
  accepts: (value) => !!record(value) && typeof record(value)?.notificationId === "string",
  parse: (value) => value as NotificationRequest,
};
