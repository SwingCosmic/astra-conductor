import type { CommandContext } from "../service.js";
import { exact, fail, object } from "../validation/request.js";

import { protocolRouteIds, type ProtocolRouteId } from "./model-endpoint.js";
export * from "./model-endpoint.js";
export interface ModelRouteInput {
  protocolRouteId: ProtocolRouteId;
  baseUrl: string;
  protocolVersion?: string | null;
}
export interface ModelRoute extends ModelRouteInput {
  protocolVersion: string | null;
  bindingRevision: string;
}
export type ModelRouteSummary = Pick<ModelRoute, "protocolRouteId" | "bindingRevision">;
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

export function parseModelRouteInput(value: unknown): ModelRouteInput {
  const r = object(value, "routes");
  exact(r, ["protocolRouteId", "baseUrl", "protocolVersion"], "routes");
  const id = r.protocolRouteId as ProtocolRouteId;
  if (!protocolRouteIds.includes(id)) return fail("routes.protocolRouteId");
  if (
    typeof r.baseUrl !== "string" ||
    !r.baseUrl ||
    r.baseUrl.length > 2048 ||
    /[\s\\?#\x00-\x1f]/.test(r.baseUrl) ||
    !/^https?:\/\//i.test(r.baseUrl)
  )
    return fail("routes.baseUrl");
  let url: URL;
  try {
    url = new URL(r.baseUrl);
  } catch {
    return fail("routes.baseUrl");
  }
  if (url.username || url.password || r.baseUrl.split("://")[1]?.split("/")[0]?.includes("@"))
    return fail("routes.baseUrl");
  const version = r.protocolVersion;
  if (version != null && (typeof version !== "string" || !/^[\w.-]{1,64}$/.test(version)))
    return fail("routes.protocolVersion");
  const versions = id.startsWith("gemini-")
    ? ["v1beta", "v1"]
    : id === "cohere-rerank"
      ? ["v2"]
      : ["v1"];
  if (id !== "anthropic-messages" && version != null && !versions.includes(version as string))
    return fail("routes.protocolVersion");
  return {
    protocolRouteId: id,
    baseUrl: url.href.replace(/\/+$/, ""),
    protocolVersion: version ?? (id === "anthropic-messages" ? "2023-06-01" : null),
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
    (scoped ? inputRoutes.length !== 0 : !inputRoutes.length) ||
    inputRoutes.length > protocolRouteIds.length
  )
    return fail("routes");
  const routes = inputRoutes.map(parseModelRouteInput);
  if (new Set(routes.map((route) => route.protocolRouteId)).size !== routes.length)
    return fail("routes.protocolRouteId");
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
