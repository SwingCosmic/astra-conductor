import type {
  JsonValue,
  ModelFacts,
  ModelParameters,
  ModelRequestRule,
  ModelRoute,
} from "@astra-conductor/contract/common";
import { AppError } from "../errors.js";
import {
  applyPolicyChain,
  buildBaseRequestPlan,
  type PolicyTransform,
  type ProtocolRequestContext,
  type ProtocolRequestDraft,
  type ProviderOfferingModelPolicy,
  type RequestPlan,
  type RequestPlanContext,
} from "./model-policy.js";

const protoKeys = new Set(["__proto__", "prototype", "constructor"]);
const topLevelReservedKeys = new Set([
  "model",
  "messages",
  "input",
  "prompt",
  "system",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "stream_options",
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "reasoning",
  "reasoning_effort",
  "thinking",
  "output_config",
  "store",
]);

function isPlainJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return (
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
  );
}

export function resolveEffectiveModelRule(
  modelId: string,
  configured?: ModelRequestRule,
): { rule: ModelRequestRule | undefined; hasByModel: boolean } {
  const base =
    configured && (!configured.models || configured.models.includes(modelId))
      ? configured
      : undefined;
  const hasByModel = Boolean(base?.byModel && Object.hasOwn(base.byModel, modelId));
  const specific = hasByModel ? base!.byModel![modelId] : undefined;
  if (!base || !specific) return { rule: base, hasByModel };
  return {
    hasByModel,
    rule: {
      ...base,
      ...specific,
      defaults: { ...base.defaults, ...specific.defaults },
      headers: { ...base.headers, ...specific.headers },
      body: mergeRuleBodies(base.body, specific.body),
    },
  };
}

export function mergeRuleBodies(
  base: Record<string, JsonValue> = {},
  specific: Record<string, JsonValue> = {},
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = { ...base };
  for (const [key, value] of Object.entries(specific)) {
    if (protoKeys.has(key.toLowerCase())) {
      throw new AppError("validation", "请求规则字段非法：" + key);
    }
    const old = result[key];
    if (old !== undefined && isPlainJsonObject(old) !== isPlainJsonObject(value)) {
      throw new AppError("validation", "请求规则字段类型冲突：" + key);
    }
    result[key] =
      isPlainJsonObject(old) && isPlainJsonObject(value) ? mergeRuleBodies(old, value) : value;
  }
  return result;
}

export function mergeModelExtensions(
  body: Record<string, JsonValue>,
  extensions: Record<string, JsonValue>,
  depth = 0,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = { ...body };
  for (const [key, value] of Object.entries(extensions)) {
    const lower = key.toLowerCase();
    if (protoKeys.has(lower)) {
      throw new AppError("validation", "请求扩展字段非法：" + key);
    }
    if (depth === 0 && topLevelReservedKeys.has(lower)) {
      throw new AppError("validation", "请求扩展不能覆写顶层保留字段：" + key);
    }
    const current = result[key];
    if (current === undefined) {
      result[key] = value;
    } else if (isPlainJsonObject(current) && isPlainJsonObject(value)) {
      result[key] = mergeModelExtensions(current, value, depth + 1);
    } else if (JSON.stringify(value) !== JSON.stringify(current)) {
      throw new AppError("validation", "请求扩展与模型参数冲突：" + key);
    }
  }
  return result;
}

/** Step 2a: Fill user requestRule.defaults (skipping effort when thinking is inactive). */
export const applyUserRuleDefaults: PolicyTransform<RequestPlan, RequestPlanContext> = (
  plan,
  context,
) => {
  const { rule } = resolveEffectiveModelRule(plan.localModelId, context.requestRule);
  if (!rule?.defaults) return plan;
  const nextParameters: ModelParameters = { ...plan.parameters };
  let changed = false;
  for (const [field, value] of Object.entries(rule.defaults)) {
    if (
      nextParameters[field as keyof ModelParameters] == null &&
      (field !== "effort" || plan.thinkingActive)
    ) {
      Object.assign(nextParameters, { [field]: value });
      changed = true;
    }
  }
  return changed ? { ...plan, parameters: nextParameters } : plan;
};

/** Step 2z: Apply user aliases, modelTemplate, target checks, and consumedParameters. */
export const applyUserAliasesAndTemplate: PolicyTransform<RequestPlan, RequestPlanContext> = (
  plan,
  context,
) => {
  const { rule } = resolveEffectiveModelRule(plan.localModelId, context.requestRule);
  if (!rule) return plan;

  let id = plan.upstreamModelId;
  const seen = new Set<string>();
  while (rule.aliases && Object.hasOwn(rule.aliases, id)) {
    if (seen.has(id)) throw new AppError("validation", "模型别名存在循环引用");
    seen.add(id);
    id = rule.aliases[id]!;
  }

  if (rule.modelTemplate) {
    const window = rule.windowLabels?.[String(plan.parameters.contextWindow)];
    id = rule.modelTemplate.replace(/\{(model|effort|windowLabel)\}/g, (_match, key: string) => {
      const value =
        key === "model"
          ? id
          : key === "effort"
            ? plan.thinkingActive && plan.parameters.effort
            : window;
      if (!value) throw new AppError("validation", "模型名称模板缺少有效参数：" + key);
      return value;
    });
    if (!rule.targets?.includes(id)) {
      throw new AppError("validation", "请求映射目标不在已登记的型号中");
    }
  } else if (id !== plan.upstreamModelId && rule.targets?.length && !rule.targets.includes(id)) {
    throw new AppError("validation", "请求映射目标不在已登记的型号中");
  }

  const consumedParameters = rule.consume?.length
    ? ([...new Set([...plan.consumedParameters, ...rule.consume])] as readonly (
        | "effort"
        | "window"
      )[])
    : plan.consumedParameters;

  return {
    ...plan,
    upstreamModelId: id,
    consumedParameters,
  };
};

