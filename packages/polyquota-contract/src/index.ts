export const POLYQUOTA_SCHEMA_VERSION = 4 as const;

export const providerIds = [
  "codex",
  "glm",
  "grok-build",
  "antigravity",
  "claude",
  "opencode-go",
] as const;
export type ProviderId = (typeof providerIds)[number];
export const authMethods = ["browser-oauth", "device-code", "cli-import", "api-key"] as const;
export type AuthMethod = (typeof authMethods)[number];
export type CredentialState = "available" | "locked" | "missing";
export type JsonPrimitive = string | number | boolean | null;
export type PublicMetadata = Record<string, JsonPrimitive>;

export interface PublicAccount {
  id: string;
  provider: ProviderId;
  offeringId: string;
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
  sourcePathHint?: string;
}

export interface PublicPlanDescriptor {
  id: string;
  displayName: string;
  match: readonly string[];
}

export interface PublicOfferingDescriptor {
  id: string;
  provider: ProviderId;
  displayName: string;
  description?: string;
  websiteUrl?: string;
  iconKey?: string;
  authMethods: PublicAuthMethodDescriptor[];
  plans: readonly PublicPlanDescriptor[];
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
}

export interface UsageExtra {
  key: string;
  value: string;
  items?: UsageExtraItem[];
}

export interface ResetCreditItem {
  /** 上游不透明标识，只回传给所属 provider 的兑换协议。 */
  id: string;
  /** 如 "five-hour"、"weekly"、"banked"。 */
  type: string;
  expiresAt: string | null;
}

/**
 * 重置额度的一等结构（获得侧，随 `fetchUsage` 返回）：
 * - aggregate：上游只提供计数时按类型分桶，不区分窗口的供应商声明单桶；
 * - itemized：每张重置卡有完整类型、过期时间与 id。
 */
export type ResetCredits =
  | {
      kind: "aggregate";
      totals: readonly { type: string; total: number }[];
    }
  | {
      kind: "itemized";
      items: readonly ResetCreditItem[];
    };

/** 重置额度消耗请求：聚合按类型（单桶可省略 type），分体带对应重置卡 id。 */
export type ResetCreditRedemption =
  | { kind: "aggregate"; type?: string }
  | { kind: "item"; itemId: string };

export interface PublicUsage {
  accountId: string;
  plan: string;
  overallRemainingPercentage: number | null;
  groups: UsageQuotaGroup[];
  extras: UsageExtra[];
  resetCredits: ResetCredits | null;
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
  taskbarProgressEnabled: boolean;
}

export const remainingStatuses = ["empty", "complete", "incomplete"] as const;
export type RemainingStatus = (typeof remainingStatuses)[number];
export const remainingBands = ["healthy", "attention", "critical", "unknown"] as const;
export type RemainingBand = (typeof remainingBands)[number];

export interface PublicCompositeRemaining {
  status: RemainingStatus;
  sessionScore: number | null;
  weeklyScore: number | null;
  remaining: number | null;
  band: RemainingBand;
  sessionBand: RemainingBand;
  weeklyBand: RemainingBand;
  enabledAccountCount: number;
  scoredAccountCount: number;
}

export function emptyCompositeRemaining(): PublicCompositeRemaining {
  return {
    status: "empty",
    sessionScore: null,
    weeklyScore: null,
    remaining: null,
    band: "unknown",
    sessionBand: "unknown",
    weeklyBand: "unknown",
    enabledAccountCount: 0,
    scoredAccountCount: 0,
  };
}

/**
 * 认证请求以接入点为稳定入口：`offeringId` 从注册表交叉验证并决定 provider、
 * 端点与实现；`method` 必须是该接入点声明的认证方式。secret-form 输入统一走
 * 可选 `apiKey`，供应商实现在运行时再次校验，不信任 renderer 生成的表单。
 */
export interface StartAuthRequest {
  offeringId: string;
  method: AuthMethod;
  apiKey?: string;
}

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
  redemption: ResetCreditRedemption;
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

export const polyQuotaProxyModes = ["direct", "system", "environment", "unknown"] as const;

export interface PublicSystemStatus {
  proxyMode: (typeof polyQuotaProxyModes)[number];
  proxyAddress: string | null;
}

export interface PolyQuotaSnapshot {
  schemaVersion: typeof POLYQUOTA_SCHEMA_VERSION;
  revision: number;
  generatedAt: string;
  providers: PublicProviderDescriptor[];
  accounts: PublicAccount[];
  usageByAccountId: Record<string, PublicUsage | null>;
  compositeRemaining: PublicCompositeRemaining;
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
    redemption: ResetCreditRedemption,
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
    taskbarProgressEnabled:
      record.taskbarProgressEnabled === undefined
        ? true
        : boolean(record.taskbarProgressEnabled, "settings.taskbarProgressEnabled"),
  };
}

const offeringIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseStartAuthRequest(value: unknown): StartAuthRequest {
  const record = object(value, "authRequest");
  exact(record, ["offeringId", "method", "apiKey"], "authRequest");
  const offeringId = string(record.offeringId, "authRequest.offeringId");
  if (!offeringIdPattern.test(offeringId)) return fail("authRequest.offeringId");
  const request: StartAuthRequest = {
    offeringId,
    method: oneOf(record.method, authMethods, "authRequest.method"),
  };
  if (record.apiKey !== undefined) {
    const apiKey = string(record.apiKey, "authRequest.apiKey");
    if (!apiKey.trim() || apiKey.length > 4096) return fail("authRequest.apiKey");
    request.apiKey = apiKey;
  }
  return request;
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

export function parseResetCreditRedemption(value: unknown): ResetCreditRedemption {
  const record = object(value, "redemption");
  if (record.kind === "aggregate") {
    exact(record, ["kind", "type"], "redemption");
    const redemption: ResetCreditRedemption = { kind: "aggregate" };
    if (record.type !== undefined) {
      const type = string(record.type, "redemption.type");
      if (!type.trim() || type.length > 64) return fail("redemption.type");
      redemption.type = type;
    }
    return redemption;
  }
  if (record.kind === "item") {
    exact(record, ["kind", "itemId"], "redemption");
    const itemId = string(record.itemId, "redemption.itemId").trim();
    if (!itemId || itemId.length > 256) return fail("redemption.itemId");
    return { kind: "item", itemId };
  }
  return fail("redemption.kind");
}

export function parseRedeemResetCreditRequest(value: unknown): RedeemResetCreditRequest {
  const record = object(value, "redeemResetCredit");
  exact(record, ["accountId", "redemption"], "redeemResetCredit");
  return {
    accountId: parseAccountId(record.accountId),
    redemption: parseResetCreditRedemption(record.redemption),
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
    ...(record.sourcePathHint === undefined
      ? {}
      : { sourcePathHint: string(record.sourcePathHint, "authMethod.sourcePathHint") }),
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
    ...(record.iconKey === undefined
      ? {}
      : { iconKey: string(record.iconKey, "offering.iconKey") }),
    authMethods: array(record.authMethods, "offering.authMethods", parseAuthMethodDescriptor),
    plans: array(record.plans, "offering.plans", parsePlanDescriptor),
  };
}

function parsePlanDescriptor(value: unknown): PublicPlanDescriptor {
  const record = object(value, "plan");
  const plan: PublicPlanDescriptor = {
    id: string(record.id, "plan.id"),
    displayName: string(record.displayName, "plan.displayName"),
    match: array(record.match, "plan.match", (item) => string(item, "plan.match")),
  };
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.id)) fail("plan.id");
  if (!plan.displayName.trim()) fail("plan.displayName");
  if (!plan.match.length) fail("plan.match");
  return plan;
}

export function normalizePlanMatch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

export function matchPublicPlan(
  plans: readonly PublicPlanDescriptor[] | null | undefined,
  plan: string | null | undefined,
): PublicPlanDescriptor | null {
  if (typeof plan !== "string" || !plans?.length) return null;
  const key = normalizePlanMatch(plan);
  if (!key) return null;
  return (
    plans.find((item) => item.match.some((candidate) => normalizePlanMatch(candidate) === key)) ??
    null
  );
}

export function publicPlanDisplayName(
  plans: readonly PublicPlanDescriptor[] | null | undefined,
  plan: string | null | undefined,
): string {
  const value = typeof plan === "string" ? plan.trim() : "";
  if (!value) return "未提供";
  return matchPublicPlan(plans, value)?.displayName ?? value;
}

export function parseProviderDescriptor(value: unknown): PublicProviderDescriptor {
  const record = object(value, "providerDescriptor");
  exact(record, ["provider", "displayName", "offerings"], "providerDescriptor");
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
    const seenPlanIds = new Set<string>();
    const seenPlanMatches = new Set<string>();
    for (const plan of offering.plans) {
      if (seenPlanIds.has(plan.id)) fail("plan.id");
      seenPlanIds.add(plan.id);
      for (const raw of plan.match) {
        const key = normalizePlanMatch(raw);
        if (!key) fail("plan.match");
        if (seenPlanMatches.has(key)) fail("plan.match");
        seenPlanMatches.add(key);
      }
    }
  }
  return descriptor;
}

