export const POLYQUOTA_SCHEMA_VERSION = 2 as const;

export const providerIds = ["codex", "glm", "grok-build", "antigravity"] as const;
export type ProviderId = (typeof providerIds)[number];
export const glmRegions = ["china", "international"] as const;
export type GlmRegion = (typeof glmRegions)[number];
export const authMethods = ["browser-oauth", "device-code", "cli-import", "api-key"] as const;
export type AuthMethod = (typeof authMethods)[number];
export type CredentialState = "available" | "locked" | "missing";
export type JsonPrimitive = string | number | boolean | null;
export type PublicMetadata = Record<string, JsonPrimitive>;

export interface PublicAccount {
  id: string;
  provider: ProviderId;
  authMethod: AuthMethod;
  displayName: string;
  maskedIdentifier: string;
  enabled: boolean;
  credentialState: CredentialState;
  tokenExpiresAt: string | null;
  publicMetadata: PublicMetadata;
  createdAt: string;
  updatedAt: string;
}

export type PublicAuthInteraction =
  | "browser-callback"
  | "device-code"
  | "local-import"
  | "secret-form";

export interface PublicAuthMethodDescriptor {
  method: AuthMethod;
  interaction: PublicAuthInteraction;
  sourceLabel?: string;
}

export interface PublicOfferingDescriptor {
  id: string;
  provider: ProviderId;
  displayName: string;
  description?: string;
  websiteUrl?: string;
  region?: GlmRegion;
  authMethods: PublicAuthMethodDescriptor[];
}

export interface PublicProviderDescriptor {
  provider: ProviderId;
  displayName: string;
  offerings: PublicOfferingDescriptor[];
}

export interface UsageQuota {
  key: string;
  displayName: string | null;
  windowSeconds: number | null;
  used: number;
  total: number;
  remaining: number | null;
  remainingPercentage: number | null;
  resetAt: string | null;
  unlimited: boolean;
}

export interface UsageQuotaGroup {
  key: string;
  displayName: string | null;
  quotas: UsageQuota[];
}

export interface UsageExtraItem {
  key: string;
  kind: string;
  expiresAt: string | null;
  actionToken?: string;
}

export interface UsageExtra {
  key: string;
  value: string;
  items?: UsageExtraItem[];
}

export interface PublicUsage {
  accountId: string;
  plan: string;
  overallRemainingPercentage: number | null;
  groups: UsageQuotaGroup[];
  extras: UsageExtra[];
  fetchedAt: string;
}

export interface PublicError {
  code: string;
  message: string;
  retryable: boolean;
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: PublicError };
export type IpcResult<T> = ServiceResult<T>;

export interface Settings {
  pollingEnabled: boolean;
  pollingIntervalMinutes: number;
}

export type StartAuthRequest =
  | { provider: "codex"; method: "browser-oauth" | "device-code" | "cli-import" }
  | { provider: "glm"; method: "cli-import"; region: GlmRegion }
  | { provider: "glm"; method: "api-key"; region: GlmRegion; apiKey: string }
  | { provider: "grok-build"; method: "browser-oauth" | "device-code" | "cli-import" }
  | { provider: "antigravity"; method: "browser-oauth" };

export type AuthStartResult =
  | { status: "completed"; account: PublicAccount }
  | { status: "pending"; sessionId: string; interaction: "browser-callback" }
  | {
      status: "pending";
      sessionId: string;
      interaction: "device-code";
      userCode: string;
      verificationUri: string;
    };

export type RefreshOutcomeDto =
  | { status: "updated"; accountId: string; snapshot: PublicUsage }
  | { status: "skipped"; accountId: string }
  | { status: "failed"; accountId: string; error: PublicError };

export interface RefreshBatchOutcomeDto {
  source: "manual" | "tray" | "automatic";
  outcomes: RefreshOutcomeDto[];
}

