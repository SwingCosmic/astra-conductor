import {
  parseModelExtensionBody,
  parseModelRequestRule,
  type ModelRequestRule,
} from "./model-request-rule.js";
export type { ModelRequestRule } from "./model-request-rule.js";
import type { CommandContext } from "../service.js";
import { exact, fail, object } from "../validation/request.js";

import {
  protocolFamilyDescriptors,
  modelEndpointDescriptor,
  endpointProtocols,
  resolveEndpointProtocol,
  type EndpointProtocol,
  type ProtocolFamily,
} from "./model-endpoint.js";
export * from "./model-endpoint.js";
export interface DefaultProtocolRoute {
  readonly protocol: EndpointProtocol;
  readonly baseUrl: string;
  readonly protocolVersion?: string | null;
}
export interface OfferingRouteConfig {
  readonly mode: "fixed" | "editable";
  readonly allowedProtocols: readonly EndpointProtocol[];
  readonly defaults: readonly DefaultProtocolRoute[];
  readonly groupByFamily?: boolean;
}
export interface ModelRouteInput {
  requestRule?: ModelRequestRule;
  chatOutputLimitField?: "max_tokens" | "max_completion_tokens";
  protocol: EndpointProtocol;
  baseUrl: string;
  protocolVersion?: string | null;
}
export interface ProtocolFamilyPolicy {
  catalog?: "none";
  authentication?: "bearer" | "x-api-key" | "x-goog-api-key";
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: ModelRequestRule["body"];
}
const protoKeys = new Set(["__proto__", "prototype", "constructor"]);
const forbiddenHeaders = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "proxy-authorization",
  "host",
  "cookie",
  "set-cookie",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-connection",
]);
const reservedQueryParams = new Set([
  "limit",
  "after",
  "before",
  "before_id",
  "after_id",
  "client_version",
]);
export function parseFamilyPolicy(value: unknown): ProtocolFamilyPolicy {
  const row = object(value, "familyPolicy");
  exact(row, ["authentication", "headers", "query", "catalog", "body"], "familyPolicy");
  const authentication = row.authentication as ProtocolFamilyPolicy["authentication"];
  if (
    authentication !== undefined &&
    !["bearer", "x-api-key", "x-goog-api-key"].includes(authentication)
  )
    return fail("familyPolicy.authentication");
  const result: ProtocolFamilyPolicy = authentication ? { authentication } : {};
  if (row.catalog !== undefined && row.catalog !== "none") return fail("familyPolicy.catalog");
  if (row.catalog === "none") result.catalog = "none";
  if (row.body !== undefined) {
    const body = parseModelExtensionBody(row.body);
    if (Object.keys(body).length) result.body = body;
  }
  for (const field of ["headers", "query"] as const) {
    if (row[field] === undefined) continue;
    const entries = Object.entries(object(row[field], "familyPolicy." + field));
    if (entries.length > 24) return fail("familyPolicy." + field);
    const names = new Set<string>();
    const pairs = entries.map(([name, value]) => {
      const lower = name.toLowerCase();
      if (
        !/^[a-z][a-z0-9._-]{0,63}$/i.test(name) ||
        names.has(lower) ||
        protoKeys.has(lower) ||
        (field === "headers" &&
          (forbiddenHeaders.has(lower) ||
            lower === "x-graphagent" ||
            lower.startsWith("x-graphagent-"))) ||
        (field === "query" && reservedQueryParams.has(lower)) ||
        typeof value !== "string" ||
        value.length > 512 ||
        /[^\x20-\x7e]/.test(value) ||
        /(?:^Bearer\s|(?:sk-|nap_)[a-z0-9_-]{8,})/i.test(value)
      )
        return fail("familyPolicy." + field);
      names.add(lower);
      return [field === "headers" ? lower : name, value] as const;
    });
    if (pairs.length)
      result[field] = Object.fromEntries(pairs.sort(([a], [b]) => a.localeCompare(b)));
  }
  return result;
}
export interface ModelRoute extends ModelRouteInput {
  protocolVersion: string | null;
  bindingRevision: string;
  protocolFamily?: ProtocolFamily;
  familyBindingRevision?: string;
  familyPolicy?: ProtocolFamilyPolicy;
  familyCatalog?: "native" | "vendor" | "none";
}
export type ModelRouteSummary = Pick<
  ModelRoute,
  "protocol" | "bindingRevision" | "protocolFamily" | "familyBindingRevision" | "familyCatalog"
>;
export interface CreateConnectionRequest {
  providerId?: string;
  offeringId?: string;
  displayName: string;
  operationId: string;
  accountIdentifier?: string;
  apiKey: string;
  routes: ModelRouteInput[];
}
export interface EditConnectionRequest {
  providerId?: string;
  offeringId?: string;
  displayName: string;
  expectedRecordRevision: string;
  apiKey?: string;
  routes: ModelRouteInput[];
}
export interface PublicConnection extends CommandContext {
  accountId: string;
  providerId: string;
  offeringId: string;
  displayName: string;
  recordRevision: string;
  routes: ModelRoute[];
}

export function parseHttpBaseUrl(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    /[\s\\?#\x00-\x1f]/.test(value) ||
    !/^https?:\/\//i.test(value)
  )
    return fail(field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(field);
  }
  if (url.username || url.password || value.split("://")[1]?.split("/")[0]?.includes("@"))
    return fail(field);
  return url.href.replace(/\/+$/, "");
}

