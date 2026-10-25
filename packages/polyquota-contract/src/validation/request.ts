import type { StartAuthRequest } from "../dto/auth.js";
import type { Settings } from "../dto/settings.js";
import type { RedeemResetCreditRequest } from "../dto/operations.js";
import type { ResetCreditRedemption } from "../dto/usage.js";

export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

/**
 * 请求侧（renderer → main）运行期校验：渲染进程输入是唯一值得防的输入，
 * 校验集中在这里。响应方向零解析——客户端只做 schemaVersion 比对与传输
 */

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

function exact(record: Record<string, unknown>, keys: readonly string[], path: string): void {
  if (Object.keys(record).some((key) => !keys.includes(key))) fail(path);
}

const slugPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

export function parseStartAuthRequest(value: unknown): StartAuthRequest {
  const record = object(value, "authRequest");
  exact(record, ["offeringId", "method", "apiKey"], "authRequest");
  const offeringId = string(record.offeringId, "authRequest.offeringId");
  if (!slugPattern.test(offeringId)) return fail("authRequest.offeringId");
  const method = string(record.method, "authRequest.method");
  if (!slugPattern.test(method)) return fail("authRequest.method");
  const request: StartAuthRequest = { offeringId, method };
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
