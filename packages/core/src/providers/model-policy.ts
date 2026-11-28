import { isDeepStrictEqual } from "node:util";
import {
  assertFamilyRoots,
  endpointProtocols,
  modelEndpointDescriptor,
  parseHttpBaseUrl,
  type ActionAvailability,
  type EndpointProtocol,
  type JsonValue,
  type ModelFacts,
  type ModelParameters,
  type ModelPrice,
  type ModelRequestRule,
  type ModelRoute,
  type OfferingRouteConfig,
  type ProviderOperation,
} from "@astra-conductor/contract/common";
import { AppError } from "../errors.js";
import type { Account, CredentialEnvelope } from "../models.js";
import type { HttpPort } from "../ports.js";

/** Synchronous transform callback: receives current value and read-only context, returns next value. */
export type PolicyTransform<TValue, TContext> = (current: TValue, context: TContext) => TValue;

/** Asynchronous transform callback: receives current value and read-only context, returns next value. */
export type AsyncPolicyTransform<TValue, TContext> = (
  current: TValue,
  context: TContext,
) => TValue | Promise<TValue>;

/** Explicit sequential policy chain: undefined transforms are skipped. */
export function applyPolicyChain<TValue, TContext>(
  initial: TValue,
  context: TContext,
  transforms: readonly (PolicyTransform<TValue, TContext> | undefined)[],
): TValue {
  let current = initial;
  for (const transform of transforms) {
    if (transform) current = transform(current, context);
  }
  return current;
}

/** Explicit sequential async policy chain: undefined transforms are skipped. */
export async function applyAsyncPolicyChain<TValue, TContext>(
  initial: TValue,
  context: TContext,
  transforms: readonly (AsyncPolicyTransform<TValue, TContext> | undefined)[],
): Promise<TValue> {
  let current = initial;
  for (const transform of transforms) {
    if (transform) current = await transform(current, context);
  }
  return current;
}

export const isCustomProviderId = (providerId: string): boolean =>
  /^custom-[a-z0-9][a-z0-9-]{0,55}$/.test(providerId);

export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  facts: Partial<ModelFacts>;
  prices: ModelPrice[];
  /** Relays may list every visible ID even when they lack evidence for this route. */
  routeSupport?: "confirmed" | "unconfirmed";
  /** Family-scoped endpoint evidence; an empty array denotes missing endpoint evidence. */
  endpointTypes?: string[];
}

export interface ModelChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ActualChargeReceipt {
  amount: string;
  currency: string;
  eventId?: string;
}

export interface RequestPlanConstraints {
  readonly requiredFields: Record<string, JsonValue>;
  readonly forbiddenFields: readonly string[];
  readonly requiredNonEmptyStrings?: readonly string[];
  readonly requiredArrayItems?: Record<string, readonly JsonValue[]>;
}

/** Pre-encoding request intent plan shared by generation and native read-only validation. */
export interface RequestPlan {
  readonly localModelId: string;
  readonly upstreamModelId: string;
  readonly parameters: ModelParameters;
  readonly thinkingActive: boolean;
  readonly consumedParameters: readonly ("effort" | "window")[];
  readonly outputLimitField?: "max_tokens" | "max_completion_tokens";
  readonly suppressEffortField?: boolean;
  readonly suppressSummaryRequest?: boolean;
  readonly constraints: RequestPlanConstraints;
  readonly warnings: readonly { code: string; message: string }[];
}

/** Encoded protocol request draft for vendor body fields, extension headers, and query parameters. */
export interface ProtocolRequestDraft {
  readonly relativePath: string;
  readonly body: Record<string, JsonValue>;
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
}

export interface ModelFactsContext {
  readonly providerId: string;
  readonly offeringId: string;
  readonly protocol: EndpointProtocol;
  readonly operation: ProviderOperation;
  readonly modelId: string;
}

export interface ChatAvailabilityContext {
  readonly providerId: string;
  readonly offeringId: string;
  readonly protocol: EndpointProtocol;
  readonly modelId: string;
  readonly manual: boolean;
  readonly remoteOperations?: readonly ProviderOperation[] | null;
  readonly exactVendorPreset?: { readonly operations: readonly ProviderOperation[] } | null;
}

export interface CatalogQueryContext {
  readonly account: Account;
  readonly route: ModelRoute;
}

