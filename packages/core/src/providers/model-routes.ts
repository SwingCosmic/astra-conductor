import { createHash, randomUUID } from "node:crypto";
import {
  endpointProtocols,
  familyVersion,
  modelEndpointDescriptor,
  parseFamilyPolicy,
  parseModelRouteInput,
  protocolFamilyDescriptors,
  type EndpointProtocol,
  type ModelRoute,
  type ModelRouteInput,
  type ModelRouteSummary,
  type OfferingRouteConfig,
  type ProtocolFamily,
} from "@astra-conductor/contract/common";
import { AppError } from "../errors.js";
import type { Account, CredentialEnvelope } from "../models.js";
import { findOffering, getBuiltInModelPolicy, isLocalKeyAccount } from "./catalog.js";
import {
  applyPolicyChain,
  isCustomProviderId,
  type ProviderOfferingModelPolicy,
} from "./model-policy.js";

export const routeRevisionKey = (protocol: EndpointProtocol) => `modelBinding.${protocol}`;
export const familyRevisionKey = (family: ProtocolFamily) => `familyBinding.${family}`;
export const accountRoutesSettingKey = (accountId: string) => `account.routes.${accountId}`;

export function computeRouteBindingRevision(input: {
  accountId: string;
  providerId: string;
  offeringId: string;
  protocol: EndpointProtocol;
  endpointRevision: string;
  credentialRevision: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.accountId,
        input.providerId,
        input.offeringId,
        input.protocol,
        input.endpointRevision,
        input.credentialRevision,
      ]),
    )
    .digest("hex");
}

export function computeFamilyBindingRevision(input: {
  accountId: string;
  providerId: string;
  offeringId: string;
  protocolFamily: ProtocolFamily;
  baseUrl: string;
  protocolVersion: string;
  endpointRevisions: readonly string[] | string;
  credentialRevision: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.accountId,
        input.providerId,
        input.offeringId,
        input.protocolFamily,
        input.baseUrl,
        input.protocolVersion,
        Array.isArray(input.endpointRevisions)
          ? [...input.endpointRevisions].sort()
          : input.endpointRevisions,
        input.credentialRevision,
      ]),
    )
    .digest("hex");
}

export function defaultRoutesFromConfig(
  routeConfig: OfferingRouteConfig,
  offeringId: string,
  revisionPrefix?: string,
): ModelRoute[] {
  return routeConfig.defaults.map((route) => ({
    protocol: route.protocol,
    baseUrl: route.baseUrl,
    protocolVersion:
      route.protocolVersion !== undefined
        ? route.protocolVersion
        : route.protocol === "anthropic-messages"
          ? "2023-06-01"
          : null,
    bindingRevision: revisionPrefix ?? `v1.${offeringId}.${route.protocol}`,
  }));
}

function familyRoutes(
  routes: ModelRoute[],
  account: Account,
  credentialRevision: string,
  policy?: ProviderOfferingModelPolicy | null,
): ModelRoute[] {
  return routes.map((route) => {
    const protocolFamily = modelEndpointDescriptor(route.protocol).protocolFamily;
    const peers = routes.filter(
      (r) => modelEndpointDescriptor(r.protocol).protocolFamily === protocolFamily,
    );
    const consistent = peers.every(
      (r) => r.baseUrl === route.baseUrl && familyVersion(r) === familyVersion(route),
    );
    const familyBindingRevision = consistent
      ? computeFamilyBindingRevision({
          accountId: account.id,
          providerId: account.provider,
          offeringId: account.offeringId,
          protocolFamily,
          baseUrl: route.baseUrl,
          protocolVersion: familyVersion(route),
          endpointRevisions: route.familyBindingRevision ?? peers.map((r) => r.bindingRevision),
          credentialRevision,
        })
      : undefined;
    const familyCatalog =
      !consistent ||
      !protocolFamilyDescriptors[protocolFamily].catalogPath ||
      route.familyPolicy?.catalog === "none" ||
      policy?.catalogMode === "none"
        ? "none"
        : policy?.catalogMode === "vendor"
          ? "vendor"
          : "native";
    return { ...route, protocolFamily, familyBindingRevision, familyCatalog };
  });
}