export type CredentialRefreshOutcomeDto =
  | { status: "updated" | "unchanged"; accountId: string; tokenExpiresAt: string | null }
  | { status: "failed"; accountId: string; error: PublicError };

export interface RedeemResetCreditRequest {
  accountId: string;
  selectionToken: string;
}

export interface RedeemResetCreditOutcomeDto {
  status: "redeemed";
  accountId: string;
  refreshStatus: RefreshOutcomeDto["status"];
  remainingResetCredits: number | null;
}

export type PublicOperationKind =
  | "refresh-account"
  | "refresh-all"
  | "refresh-credentials"
  | "use-reset-credit"
  | "auth";

export interface PublicOperationState {
  id: string;
  kind: PublicOperationKind;
  status: "running" | "waiting-for-user";
  accountId: string | null;
  source: "manual" | "tray" | "automatic" | null;
  startedAt: string;
}

export interface PublicRefreshBatchSummary {
  source: "manual" | "tray" | "automatic";
  succeeded: number;
  skipped: number;
  failed: number;
  error: PublicError | null;
}

export interface PublicRefreshSchedulerState {
  status: "disabled" | "waiting" | "running" | "stopped";
  intervalMinutes: number;
  nextRunAt: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastResult: PublicRefreshBatchSummary | null;
}

export interface PublicSystemStatus {
  proxy: string;
}

export interface PolyQuotaSnapshot {
  schemaVersion: typeof POLYQUOTA_SCHEMA_VERSION;
  revision: number;
  generatedAt: string;
  providers: PublicProviderDescriptor[];
  accounts: PublicAccount[];
  usageByAccountId: Record<string, PublicUsage | null>;
  operations: PublicOperationState[];
  settings: Settings;
  scheduler: PublicRefreshSchedulerState;
}

export const polyQuotaChangeReasons = [
  "accounts",
  "usage",
  "settings",
  "operations",
  "scheduler",
] as const;
export type PolyQuotaChangeReason = (typeof polyQuotaChangeReasons)[number];

export interface PolyQuotaChangedEvent {
  schemaVersion: typeof POLYQUOTA_SCHEMA_VERSION;
  revision: number;
  reasons: PolyQuotaChangeReason[];
  occurredAt: string;
}

export interface IPolyQuotaService {
  getSnapshot(): Promise<ServiceResult<PolyQuotaSnapshot>>;
  subscribe(listener: (event: PolyQuotaChangedEvent) => void): () => void;
  setAccountEnabled(accountId: string, enabled: boolean): Promise<ServiceResult<void>>;
  deleteAccount(accountId: string): Promise<ServiceResult<void>>;
  refreshAccount(accountId: string): Promise<ServiceResult<RefreshOutcomeDto>>;
  refreshAll(): Promise<ServiceResult<RefreshBatchOutcomeDto>>;
  refreshCredentials(accountId: string): Promise<ServiceResult<CredentialRefreshOutcomeDto>>;
  redeemResetCredit(
    accountId: string,
    selectionToken: string,
  ): Promise<ServiceResult<RedeemResetCreditOutcomeDto>>;
  startAuth(request: StartAuthRequest): Promise<ServiceResult<AuthStartResult>>;
  finishAuth(sessionId: string): Promise<ServiceResult<PublicAccount>>;
  cancelAuth(sessionId: string): Promise<ServiceResult<void>>;
  saveSettings(settings: Settings): Promise<ServiceResult<void>>;
  getSystemStatus(): Promise<ServiceResult<PublicSystemStatus>>;
}

export const polyQuotaIpcChannels = {
  getSnapshot: "polyquota:snapshot:get",
  setAccountEnabled: "polyquota:account:set-enabled",
  deleteAccount: "polyquota:account:delete",
  refreshAccount: "polyquota:refresh:account",
  refreshAll: "polyquota:refresh:all",
  refreshCredentials: "polyquota:credentials:refresh",
  redeemResetCredit: "polyquota:reset-credit:redeem",
  startAuth: "polyquota:auth:start",
  finishAuth: "polyquota:auth:finish",
  cancelAuth: "polyquota:auth:cancel",
  saveSettings: "polyquota:settings:save",
  getSystemStatus: "polyquota:system:status",
} as const;