export interface CatalogPage {
  readonly entries: readonly unknown[] | null;
  readonly hasMore: boolean;
  readonly lastId?: string;
}

export interface CatalogPageContext {
  readonly account: Account;
  readonly route: ModelRoute;
  readonly raw: unknown;
}

export interface CatalogCandidatesContext {
  readonly http: HttpPort;
  readonly account: Account;
  readonly route: ModelRoute;
  readonly scope: "route" | "family";
  readonly siteBaseUrl?: string;
  readonly signal: AbortSignal;
  readonly rawEntriesByModelId: ReadonlyMap<string, readonly unknown[]>;
  readonly containsCredential: (value: unknown) => boolean;
}

export interface CatalogModelHint {
  readonly modelId: string;
  readonly upstreamModelId?: string;
  readonly endpointTypes?: readonly string[];
}

export interface RequestPlanContext {
  readonly providerId: string;
  readonly offeringId: string;
  readonly protocol: EndpointProtocol;
  readonly route: ModelRoute;
  readonly facts: Partial<ModelFacts>;
  readonly requestRule?: ModelRequestRule;
  readonly catalogModels?: readonly CatalogModelHint[];
}

export interface ProtocolRequestContext {
  readonly providerId: string;
  readonly offeringId: string;
  readonly protocol: EndpointProtocol;
  readonly route: ModelRoute;
  readonly plan: RequestPlan;
  readonly facts: Partial<ModelFacts>;
  readonly requestRule?: ModelRequestRule;
  readonly prompt: string;
}

export interface AuthHeadersContext {
  readonly account: Account;
  readonly envelope: CredentialEnvelope | null;
  readonly route: ModelRoute;
  readonly operation: "chat" | "models";
  readonly modelId?: string;
  readonly secret: string;
}

export interface UsageTransformContext {
  readonly providerId: string;
  readonly offeringId: string;
  readonly protocol: EndpointProtocol;
  readonly route: ModelRoute;
  readonly rawResponse: unknown;
}

export interface ReceiptContext {
  readonly http: HttpPort;
  readonly account: Account;
  readonly envelope: CredentialEnvelope;
  readonly route: ModelRoute;
  readonly modelId: string;
  readonly rawResponse?: unknown;
  readonly generationId?: string;
  readonly signal: AbortSignal;
  readonly headers: Record<string, string>;
}

/**
 * Core internal model policy: flat isomorphic (current, context) => next callbacks
 * supporting single-policy execution and explicit multi-policy chaining.
 */
export interface ProviderOfferingModelPolicy {
  readonly offeringId: string;
  /** Static route configuration projected to connection dialogs and server validation. */
  readonly routeConfig?: OfferingRouteConfig;
  /** Catalog discovery mode (omitted defaults by protocol family). */
  readonly catalogMode?: "native" | "vendor" | "none";
  /** Additional endpoint protocols discoverable beyond standard chat endpoints. */
  readonly discoverableProtocols?: readonly EndpointProtocol[];
  /** Explicit credential secret key when non-api-key auth stores an API key (e.g. CLI import). */
  readonly credentialSecretKey?: "apiKey" | "accessToken";

  /** 1. Model baseline facts and chat availability */
  transformModelFacts?: PolicyTransform<Partial<ModelFacts>, ModelFactsContext>;
  transformChatAvailability?: PolicyTransform<ActionAvailability, ChatAvailabilityContext>;

  /** 2. Catalog query, page parsing, and candidate enrichment/filtering */
  transformCatalogQuery?: PolicyTransform<Record<string, string>, CatalogQueryContext>;
  transformCatalogPage?: PolicyTransform<CatalogPage, CatalogPageContext>;
  transformCatalogCandidates?: AsyncPolicyTransform<DiscoveredModel[], CatalogCandidatesContext>;

  /** 3. Request plan and encoded protocol draft */
  transformRequestPlan?: PolicyTransform<RequestPlan, RequestPlanContext>;
  transformProtocolRequest?: PolicyTransform<ProtocolRequestDraft, ProtocolRequestContext>;

  /** 4. Outbound auth headers (invoked only inside credential callback scope) */
  transformAuthHeaders?: PolicyTransform<Record<string, string>, AuthHeadersContext>;