export function parseModelRouteInput(value: unknown): ModelRouteInput {
  const r = object(value, "routes");
  exact(
    r,
    [
      "protocol",
      "protocolFamily",
      "baseUrl",
      "protocolVersion",
      "requestRule",
      "chatOutputLimitField",
    ],
    "routes",
  );
  const protocol = resolveEndpointProtocol(r.protocol, r.protocolFamily);
  if (
    r.requestRule !== undefined &&
    !["openai-chat", "openai-responses", "anthropic-messages"].includes(protocol)
  )
    return fail("requestRule");
  if (
    r.chatOutputLimitField !== undefined &&
    (protocol !== "openai-chat" ||
      !["max_tokens", "max_completion_tokens"].includes(String(r.chatOutputLimitField)))
  )
    return fail("chatOutputLimitField");
  const baseUrl = parseHttpBaseUrl(r.baseUrl, "routes.baseUrl");
  const version = r.protocolVersion;
  if (version != null && (typeof version !== "string" || !/^[\w.-]{1,64}$/.test(version)))
    return fail("routes.protocolVersion");
  const versions = protocol.startsWith("gemini-")
    ? ["v1beta", "v1"]
    : protocol === "cohere-rerank"
      ? ["v2"]
      : ["v1"];
  if (protocol !== "anthropic-messages" && version != null && !versions.includes(version as string))
    return fail("routes.protocolVersion");
  return {
    protocol,
    baseUrl,
    ...(r.requestRule !== undefined && {
      requestRule: parseModelRequestRule(
        r.requestRule,
        (headers) => parseFamilyPolicy({ headers }).headers ?? {},
      ),
    }),
    ...(r.chatOutputLimitField !== undefined && {
      chatOutputLimitField: r.chatOutputLimitField as "max_tokens" | "max_completion_tokens",
    }),
    protocolVersion: version ?? (protocol === "anthropic-messages" ? "2023-06-01" : null),
  };
}

export function parseConnectionRequest(value: unknown, mode: "create"): CreateConnectionRequest;
export function parseConnectionRequest(value: unknown, mode: "edit"): EditConnectionRequest;
export function parseConnectionRequest(
  value: unknown,
  mode: "edit" | "create",
): CreateConnectionRequest | EditConnectionRequest {
  const r = object(value, "connection");
  exact(
    r,
    [
      "displayName",
      "providerId",
      "offeringId",
      "routes",
      "apiKey",
      ...(mode === "create" ? ["operationId", "accountIdentifier"] : ["expectedRecordRevision"]),
    ],
    "connection",
  );
  if (
    typeof r.displayName !== "string" ||
    !r.displayName.trim() ||
    r.displayName.length > 128 ||
    /[\x00-\x1f]/.test(r.displayName)
  )
    return fail("displayName");
  const scoped = r.providerId !== undefined || r.offeringId !== undefined;
  const validId = (v: unknown): v is string =>
    typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
  if (scoped && (!validId(r.providerId) || !validId(r.offeringId))) return fail("offeringId");
  const inputRoutes = r.routes ?? (scoped ? [] : undefined);
  if (
    !Array.isArray(inputRoutes) ||
    (!scoped && !inputRoutes.length) ||
    inputRoutes.length > endpointProtocols.length
  )
    return fail("routes");
  const routes = inputRoutes.map(parseModelRouteInput);
  if (new Set(routes.map((route) => route.protocol)).size !== routes.length)
    return fail("routes.protocol");
  assertFamilyRoots(routes);
  const apiKey = r.apiKey;
  if (
    (mode === "create" || apiKey !== undefined) &&
    (typeof apiKey !== "string" ||
      !apiKey.length ||
      apiKey.length > 4096 ||
      /[^\x21-\x7e]/.test(apiKey))
  )
    return fail("apiKey");
  const base = {
    displayName: r.displayName.trim(),
    routes,
    ...(scoped ? { providerId: r.providerId as string, offeringId: r.offeringId as string } : {}),
  };
  if (mode === "create") {
    if (typeof r.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(r.operationId))
      return fail("operationId");
    const identifier = r.accountIdentifier;
    if (
      identifier !== undefined &&
      (typeof identifier !== "string" ||
        !identifier.trim() ||
        identifier.length > 256 ||
        /[\x00-\x1f\x7f]/.test(identifier))
    )
      return fail("accountIdentifier");
    return {
      ...base,
      apiKey: apiKey as string,
      operationId: r.operationId,
      ...(typeof identifier === "string" && { accountIdentifier: identifier.trim() }),
    };
  }
  if (
    typeof r.expectedRecordRevision !== "string" ||
    !/^[\w.:+-]{1,128}$/.test(r.expectedRecordRevision)
  )
    return fail("expectedRecordRevision");
  return {
    ...base,
    expectedRecordRevision: r.expectedRecordRevision,
    ...(typeof apiKey === "string" ? { apiKey } : {}),
  };
}
export function familyVersion(r: ModelRouteInput): string {
  const family = modelEndpointDescriptor(r.protocol).protocolFamily;
  return r.protocolVersion ?? protocolFamilyDescriptors[family].nativeVersionPath.slice(1);
}
export function assertFamilyRoots(routes: ModelRouteInput[]) {
  const roots = new Map<ProtocolFamily, string>();
  for (const r of routes) {
    const family = modelEndpointDescriptor(r.protocol).protocolFamily;
    const identity = JSON.stringify([r.baseUrl, familyVersion(r)]);
    if (roots.has(family) && roots.get(family) !== identity) return fail("routes.familyBaseUrl");
    roots.set(family, identity);
  }
}
