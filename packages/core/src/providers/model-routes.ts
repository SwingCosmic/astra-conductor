import { createHash, randomUUID } from "node:crypto";
import {
  parseModelRouteInput,
  protocolRouteIds,
  type ModelRoute,
  type ModelRouteInput,
  type ModelRouteSummary,
  type ProtocolRouteId,
} from "@astra-conductor/contract/common";
import { getCodexCliRsHeaders } from "@omniroute/src/shared/constants/codexClient.ts";
import {
  GROK_BUILD_PROXY_BASE_URL,
  getGrokBuildModelsHeaders,
  getGrokBuildSessionHeaders,
} from "@omniroute/open-sse/config/grokBuild.ts";
import { AppError } from "../errors.js";
import type { Account, CredentialEnvelope } from "../models.js";
import {
  compatibleKeyId,
  isLocalKeyAccount,
  officialOpenAiOffering,
} from "./compatible-api-key/descriptor.js";
import { findOffering } from "./catalog.js";

export const routeRevisionKey = (id: ProtocolRouteId) => `modelBinding.${id}`;

function fixedRoutes(account: Account): ModelRoute[] {
  const owner = findOffering(account.offeringId);
  if (
    owner?.provider !== account.provider ||
    !owner.offering.authMethods.some((method) => method.method === account.authMethod)
  )
    return [];
  const fixed = (protocolRouteId: ProtocolRouteId, baseUrl: string): ModelRoute => ({
    protocolRouteId,
    baseUrl,
    protocolVersion: protocolRouteId === "anthropic-messages" ? "2023-06-01" : null,
    bindingRevision: `v1.${account.offeringId}.${protocolRouteId}`,
  });
  if (
    account.provider === "glm" &&
    ["bigmodel-coding-plan", "zai-coding-plan"].includes(account.offeringId)
  ) {
    const origin =
      account.offeringId === "bigmodel-coding-plan"
        ? "https://open.bigmodel.cn"
        : "https://api.z.ai";
    return [
      fixed("openai-chat", origin + "/api/coding/paas/v4"),
      fixed("anthropic-messages", origin + "/api/anthropic/v1"),
    ];
  }
  if (account.provider !== account.offeringId) return [];
  switch (account.provider) {
    case "opencode-go":
      return [fixed("openai-chat", "https://opencode.ai/zen/go/v1")];
    case "grok-build":
      return [fixed("openai-responses", GROK_BUILD_PROXY_BASE_URL)];
    case "codex":
      return [fixed("openai-responses", "https://chatgpt.com/backend-api/codex")];
    default:
      return [];
  }
}

/** Host-owned local offering endpoints; supplied only by the product business repository. */
export interface ConnectionProviderSource {
  routes(providerId: string, offeringId: string): ModelRoute[] | undefined;
}
export function resolveModelRoutes(
  account: Account,
  envelope?: undefined,
  source?: ConnectionProviderSource,
): ModelRouteSummary[];
export function resolveModelRoutes(
  account: Account,
  envelope: CredentialEnvelope,
  source?: ConnectionProviderSource,
): ModelRoute[];
export function resolveModelRoutes(
  account: Account,
  envelope?: CredentialEnvelope,
  source?: ConnectionProviderSource,
): ModelRouteSummary[] | ModelRoute[] {
  if (
    envelope &&
    (envelope.accountId !== account.id ||
      envelope.provider !== account.provider ||
      envelope.authMethod !== account.authMethod)
  )
    throw new AppError("authentication", "凭据与所选账号不匹配");
  if (isLocalKeyAccount(account)) {
    const revision = account.publicMetadata.credentialBindingRevision;
    if (!revision || typeof revision !== "string") return [];
    if (envelope && (envelope.credentialBindingRevision !== revision || !envelope.secrets.apiKey))
      throw new AppError("stale-binding", "凭据绑定已变更");
    const endpoints =
      account.provider === "codex" && account.offeringId === officialOpenAiOffering
        ? (["openai-chat", "openai-responses"] as const).map((protocolRouteId) => ({
            protocolRouteId,
            baseUrl: "https://api.openai.com/v1",
            protocolVersion: null,
            bindingRevision: "official-v1",
          }))
        : (source?.routes(account.provider, account.offeringId) ?? []);
    if (envelope && endpoints.length) validateEncryptedRoutes(endpoints, envelope.secrets.apiKey);
    return endpoints.map((endpoint) => {
      const bindingRevision = createHash("sha256")
        .update(
          JSON.stringify([
            account.id,
            account.provider,
            account.offeringId,
            endpoint.protocolRouteId,
            endpoint.bindingRevision,
            revision,
          ]),
        )
        .digest("hex");
      return envelope
        ? { ...endpoint, bindingRevision }
        : { protocolRouteId: endpoint.protocolRouteId, bindingRevision };
    });
  }
  if (account.provider !== compatibleKeyId) {
    const routes = fixedRoutes(account);
    return envelope
      ? routes
      : routes.map(({ protocolRouteId, bindingRevision }) => ({
          protocolRouteId,
          bindingRevision,
        }));
  }
  if (account.offeringId !== compatibleKeyId || account.authMethod !== "api-key") return [];
  const summaries = protocolRouteIds.flatMap((protocolRouteId) => {
    const bindingRevision = account.publicMetadata[routeRevisionKey(protocolRouteId)];
    return typeof bindingRevision === "string" ? [{ protocolRouteId, bindingRevision }] : [];
  });
  if (!envelope) return summaries;
  const routes = validateEncryptedRoutes(envelope.modelRoutes, envelope.secrets.apiKey);
  if (
    summaries.length !== routes.length ||
    summaries.some(
      (summary) =>
        !routes.some(
          (route) =>
            route.protocolRouteId === summary.protocolRouteId &&
            route.bindingRevision === summary.bindingRevision,
        ),
    )
  )
    throw new AppError("stale-binding", "协议绑定已更新，请重新读取连接");
  return routes;
}