/** Step 3z: Merge familyPolicy.body -> endpoint rule.body -> byModel.body and extension headers. */
export const applyUserExtensions: PolicyTransform<ProtocolRequestDraft, ProtocolRequestContext> = (
  draft,
  context,
) => {
  const { rule } = resolveEffectiveModelRule(context.plan.localModelId, context.requestRule);
  const combinedExtensions = mergeRuleBodies(context.route.familyPolicy?.body, rule?.body);
  const nextBody = Object.keys(combinedExtensions).length
    ? mergeModelExtensions(draft.body, combinedExtensions, 0)
    : draft.body;

  const nextHeaders: Record<string, string> = { ...draft.headers };
  for (const [name, value] of Object.entries(rule?.headers ?? {})) {
    if (
      context.route.familyPolicy?.headers?.[name] !== undefined &&
      context.route.familyPolicy.headers[name] !== value
    ) {
      throw new AppError("validation", "请求头与协议族绑定冲突：" + name);
    }
    nextHeaders[name] = value;
  }
  nextHeaders.accept = nextBody.stream === true ? "text/event-stream" : "application/json";

  return {
    ...draft,
    body: nextBody,
    headers: nextHeaders,
  };
};

export interface CompileModelRequestPlanInput {
  readonly providerId: string;
  readonly offeringId: string;
  readonly route: ModelRoute;
  readonly localModelId: string;
  readonly facts?: Partial<ModelFacts>;
  readonly parameters: ModelParameters;
  readonly policy?: ProviderOfferingModelPolicy;
  readonly extraPolicies?: readonly ProviderOfferingModelPolicy[];
  readonly catalogModels?: RequestPlanContext["catalogModels"];
}

/** Step 1 + Step 2: Compile a RequestPlan via the deterministic policy transform chain. */
export function compileModelRequestPlan(input: CompileModelRequestPlanInput): RequestPlan {
  const facts = input.facts ?? {};
  const basePlan = buildBaseRequestPlan(input.localModelId, facts, input.parameters);
  const context: RequestPlanContext = {
    providerId: input.providerId,
    offeringId: input.offeringId,
    protocol: input.route.protocol,
    route: input.route,
    facts,
    requestRule: input.route.requestRule,
    catalogModels: input.catalogModels,
  };

  const transforms: (PolicyTransform<RequestPlan, RequestPlanContext> | undefined)[] = [
    applyUserRuleDefaults,
    ...(input.extraPolicies ?? []).map((p) => p.transformRequestPlan),
    input.policy?.transformRequestPlan,
    applyUserAliasesAndTemplate,
  ];

  const compiled = applyPolicyChain(basePlan, context, transforms);

  const warnings = [...compiled.warnings];
  if (
    compiled.parameters.contextWindow != null &&
    !compiled.consumedParameters.includes("window")
  ) {
    warnings.push({
      code: "context-window",
      message: "上下文窗口作为本地配置保存，标准聊天协议没有对应的请求字段",
    });
  }

  const hasNativeThinkingDisable =
    compiled.constraints.requiredFields["thinking.type"] === "disabled" ||
    compiled.constraints.requiredFields["reasoning.effort"] === "none";

  if (
    input.parameters.thinkingEnabled === false &&
    facts.reasoningMode !== "none" &&
    !hasNativeThinkingDisable
  ) {
    warnings.push({
      code: "thinking-display-disabled",
      message: "本轮关闭思考参数与展示，上游模型仍按自身协议决定是否进行内部推理。",
    });
  }

  return warnings.length === compiled.warnings.length ? compiled : { ...compiled, warnings };
}

/** Legacy helper preserved for direct callers; pure static aliases no longer require targets. */
export function prepareModelRule(
  modelId: string,
  parameters: ModelParameters,
  configured?: ModelRequestRule,
) {
  const { rule } = resolveEffectiveModelRule(modelId, configured);
  const basePlan = buildBaseRequestPlan(modelId, {}, parameters);
  const dummyRoute: ModelRoute = {
    protocol: "openai-chat",
    baseUrl: "https://example.invalid",
    protocolVersion: null,
    bindingRevision: "local",
    requestRule: configured,
  };
  const ctx: RequestPlanContext = {
    providerId: "local",
    offeringId: "local",
    protocol: "openai-chat",
    route: dummyRoute,
    facts: {},
    requestRule: configured,
  };
  const plan = applyPolicyChain(basePlan, ctx, [
    applyUserRuleDefaults,
    applyUserAliasesAndTemplate,
  ]);
  return {
    id: plan.upstreamModelId,
    consumedParameters: [...plan.consumedParameters],
    rule,
    effectiveParameters: plan.parameters,
  };
}