  /** 5. Response usage enrichment and optional delayed charge receipt */
  transformUsage?: PolicyTransform<ModelChatUsage, UsageTransformContext>;
  transformReceipt?: AsyncPolicyTransform<ActualChargeReceipt | null, ReceiptContext>;
}

export const PROVIDER_CONTRIBUTION_EXTRAS = Symbol("ProviderContributionExtras");

export interface ProviderContributionExtras {
  readonly templatePolicies?: Readonly<Record<string, ProviderOfferingModelPolicy>>;
  readonly receiptPolicies?: readonly ProviderOfferingModelPolicy[];
}

export function validateOfferingRouteConfig(
  offeringId: string,
  routeConfig: OfferingRouteConfig,
): void {
  if (routeConfig.mode !== "fixed" && routeConfig.mode !== "editable") {
    throw new Error(`Offering ${offeringId} declares invalid routeConfig mode`);
  }
  if (!routeConfig.allowedProtocols.length) {
    throw new Error(`Offering ${offeringId} declares empty routeConfig allowedProtocols`);
  }
  const allowed = new Set<EndpointProtocol>();
  for (const protocol of routeConfig.allowedProtocols) {
    if (!endpointProtocols.includes(protocol)) {
      throw new Error(`Offering ${offeringId} declares unknown protocol: ${String(protocol)}`);
    }
    if (allowed.has(protocol)) {
      throw new Error(`Offering ${offeringId} declares duplicate allowed protocol: ${protocol}`);
    }
    allowed.add(protocol);
  }
  const seenDefaults = new Set<EndpointProtocol>();
  for (const route of routeConfig.defaults) {
    if (!allowed.has(route.protocol)) {
      throw new Error(
        `Offering ${offeringId} default route protocol ${route.protocol} is not in allowedProtocols`,
      );
    }
    if (seenDefaults.has(route.protocol)) {
      throw new Error(`Offering ${offeringId} declares duplicate default route: ${route.protocol}`);
    }
    seenDefaults.add(route.protocol);
    parseHttpBaseUrl(route.baseUrl, `routeConfig.defaults.${route.protocol}.baseUrl`);
  }
  assertFamilyRoots(
    routeConfig.defaults.map((route) => ({
      protocol: route.protocol,
      baseUrl: route.baseUrl,
      ...(route.protocolVersion !== undefined ? { protocolVersion: route.protocolVersion } : {}),
    })),
  );
}

/** Step 1: Build base RequestPlan and apply thinking gate. */
export function buildBaseRequestPlan(
  localModelId: string,
  modelFacts: Partial<ModelFacts> = {},
  modelParameters: ModelParameters,
): RequestPlan {
  const thinkingDisabled =
    modelParameters.thinkingEnabled === false || modelFacts.reasoningMode === "none";
  const parameters: ModelParameters = thinkingDisabled
    ? {
        ...modelParameters,
        thinkingEnabled: false,
        effort: null,
        returnFullReasoning: false,
      }
    : { ...modelParameters };
  return {
    localModelId,
    upstreamModelId: localModelId,
    parameters,
    thinkingActive: !thinkingDisabled,
    consumedParameters: [],
    constraints: {
      requiredFields: {},
      forbiddenFields: [],
    },
    warnings: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readDotPath(
  source: Record<string, unknown>,
  dotPath: string,
): { exists: boolean; value: unknown } {
  const segments = dotPath.split(".");
  let current: unknown = source;
  for (const segment of segments) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
      return { exists: false, value: undefined };
    }
    current = current[segment];
  }
  return { exists: current !== undefined, value: current };
}

/**
 * Step 4c: Read-only native proxy body validator against RequestPlan constraints.
 * Asserts model match, forbidden fields, required fields, thinking-off guard, and consumed effort,
 * while passing all other native messages, tools, sampling, and extension fields through intact.
 */