function routeSummary({
  protocol,
  bindingRevision,
  protocolFamily,
  familyBindingRevision,
  familyCatalog,
}: ModelRoute): ModelRouteSummary {
  return {
    protocol,
    bindingRevision,
    protocolFamily,
    familyBindingRevision,
    familyCatalog,
  };
}

export function applyModelRouteQuery(url: URL, route: ModelRoute): URL {
  for (const [name, value] of Object.entries(route.familyPolicy?.query ?? {}))
    url.searchParams.set(name, value);
  return url;
}

/** Host-owned local offering endpoints; supplied only by the product business repository. */
export interface ConnectionProviderSource {
  accountRoutes?(
    accountId: string,
    providerId?: string,
    credentialRevision?: string,
  ): ModelRoute[] | undefined;
  routes(providerId: string, offeringId: string): ModelRoute[] | undefined;
  templateKind?(providerId: string): "generic" | "new-api" | undefined;
  newApiSite?(providerId: string, offeringId: string): string | undefined;
}

function resolveAccountPolicy(
  account: Pick<Account, "provider" | "offeringId">,
  source?: ConnectionProviderSource,
  policy?: ProviderOfferingModelPolicy,
): ProviderOfferingModelPolicy | null {
  if (policy) return policy;
  return getBuiltInModelPolicy({
    providerId: account.provider,
    offeringId: account.offeringId,
    templateKind: source?.templateKind?.(account.provider),
  });
}

function isLocalKeyRouteAccount(
  account: Account,
  policy: ProviderOfferingModelPolicy | null,
): boolean {
  if (isLocalKeyAccount(account)) return true;
  return (
    account.authMethod === "api-key" &&
    typeof account.publicMetadata.credentialBindingRevision === "string" &&
    Boolean(policy?.routeConfig)
  );
}