export function validateEncryptedRoutes(value: unknown, apiKey: string | undefined): ModelRoute[] {
  if (
    !apiKey ||
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > protocolRouteIds.length
  )
    throw new AppError("validation", "连接协议配置无效");
  const routes = value.map((route: Record<string, unknown>) => {
    if (!route || typeof route !== "object") throw new AppError("validation", "连接协议配置无效");
    const { bindingRevision, ...input } = route;
    if (typeof bindingRevision !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(bindingRevision))
      throw new AppError("validation", "连接协议修订无效");
    const parsed = parseModelRouteInput(input);
    let path: string;
    try {
      path = decodeURIComponent(parsed.baseUrl);
    } catch {
      throw new AppError("validation", "接口地址无效");
    }
    if (path.includes(apiKey) || parsed.protocolVersion?.includes(apiKey))
      throw new AppError("validation", "公开配置中不能包含 API Key");
    return { ...parsed, protocolVersion: parsed.protocolVersion ?? null, bindingRevision };
  });
  if (new Set(routes.map((route) => route.protocolRouteId)).size !== routes.length)
    throw new AppError("validation", "连接协议重复");
  return routes;
}

export function bindModelRoutes(
  inputs: ModelRouteInput[],
  apiKey: string,
  previous?: CredentialEnvelope,
): ModelRoute[] {
  const routes = validateEncryptedRoutes(
    inputs.map((input) => {
      const route = parseModelRouteInput(input);
      const same =
        previous?.secrets.apiKey === apiKey &&
        previous.modelRoutes?.find(
          (item) =>
            item.protocolRouteId === route.protocolRouteId &&
            item.baseUrl === route.baseUrl &&
            item.protocolVersion === route.protocolVersion,
        );
      return { ...route, bindingRevision: same ? same.bindingRevision : randomUUID() };
    }),
    apiKey,
  );
  if (previous?.secrets.apiKey && previous.secrets.apiKey !== apiKey)
    validateEncryptedRoutes(routes, previous.secrets.apiKey);
  return routes;
}

export function modelAuthorization(
  account: Account,
  envelope: CredentialEnvelope | null,
  route: ModelRoute,
  modelId?: string,
  operation: "chat" | "models" = "chat",
  source?: ConnectionProviderSource,
): Record<string, string> {
  if (
    envelope &&
    !resolveModelRoutes(account, envelope, source).some(
      (r) =>
        r.protocolRouteId === route.protocolRouteId &&
        r.bindingRevision === route.bindingRevision &&
        r.baseUrl === route.baseUrl &&
        r.protocolVersion === route.protocolVersion,
    )
  )
    throw new AppError("stale-binding", "目标协议绑定已变更");
  const keyBased =
    account.authMethod === "api-key" ||
    [compatibleKeyId, "glm", "opencode-go"].includes(account.provider);
  const secret = envelope
    ? keyBased
      ? envelope.secrets.apiKey
      : envelope.secrets.accessToken
    : "<redacted>";
  if (!secret) throw new AppError("authentication", "账号缺少所需凭据");
  if (account.provider === "grok-build") {
    const identity = (key: string) => {
      const value = account.publicMetadata[key];
      return typeof value === "string" && value ? (envelope ? value : "<redacted>") : undefined;
    };
    const rawType = account.publicMetadata.principalType;
    const options = {
      token: secret,
      userId: identity("userId"),
      email: identity("email"),
      principalType: typeof rawType === "string" ? rawType : undefined,
    };
    const grokHeaders =
      operation === "models"
        ? getGrokBuildModelsHeaders(options)
        : getGrokBuildSessionHeaders({ ...options, stream: true, model: modelId });
    if (!envelope) grokHeaders.Authorization = "<redacted>";
    return grokHeaders;
  }
  const headers: Record<string, string> = {};
  if (route.protocolRouteId === "anthropic-messages") {
    headers["anthropic-version"] = route.protocolVersion ?? "2023-06-01";
    headers["x-api-key"] = secret;
    return headers;
  }
  headers.Authorization = envelope ? `Bearer ${secret}` : "<redacted>";
  if (account.provider === "codex" && account.offeringId === "codex") {
    Object.assign(headers, getCodexCliRsHeaders());
    const workspace = account.publicMetadata.workspaceId;
    if (typeof workspace === "string" && workspace)
      headers["chatgpt-account-id"] = envelope ? workspace : "<redacted>";
  }
  return headers;
}