export function validateNativeBody(
  parsedBody: Record<string, unknown>,
  plan: RequestPlan,
  protocol: EndpointProtocol,
): void {
  const reject = (message = "请求参数与当前供应商或模型配置不符"): never => {
    throw new AppError("validation", message);
  };

  // 1. Model matches compiled upstreamModelId (skipped when protocol puts modelId in URL path)
  if (
    modelEndpointDescriptor(protocol).modelIdLocation === "body" &&
    parsedBody.model !== plan.upstreamModelId
  ) {
    throw new AppError("conflict", "请求模型标识与当前绑定映射结果不符");
  }

  // 2. Forbidden fields (top-level keys or dot-paths) must be absent
  for (const field of plan.constraints.forbiddenFields) {
    if (readDotPath(parsedBody, field).exists) {
      reject(`请求体包含当前配置禁止的字段：${field}`);
    }
  }

  // 3. Required fields must match exact values at their dot-paths
  for (const [fieldPath, expected] of Object.entries(plan.constraints.requiredFields)) {
    const actual = readDotPath(parsedBody, fieldPath);
    if (!actual.exists || !isDeepStrictEqual(actual.value, expected)) {
      reject(`请求体缺少或偏离必需字段：${fieldPath}`);
    }
  }

  // 3b. Required non-empty strings (e.g. instructions)
  for (const fieldPath of plan.constraints.requiredNonEmptyStrings ?? []) {
    const actual = readDotPath(parsedBody, fieldPath);
    if (!actual.exists || typeof actual.value !== "string" || !actual.value.trim()) {
      reject(`请求体缺少必需的非空文本字段：${fieldPath}`);
    }
  }

  // 3c. Required array entries (e.g. include entries)
  for (const [fieldPath, requiredItems] of Object.entries(
    plan.constraints.requiredArrayItems ?? {},
  )) {
    const actual = readDotPath(parsedBody, fieldPath);
    if (!actual.exists || !Array.isArray(actual.value)) {
      reject(`请求体缺少必需数组项：${fieldPath}`);
    }
    const items = actual.value as unknown[];
    if (requiredItems.some((item) => !items.some((v) => isDeepStrictEqual(v, item)))) {
      reject(`请求体缺少必需数组项：${fieldPath}`);
    }
  }

  // 4. When thinking is inactive, standard thinking fields for this protocol must not be enabled
  if (!plan.thinkingActive) {
    if (protocol === "openai-chat") {
      const effort = parsedBody.reasoning_effort;
      if (effort !== undefined && effort !== "none") reject();
      if (isPlainObject(parsedBody.thinking) && parsedBody.thinking.type !== "disabled") reject();
    } else if (protocol === "openai-responses") {
      if (isPlainObject(parsedBody.reasoning)) {
        const effort = parsedBody.reasoning.effort;
        if (effort !== undefined && effort !== "none") reject();
        if (parsedBody.reasoning.summary !== undefined) reject();
      }
      if (
        Array.isArray(parsedBody.include) &&
        parsedBody.include.some((v) => typeof v === "string" && /^(reasoning|thinking)[._]/.test(v))
      ) {
        reject();
      }
    } else if (protocol === "anthropic-messages") {
      if (isPlainObject(parsedBody.thinking) && parsedBody.thinking.type !== "disabled") reject();
      if (
        isPlainObject(parsedBody.output_config) &&
        parsedBody.output_config.effort !== undefined
      ) {
        reject();
      }
    } else if (protocol === "gemini-generate-content") {
      const genConfig = isPlainObject(parsedBody.generationConfig)
        ? parsedBody.generationConfig
        : undefined;
      if (genConfig && isPlainObject(genConfig.thinkingConfig)) {
        const tc = genConfig.thinkingConfig;
        if (tc.includeThoughts === true) reject();
        if (typeof tc.thinkingBudget === "number" && tc.thinkingBudget > 0) reject();
        if (typeof tc.thinkingLevel === "string" && tc.thinkingLevel.toUpperCase() !== "NONE") {
          reject();
        }
      }
    }
  }

  // 5. When effort was consumed into the model name template, reject duplicate effort field
  if (plan.consumedParameters.includes("effort")) {
    if (protocol === "openai-chat" && readDotPath(parsedBody, "reasoning_effort").exists) reject();
    if (protocol === "openai-responses" && readDotPath(parsedBody, "reasoning.effort").exists) {
      reject();
    }
    if (protocol === "anthropic-messages" && readDotPath(parsedBody, "output_config.effort").exists)
      reject();
    if (
      protocol === "gemini-generate-content" &&
      readDotPath(parsedBody, "generationConfig.thinkingConfig.thinkingLevel").exists
    )
      reject();
  }
}