export function resolveModelRoutes(
  account: Account,
  envelope?: undefined,
  source?: ConnectionProviderSource,
  policy?: ProviderOfferingModelPolicy,
): ModelRouteSummary[];
export function resolveModelRoutes(
  account: Account,
  envelope: CredentialEnvelope,
  source?: ConnectionProviderSource,
  policy?: ProviderOfferingModelPolicy,
): ModelRoute[];
export function resolveModelRoutes(
  account: Account,
  envelope?: CredentialEnvelope,
  source?: ConnectionProviderSource,
  policy?: ProviderOfferingModelPolicy,
): ModelRouteSummary[] | ModelRoute[] {
  if (
    envelope &&
    (envelope.accountId !== account.id ||
      envelope.provider !== account.provider ||
      envelope.authMethod !== account.authMethod)
  ) {
    throw new AppError("authentication", "凭据与所选账号不匹配");
  }

  const activePolicy = resolveAccountPolicy(account, source, policy);

  if (isLocalKeyRouteAccount(account, activePolicy)) {
    const revision = account.publicMetadata.credentialBindingRevision;
    if (!revision || typeof revision !== "string") return [];
    if (envelope && (envelope.credentialBindingRevision !== revision || !envelope.secrets.apiKey)) {
      throw new AppError("stale-binding", "凭据绑定已变更");
    }
    let endpoints: ModelRoute[];
    if (isCustomProviderId(account.provider)) {
      endpoints = source?.routes(account.provider, account.offeringId) ?? [];
    } else if (activePolicy?.routeConfig) {
      if (activePolicy.routeConfig.mode === "fixed") {
        endpoints = defaultRoutesFromConfig(
          activePolicy.routeConfig,
          account.offeringId,
          "official-v1",
        );
      } else if (revision.startsWith("default-") || revision.startsWith("official-")) {
        endpoints = defaultRoutesFromConfig(
          activePolicy.routeConfig,
          account.offeringId,
          "default-v1",
        );
      } else {
        endpoints = source?.accountRoutes?.(account.id, account.provider, revision) ?? [];
      }
    } else {
      endpoints = [];
    }
    if (envelope && endpoints.length) validateEncryptedRoutes(endpoints, envelope.secrets.apiKey);
    const routes = familyRoutes(endpoints, account, revision, activePolicy).map((endpoint) => ({
      ...endpoint,
      bindingRevision: computeRouteBindingRevision({
        accountId: account.id,
        providerId: account.provider,
        offeringId: account.offeringId,
        protocol: endpoint.protocol,
        endpointRevision: endpoint.bindingRevision,
        credentialRevision: revision,
      }),
    }));
    return envelope ? routes : routes.map(routeSummary);
  }

  const owner = findOffering(account.offeringId);
  const routeConfig = activePolicy?.routeConfig ?? owner?.offering.routeConfig;
  if (routeConfig) {
    if (
      !policy &&
      (owner?.provider !== account.provider ||
        !owner.offering.authMethods.some((method) => method.method === account.authMethod))
    ) {
      return [];
    }
    const fixed = defaultRoutesFromConfig(routeConfig, account.offeringId);
    const routes = familyRoutes(fixed, account, account.stableIdentity, activePolicy);
    return envelope ? routes : routes.map(routeSummary);
  }

  // Legacy v2 encrypted connections (editable routes without routeConfig).
  if (
    account.authMethod !== "api-key" ||
    !owner ||
    owner.provider !== account.provider ||
    owner.offering.supportsSubscriptionUsage !== false
  ) {
    return [];
  }

  const summaries = endpointProtocols.flatMap((protocol) => {
    const bindingRevision = account.publicMetadata[routeRevisionKey(protocol)];
    const protocolFamily = modelEndpointDescriptor(protocol).protocolFamily;
    const family = account.publicMetadata[familyRevisionKey(protocolFamily)];
    const familyCatalog = protocolFamilyDescriptors[protocolFamily].catalogPath
      ? ("native" as const)
      : ("none" as const);
    return typeof bindingRevision === "string"
      ? [
          {
            protocol,
            bindingRevision,
            protocolFamily,
            familyCatalog,
            familyBindingRevision: typeof family === "string" ? family : undefined,
          },
        ]
      : [];
  });
  // Older encrypted connections expose only endpoint revisions. Derive the same opaque
  // family marker for their public view, then verify actual URL equivalence on decryption.
  for (const summary of summaries) {
    if (summary.familyBindingRevision) continue;
    const peers = summaries.filter((r) => r.protocolFamily === summary.protocolFamily);
    summary.familyBindingRevision = createHash("sha256")
      .update(
        JSON.stringify([
          account.id,
          summary.protocolFamily,
          peers.map((r) => r.bindingRevision).sort(),
        ]),
      )
      .digest("hex");
  }
  if (!envelope) return summaries;
  const routes = validateEncryptedRoutes(envelope.modelRoutes, envelope.secrets.apiKey);
  if (
    summaries.length !== routes.length ||
    summaries.some(
      (summary) =>
        !routes.some(
          (route) =>
            route.protocol === summary.protocol &&
            route.bindingRevision === summary.bindingRevision,
        ),
    )
  ) {
    throw new AppError("stale-binding", "协议绑定已更新，请重新读取连接");
  }
  return routes.map((route) => {
    const summary = summaries.find((s) => s.protocol === route.protocol)!;
    const peers = routes.filter(
      (r) => modelEndpointDescriptor(r.protocol).protocolFamily === summary.protocolFamily,
    );
    const consistent = peers.every(
      (r) => r.baseUrl === route.baseUrl && familyVersion(r) === familyVersion(route),
    );
    return {
      ...route,
      ...summary,
      familyCatalog: consistent ? summary.familyCatalog : "none",
      familyBindingRevision: consistent ? summary.familyBindingRevision : undefined,
    };
  });
}