export function parsePublicAccount(value: unknown): PublicAccount {
  const record = object(value, "account");
  const offeringId = string(record.offeringId, "account.offeringId");
  if (!offeringIdPattern.test(offeringId)) fail("account.offeringId");
  return {
    id: parseAccountId(record.id),
    provider: oneOf(record.provider, providerIds, "account.provider"),
    offeringId,
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
    unlimited:
      record.unlimited === undefined ? false : boolean(record.unlimited, "quota.unlimited"),
  };
}

function parseUsageExtraItem(value: unknown): UsageExtraItem {
  const record = object(value, "extraItem");
  return {
    key: string(record.key, "extraItem.key"),
    kind: string(record.kind, "extraItem.kind"),
    expiresAt: nullableString(record.expiresAt, "extraItem.expiresAt"),
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

function parseResetCreditItem(value: unknown): ResetCreditItem {
  const record = object(value, "resetCreditItem");
  const id = string(record.id, "resetCreditItem.id");
  if (!id || id.length > 256) fail("resetCreditItem.id");
  return {
    id,
    type: string(record.type, "resetCreditItem.type"),
    expiresAt: nullableString(record.expiresAt, "resetCreditItem.expiresAt"),
  };
}

function parseResetCredits(value: unknown): ResetCredits {
  const record = object(value, "resetCredits");
  if (record.kind === "aggregate") {
    exact(record, ["kind", "totals"], "resetCredits");
    const totals = array(record.totals, "resetCredits.totals", (item) => {
      const entry = object(item, "resetCredits.total");
      exact(entry, ["type", "total"], "resetCredits.total");
      return {
        type: string(entry.type, "resetCredits.total.type"),
        total: nonnegativeInteger(entry.total, "resetCredits.total.total"),
      };
    });
    if (!totals.length) fail("resetCredits.totals");
    const seenTypes = new Set<string>();
    for (const total of totals) {
      if (seenTypes.has(total.type)) fail("resetCredits.total.type");
      seenTypes.add(total.type);
    }
    return { kind: "aggregate", totals };
  }
  if (record.kind === "itemized") {
    exact(record, ["kind", "items"], "resetCredits");
    const items = array(record.items, "resetCredits.items", parseResetCreditItem);
    const seenIds = new Set<string>();
    for (const item of items) {
      if (seenIds.has(item.id)) fail("resetCredits.items.id");
      seenIds.add(item.id);
    }
    return { kind: "itemized", items };
  }
  return fail("resetCredits.kind");
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
    resetCredits:
      record.resetCredits === undefined || record.resetCredits === null
        ? null
        : parseResetCredits(record.resetCredits),
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
    compositeRemaining:
      record.compositeRemaining === undefined
        ? emptyCompositeRemaining()
        : parseCompositeRemaining(record.compositeRemaining),
    operations: array(record.operations, "snapshot.operations", parseOperation),
    settings: parseSettings(record.settings),
    scheduler: parseSchedulerState(record.scheduler),
  };
}

function parseRemainingScore(value: unknown, path: string): number | null {
  if (value === null) return null;
  const result = number(value, path);
  return Math.min(100, Math.max(0, result));
}

export function parseCompositeRemaining(value: unknown): PublicCompositeRemaining {
  const record = object(value, "compositeRemaining");
  const enabledAccountCount = nonnegativeInteger(
    record.enabledAccountCount,
    "compositeRemaining.enabledAccountCount",
  );
  const scoredAccountCount = nonnegativeInteger(
    record.scoredAccountCount,
    "compositeRemaining.scoredAccountCount",
  );
  if (scoredAccountCount > enabledAccountCount)
    return fail("compositeRemaining.scoredAccountCount");
  return {
    status: oneOf(record.status, remainingStatuses, "compositeRemaining.status"),
    sessionScore: parseRemainingScore(record.sessionScore, "compositeRemaining.sessionScore"),
    weeklyScore: parseRemainingScore(record.weeklyScore, "compositeRemaining.weeklyScore"),
    remaining: parseRemainingScore(record.remaining, "compositeRemaining.remaining"),
    band: oneOf(record.band, remainingBands, "compositeRemaining.band"),
    sessionBand: oneOf(record.sessionBand, remainingBands, "compositeRemaining.sessionBand"),
    weeklyBand: oneOf(record.weeklyBand, remainingBands, "compositeRemaining.weeklyBand"),
    enabledAccountCount,
    scoredAccountCount,
  };
}

export function parseSystemStatus(value: unknown): PublicSystemStatus {
  const record = object(value, "systemStatus");
  return {
    proxyMode: oneOf(record.proxyMode, polyQuotaProxyModes, "systemStatus.proxyMode"),
    proxyAddress: nullableString(record.proxyAddress, "systemStatus.proxyAddress"),
  };
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
