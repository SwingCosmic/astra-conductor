import type { StartAuthRequest } from "../dto/auth.js";
import type { ResetCreditRedemption } from "../dto/usage.js";
import type { CommandContext } from "../service.js";

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

export function fail(path: string): never {
  throw new ContractValidationError(`Invalid contract value at ${path}`);
}

export function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(path);
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") return fail(path);
  return value;
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail(path);
  return value;
}

export function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(path);
  return value;
}

export function exact(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
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

/** Opaque public context tokens are bounded identifiers, never paths or credentials. */
export function parseCommandContext(value: unknown): CommandContext {
  const record = object(value, "commandContext");
  const instanceId = string(record.instanceId, "commandContext.instanceId");
  const contextId = string(record.contextId, "commandContext.contextId");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(instanceId)) fail("commandContext.instanceId");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(contextId)) fail("commandContext.contextId");
  return { instanceId, contextId };
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

export function parseCredentialExportRequest(value: unknown): { vaultDirectory: string } {
  const record = object(value, "credentialExport");
  exact(record, ["vaultDirectory"], "credentialExport");
  const vaultDirectory = string(record.vaultDirectory, "credentialExport.vaultDirectory");
  if (
    !/^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(vaultDirectory) ||
    vaultDirectory.length > 4096 ||
    /[\x00-\x1f]/.test(vaultDirectory)
  )
    return fail("credentialExport.vaultDirectory");
  return { vaultDirectory };
}