export const polyQuotaIpcEvents = {
  stateChanged: "polyquota:state:changed",
} as const;

export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

type Parser<T> = (value: unknown) => T;

function fail(path: string): never {
  throw new ContractValidationError(`Invalid PolyQuota contract value at ${path}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(path);
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") return fail(path);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail(path);
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(path);
  return value;
}

function nonnegativeInteger(value: unknown, path: string): number {
  const result = number(value, path);
  if (!Number.isSafeInteger(result) || result < 0) return fail(path);
  return result;
}

function nullable<T>(value: unknown, path: string, parser: Parser<T>): T | null {
  return value === null ? null : parser(value);
}

function array<T>(value: unknown, path: string, parser: Parser<T>): T[] {
  if (!Array.isArray(value)) return fail(path);
  return value.map((item, index) => parserAt(parser, item, `${path}[${index}]`));
}

function parserAt<T>(parser: Parser<T>, value: unknown, path: string): T {
  try {
    return parser(value);
  } catch (error) {
    if (error instanceof ContractValidationError) throw error;
    return fail(path);
  }
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) return fail(path);
  return value as T[number];
}

function exact(record: Record<string, unknown>, keys: readonly string[], path: string): void {
  if (Object.keys(record).some((key) => !keys.includes(key))) fail(path);
}

function isoDate(value: unknown, path: string): string {
  const result = string(value, path);
  if (!Number.isFinite(Date.parse(result))) return fail(path);
  return result;
}

function nullableString(value: unknown, path: string): string | null {
  return nullable(value, path, (item) => string(item, path));
}

export function parseAccountId(value: unknown): string {
  const result = string(value, "accountId");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(result)) return fail("accountId");
  return result;
}

export function parseSessionId(value: unknown): string {
  const result = string(value, "sessionId");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(result)) return fail("sessionId");
  return result;
}

export function parseSettings(value: unknown): Settings {
  const record = object(value, "settings");
  exact(record, ["pollingEnabled", "pollingIntervalMinutes"], "settings");
  const pollingIntervalMinutes = number(
    record.pollingIntervalMinutes,
    "settings.pollingIntervalMinutes",
  );
  if (
    !Number.isInteger(pollingIntervalMinutes) ||
    pollingIntervalMinutes < 5 ||
    pollingIntervalMinutes > 1440
  ) {
    return fail("settings.pollingIntervalMinutes");
  }
  return {
    pollingEnabled: boolean(record.pollingEnabled, "settings.pollingEnabled"),
    pollingIntervalMinutes,
  };
}

export function parseStartAuthRequest(value: unknown): StartAuthRequest {
  const record = object(value, "authRequest");
  const provider = oneOf(record.provider, providerIds, "authRequest.provider");
  const method = oneOf(record.method, authMethods, "authRequest.method");
  if (provider === "codex" || provider === "grok-build") {
    exact(record, ["provider", "method"], "authRequest");
    if (method !== "browser-oauth" && method !== "device-code" && method !== "cli-import") {
      return fail("authRequest.method");
    }
    return { provider, method };
  }
  if (provider === "antigravity") {
    exact(record, ["provider", "method"], "authRequest");
    if (method !== "browser-oauth") return fail("authRequest.method");
    return { provider, method };
  }
  const region = oneOf(record.region, glmRegions, "authRequest.region");
  if (method === "cli-import") {
    exact(record, ["provider", "method", "region"], "authRequest");
    return { provider, method, region };
  }
  if (method !== "api-key") return fail("authRequest.method");
  exact(record, ["provider", "method", "region", "apiKey"], "authRequest");
  const apiKey = string(record.apiKey, "authRequest.apiKey");
  if (!apiKey.trim() || apiKey.length > 4096) return fail("authRequest.apiKey");
  return { provider, method, region, apiKey };
}

export function parseSetAccountEnabledRequest(value: unknown): {
  accountId: string;
  enabled: boolean;
} {
  const record = object(value, "setAccountEnabled");
  exact(record, ["accountId", "enabled"], "setAccountEnabled");
  return {
    accountId: parseAccountId(record.accountId),
    enabled: boolean(record.enabled, "setAccountEnabled.enabled"),
  };
}

export function parseRedeemResetCreditRequest(value: unknown): RedeemResetCreditRequest {
  const record = object(value, "redeemResetCredit");
  exact(record, ["accountId", "selectionToken"], "redeemResetCredit");
  const selectionToken = string(record.selectionToken, "redeemResetCredit.selectionToken").trim();
  if (!selectionToken || selectionToken.length > 256) {
    return fail("redeemResetCredit.selectionToken");
  }
  return {
    accountId: parseAccountId(record.accountId),
    selectionToken,
  };
}

export function parsePublicError(value: unknown): PublicError {
  const record = object(value, "error");
  return {
    code: string(record.code, "error.code"),
    message: string(record.message, "error.message"),
    retryable: boolean(record.retryable, "error.retryable"),
  };
}

export function parseServiceResult<T>(value: unknown, parseValue: Parser<T>): ServiceResult<T> {
  const record = object(value, "result");
  if (record.ok === true) return { ok: true, value: parseValue(record.value) };
  if (record.ok === false) return { ok: false, error: parsePublicError(record.error) };
  return fail("result.ok");
}

export function parseVoid(value: unknown): void {
  if (value !== undefined) fail("void");
}

function parseMetadata(value: unknown): PublicMetadata {
  const record = object(value, "publicMetadata");
  for (const item of Object.values(record)) {
    if (item !== null && !["string", "number", "boolean"].includes(typeof item)) {
      fail("publicMetadata");
    }
  }
  return record as PublicMetadata;
}

function parseAuthMethodDescriptor(value: unknown): PublicAuthMethodDescriptor {
  const record = object(value, "authMethod");
  const interaction = oneOf(
    record.interaction,
    ["browser-callback", "device-code", "local-import", "secret-form"] as const,
    "authMethod.interaction",
  );
  return {
    method: oneOf(record.method, authMethods, "authMethod.method"),
    interaction,
    ...(record.sourceLabel === undefined
      ? {}
      : { sourceLabel: string(record.sourceLabel, "authMethod.sourceLabel") }),
  };
}

function parseOfferingDescriptor(value: unknown): PublicOfferingDescriptor {
  const record = object(value, "offering");
  return {
    id: string(record.id, "offering.id"),
    provider: oneOf(record.provider, providerIds, "offering.provider"),
    displayName: string(record.displayName, "offering.displayName"),
    ...(record.description === undefined
      ? {}
      : { description: string(record.description, "offering.description") }),
    ...(record.websiteUrl === undefined
      ? {}
      : { websiteUrl: string(record.websiteUrl, "offering.websiteUrl") }),
    ...(record.region === undefined
      ? {}
      : { region: oneOf(record.region, glmRegions, "offering.region") }),
    authMethods: array(record.authMethods, "offering.authMethods", parseAuthMethodDescriptor),
  };
}

export function parseProviderDescriptor(value: unknown): PublicProviderDescriptor {
  const record = object(value, "providerDescriptor");
  const descriptor: PublicProviderDescriptor = {
    provider: oneOf(record.provider, providerIds, "providerDescriptor.provider"),
    displayName: string(record.displayName, "providerDescriptor.displayName"),
    offerings: array(record.offerings, "providerDescriptor.offerings", parseOfferingDescriptor),
  };
  const seenOfferings = new Set<string>();
  for (const offering of descriptor.offerings) {
    if (offering.provider !== descriptor.provider) {
      fail("providerDescriptor.offerings.provider");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(offering.id)) fail("offering.id");
    if (seenOfferings.has(offering.id)) fail("offering.id");
    seenOfferings.add(offering.id);
    const seenMethods = new Set<string>();
    for (const method of offering.authMethods) {
      if (seenMethods.has(method.method)) fail("authMethod.method");
      seenMethods.add(method.method);
    }
  }
  return descriptor;
}

export function parsePublicAccount(value: unknown): PublicAccount {
  const record = object(value, "account");
  return {
    id: parseAccountId(record.id),
    provider: oneOf(record.provider, providerIds, "account.provider"),
    authMethod: oneOf(record.authMethod, authMethods, "account.authMethod"),
    displayName: string(record.displayName, "account.displayName"),
    maskedIdentifier: string(record.maskedIdentifier, "account.maskedIdentifier"),
    enabled: boolean(record.enabled, "account.enabled"),
    credentialState: oneOf(
      record.credentialState,
      ["available", "locked", "missing"] as const,
      "account.credentialState",
    ),
    tokenExpiresAt: nullableString(record.tokenExpiresAt, "account.tokenExpiresAt"),
    publicMetadata: parseMetadata(record.publicMetadata),
    createdAt: isoDate(record.createdAt, "account.createdAt"),
    updatedAt: isoDate(record.updatedAt, "account.updatedAt"),
  };
}

function parseUsageQuota(value: unknown): UsageQuota {
  const record = object(value, "quota");
  return {
    key: string(record.key, "quota.key"),
    displayName: nullableString(record.displayName, "quota.displayName"),
    windowSeconds: nullable(record.windowSeconds, "quota.windowSeconds", (item) =>
      number(item, "quota.windowSeconds"),
    ),
    used: number(record.used, "quota.used"),
    total: number(record.total, "quota.total"),
    remaining: nullable(record.remaining, "quota.remaining", (item) =>
      number(item, "quota.remaining"),
    ),
    remainingPercentage: nullable(record.remainingPercentage, "quota.remainingPercentage", (item) =>
      number(item, "quota.remainingPercentage"),
    ),
    resetAt: nullableString(record.resetAt, "quota.resetAt"),
    unlimited: boolean(record.unlimited, "quota.unlimited"),
  };
}

function parseUsageExtraItem(value: unknown): UsageExtraItem {
  const record = object(value, "extraItem");
  return {
    key: string(record.key, "extraItem.key"),
    kind: string(record.kind, "extraItem.kind"),
    expiresAt: nullableString(record.expiresAt, "extraItem.expiresAt"),
    ...(record.actionToken === undefined
      ? {}
      : { actionToken: string(record.actionToken, "extraItem.actionToken") }),
  };
}

function parseUsageExtra(value: unknown): UsageExtra {
  const record = object(value, "extra");
  return {
    key: string(record.key, "extra.key"),
    value: string(record.value, "extra.value"),
    ...(record.items === undefined
      ? {}
      : { items: array(record.items, "extra.items", parseUsageExtraItem) }),
  };
}

export function parsePublicUsage(value: unknown): PublicUsage {
  const record = object(value, "usage");
  return {
    accountId: parseAccountId(record.accountId),
    plan: string(record.plan, "usage.plan"),
    overallRemainingPercentage: nullable(
      record.overallRemainingPercentage,
      "usage.overallRemainingPercentage",
      (item) => number(item, "usage.overallRemainingPercentage"),
    ),
    groups: array(record.groups, "usage.groups", (item) => {
      const group = object(item, "usage.group");
      return {
        key: string(group.key, "usage.group.key"),
        displayName: nullableString(group.displayName, "usage.group.displayName"),
        quotas: array(group.quotas, "usage.group.quotas", parseUsageQuota),
      };
    }),
    extras: array(record.extras, "usage.extras", parseUsageExtra),
    fetchedAt: isoDate(record.fetchedAt, "usage.fetchedAt"),
  };
}

export function parseRefreshOutcome(value: unknown): RefreshOutcomeDto {
  const record = object(value, "refreshOutcome");
  const status = oneOf(
    record.status,
    ["updated", "skipped", "failed"] as const,
    "refreshOutcome.status",
  );
  const accountId = parseAccountId(record.accountId);
  if (status === "updated") {
    return { status, accountId, snapshot: parsePublicUsage(record.snapshot) };
  }
  if (status === "failed") return { status, accountId, error: parsePublicError(record.error) };
  return { status, accountId };
}

export function parseRefreshBatchOutcome(value: unknown): RefreshBatchOutcomeDto {
  const record = object(value, "refreshBatch");
  return {
    source: oneOf(record.source, ["manual", "tray", "automatic"] as const, "refreshBatch.source"),
    outcomes: array(record.outcomes, "refreshBatch.outcomes", parseRefreshOutcome),
  };
}

export function parseCredentialRefreshOutcome(value: unknown): CredentialRefreshOutcomeDto {
  const record = object(value, "credentialRefresh");
  const status = oneOf(
    record.status,
    ["updated", "unchanged", "failed"] as const,
    "credentialRefresh.status",
  );
  const accountId = parseAccountId(record.accountId);
  return status === "failed"
    ? { status, accountId, error: parsePublicError(record.error) }
    : {
        status,
        accountId,
        tokenExpiresAt: nullableString(record.tokenExpiresAt, "credentialRefresh.tokenExpiresAt"),
      };
}

export function parseRedeemResetCreditOutcome(value: unknown): RedeemResetCreditOutcomeDto {
  const record = object(value, "redeemResetCreditOutcome");
  return {
    status: oneOf(record.status, ["redeemed"] as const, "redeemResetCreditOutcome.status"),
    accountId: parseAccountId(record.accountId),
    refreshStatus: oneOf(
      record.refreshStatus,
      ["updated", "skipped", "failed"] as const,
      "redeemResetCreditOutcome.refreshStatus",
    ),
    remainingResetCredits: nullable(
      record.remainingResetCredits,
      "redeemResetCreditOutcome.remainingResetCredits",
      (item) => nonnegativeInteger(item, "redeemResetCreditOutcome.remainingResetCredits"),
    ),
  };
}

export function parseAuthStartResult(value: unknown): AuthStartResult {
  const record = object(value, "authStart");
  const status = oneOf(record.status, ["completed", "pending"] as const, "authStart.status");
  if (status === "completed") return { status, account: parsePublicAccount(record.account) };
  const sessionId = parseSessionId(record.sessionId);
  const interaction = oneOf(
    record.interaction,
    ["browser-callback", "device-code"] as const,
    "authStart.interaction",
  );
  return interaction === "browser-callback"
    ? { status, sessionId, interaction }
    : {
        status,
        sessionId,
        interaction,
        userCode: string(record.userCode, "authStart.userCode"),
        verificationUri: string(record.verificationUri, "authStart.verificationUri"),
      };
}

function parseOperation(value: unknown): PublicOperationState {
  const record = object(value, "operation");
  return {
    id: string(record.id, "operation.id"),
    kind: oneOf(
      record.kind,
      [
        "refresh-account",
        "refresh-all",
        "refresh-credentials",
        "use-reset-credit",
        "auth",
      ] as const,
      "operation.kind",
    ),
    status: oneOf(record.status, ["running", "waiting-for-user"] as const, "operation.status"),
    accountId: nullableString(record.accountId, "operation.accountId"),
    source: nullable(record.source, "operation.source", (item) =>
      oneOf(item, ["manual", "tray", "automatic"] as const, "operation.source"),
    ),
    startedAt: isoDate(record.startedAt, "operation.startedAt"),
  };
}

export function parseSchedulerState(value: unknown): PublicRefreshSchedulerState {
  const record = object(value, "scheduler");
  const result =
    record.lastResult === null ? null : object(record.lastResult, "scheduler.lastResult");
  return {
    status: oneOf(
      record.status,
      ["disabled", "waiting", "running", "stopped"] as const,
      "scheduler.status",
    ),
    intervalMinutes: number(record.intervalMinutes, "scheduler.intervalMinutes"),
    nextRunAt: nullableString(record.nextRunAt, "scheduler.nextRunAt"),
    lastRunStartedAt: nullableString(record.lastRunStartedAt, "scheduler.lastRunStartedAt"),
    lastRunFinishedAt: nullableString(record.lastRunFinishedAt, "scheduler.lastRunFinishedAt"),
    lastResult: result
      ? {
          source: oneOf(
            result.source,
            ["manual", "tray", "automatic"] as const,
            "scheduler.lastResult.source",
          ),
          succeeded: number(result.succeeded, "scheduler.lastResult.succeeded"),
          skipped: number(result.skipped, "scheduler.lastResult.skipped"),
          failed: number(result.failed, "scheduler.lastResult.failed"),
          error: result.error === null ? null : parsePublicError(result.error),
        }
      : null,
  };
}

export function parseSnapshot(value: unknown): PolyQuotaSnapshot {
  const record = object(value, "snapshot");
  if (record.schemaVersion !== POLYQUOTA_SCHEMA_VERSION) return fail("snapshot.schemaVersion");
  const accounts = array(record.accounts, "snapshot.accounts", parsePublicAccount);
  const usageRecord = object(record.usageByAccountId, "snapshot.usageByAccountId");
  const usageByAccountId = Object.fromEntries(
    Object.entries(usageRecord).map(([key, item]) => [
      parseAccountId(key),
      item === null ? null : parsePublicUsage(item),
    ]),
  );
  const accountIds = new Set(accounts.map((account) => account.id));
  if (
    Object.keys(usageByAccountId).length !== accountIds.size ||
    Object.entries(usageByAccountId).some(
      ([accountId, usage]) =>
        !accountIds.has(accountId) || (usage !== null && usage.accountId !== accountId),
    )
  ) {
    return fail("snapshot.usageByAccountId");
  }
  const providers = array(record.providers, "snapshot.providers", parseProviderDescriptor);
  const seenProviders = new Set<string>();
  for (const descriptor of providers) {
    if (seenProviders.has(descriptor.provider)) fail("snapshot.providers");
    seenProviders.add(descriptor.provider);
  }
  return {
    schemaVersion: POLYQUOTA_SCHEMA_VERSION,
    revision: nonnegativeInteger(record.revision, "snapshot.revision"),
    generatedAt: isoDate(record.generatedAt, "snapshot.generatedAt"),
    providers,
    accounts,
    usageByAccountId,
    operations: array(record.operations, "snapshot.operations", parseOperation),
    settings: parseSettings(record.settings),
    scheduler: parseSchedulerState(record.scheduler),
  };
}

export function parseSystemStatus(value: unknown): PublicSystemStatus {
  const record = object(value, "systemStatus");
  return { proxy: string(record.proxy, "systemStatus.proxy") };
}

export function parseChangedEvent(value: unknown): PolyQuotaChangedEvent {
  const record = object(value, "changedEvent");
  if (record.schemaVersion !== POLYQUOTA_SCHEMA_VERSION) return fail("changedEvent.schemaVersion");
  return {
    schemaVersion: POLYQUOTA_SCHEMA_VERSION,
    revision: nonnegativeInteger(record.revision, "changedEvent.revision"),
    reasons: array(record.reasons, "changedEvent.reasons", (item) =>
      oneOf(item, polyQuotaChangeReasons, "changedEvent.reason"),
    ),
    occurredAt: isoDate(record.occurredAt, "changedEvent.occurredAt"),
  };
}