export function validateEncryptedRoutes(value: unknown, apiKey: string | undefined): ModelRoute[] {
  if (
    !apiKey ||
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > endpointProtocols.length
  ) {
    throw new AppError("validation", "连接协议配置无效");
  }
  const routes = value.map((route: Record<string, unknown>) => {
    if (!route || typeof route !== "object") throw new AppError("validation", "连接协议配置无效");
    const {
      bindingRevision,
      familyBindingRevision: _,
      familyCatalog: __,
      familyPolicy,
      protocolRouteId,
      protocolFamilyId,
      ...rest
    } = route;
    const input: Record<string, unknown> = {
      ...rest,
      ...(!("protocol" in rest) && protocolRouteId !== undefined
        ? { protocol: protocolRouteId }
        : {}),
      ...(!("protocolFamily" in rest) && protocolFamilyId !== undefined
        ? { protocolFamily: protocolFamilyId }
        : {}),
    };
    if (typeof bindingRevision !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(bindingRevision)) {
      throw new AppError("validation", "连接协议修订无效");
    }
    const parsed = parseModelRouteInput(input);
    const policy = familyPolicy === undefined ? undefined : parseFamilyPolicy(familyPolicy);
    let path: string;
    try {
      path = decodeURIComponent(parsed.baseUrl);
    } catch {
      throw new AppError("validation", "接口地址无效");
    }
    if (parsed.requestRule && JSON.stringify(parsed.requestRule).includes(apiKey)) {
      throw new AppError("validation", "公开请求规则不能包含 API Key");
    }
    if (
      path.includes(apiKey) ||
      parsed.protocolVersion?.includes(apiKey) ||
      (policy && JSON.stringify(policy).includes(apiKey))
    ) {
      throw new AppError("validation", "公开配置中不能包含 API Key");
    }
    return {
      ...parsed,
      protocolVersion: parsed.protocolVersion ?? null,
      bindingRevision,
      ...(policy && { familyPolicy: policy }),
    };
  });
  if (new Set(routes.map((route) => route.protocol)).size !== routes.length) {
    throw new AppError("validation", "连接协议重复");
  }
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
      const prior = previous?.modelRoutes?.find(
        (item) =>
          item.protocol === route.protocol &&
          item.baseUrl === route.baseUrl &&
          item.protocolVersion === route.protocolVersion,
      );
      const priorLimit =
        prior?.protocol === "openai-chat"
          ? (prior.chatOutputLimitField ?? "max_completion_tokens")
          : undefined;
      const chatOutputLimitField =
        route.protocol === "openai-chat"
          ? (route.chatOutputLimitField ?? priorLimit ?? "max_completion_tokens")
          : undefined;
      return {
        ...route,
        ...(chatOutputLimitField && { chatOutputLimitField }),
        bindingRevision:
          prior &&
          previous?.secrets.apiKey === apiKey &&
          priorLimit === chatOutputLimitField &&
          JSON.stringify(prior.requestRule) === JSON.stringify(route.requestRule)
            ? prior.bindingRevision
            : randomUUID(),
      };
    }),
    apiKey,
  );
  if (previous?.secrets.apiKey && previous.secrets.apiKey !== apiKey) {
    validateEncryptedRoutes(routes, previous.secrets.apiKey);
  }
  return routes;
}

export function modelAuthorization(
  account: Account,
  envelope: CredentialEnvelope | null,
  route: ModelRoute,
  modelId?: string,
  operation: "chat" | "models" = "chat",
  source?: ConnectionProviderSource,
  policy?: ProviderOfferingModelPolicy,
): Record<string, string> {
  const activePolicy = resolveAccountPolicy(account, source, policy);
  if (
    envelope &&
    !resolveModelRoutes(account, envelope, source, activePolicy ?? undefined).some(
      (r) =>
        r.protocol === route.protocol &&
        r.bindingRevision === route.bindingRevision &&
        r.baseUrl === route.baseUrl &&
        JSON.stringify(r.familyPolicy) === JSON.stringify(route.familyPolicy) &&
        r.protocolVersion === route.protocolVersion,
    )
  ) {
    throw new AppError("stale-binding", "目标协议绑定已变更");
  }
  const secretKey =
    account.authMethod === "api-key"
      ? "apiKey"
      : (activePolicy?.credentialSecretKey ?? "accessToken");
  const secret = envelope ? envelope.secrets[secretKey] : "<redacted>";
  if (!secret) throw new AppError("authentication", "账号缺少所需凭据");

  const baseHeaders: Record<string, string> = { ...route.familyPolicy?.headers };
  if (route.protocol === "anthropic-messages") {
    baseHeaders["anthropic-version"] = route.protocolVersion ?? "2023-06-01";
  }
  const authentication =
    route.familyPolicy?.authentication ?? modelEndpointDescriptor(route.protocol).authentication;
  if (authentication === "bearer") {
    baseHeaders.Authorization = envelope ? `Bearer ${secret}` : "<redacted>";
  } else {
    baseHeaders[authentication] = secret;
  }

  return applyPolicyChain(baseHeaders, { account, envelope, route, operation, modelId, secret }, [
    activePolicy?.transformAuthHeaders,
  ]);
}
