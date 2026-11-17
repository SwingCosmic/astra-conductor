import {
  ContractValidationError,
  type ModelParameterRule,
  type ModelParameterTemplate,
  type ModelParameters,
  type ProviderOperation,
} from "@astra-conductor/contract/graph-agent";
const parameterTypes: Record<keyof ModelParameters, ModelParameterRule["type"]> = {
  contextWindow: "integer",
  maxOutputTokens: "integer",
  effort: "string",
  temperature: "number",
  topP: "number",
  size: "string",
  quality: "string",
  count: "integer",
  voice: "string",
  format: "string",
  durationSeconds: "integer",
  dimensions: "integer",
  topK: "integer",
};
function invalid(field: string): never {
  throw new ContractValidationError("参数模板或取值无效：" + field, field);
}
export function checkParameterValues(
  template: ModelParameterTemplate,
  values: Partial<ModelParameters>,
) {
  for (const [field, value] of Object.entries(values)) {
    if (value == null) continue;
    const rule = template.fields[field as keyof ModelParameters];
    if (
      !rule ||
      !validType(value, rule.type) ||
      (rule.choices && !rule.choices.includes(value)) ||
      (typeof value === "number" &&
        ((rule.minimum !== undefined && value < rule.minimum) ||
          (rule.maximum !== undefined && value > rule.maximum)))
    )
      invalid(field);
  }
}
function validType(v: unknown, type: ModelParameterRule["type"]): v is number | string {
  return type === "string"
    ? typeof v === "string" && v.length > 0 && v.length <= 128
    : type === "integer"
      ? Number.isSafeInteger(v)
      : typeof v === "number" && Number.isFinite(v);
}
export function readTemplate(
  raw: unknown,
  operations: ProviderOperation[],
): ModelParameterTemplate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("template");
  const d = raw as Record<string, unknown>;
  if (Object.keys(d).some((k) => !["id", "operationId", "fields"].includes(k)))
    return invalid("template");
  if (
    typeof d.id !== "string" ||
    !/^[-a-z0-9_.]+$/.test(d.id) ||
    d.id.length > 128 ||
    !operations.includes(d.operationId as ProviderOperation) ||
    !d.fields ||
    typeof d.fields !== "object" ||
    Array.isArray(d.fields)
  )
    return invalid("template");
  const fields: ModelParameterTemplate["fields"] = {};
  for (const [key, raw] of Object.entries(d.fields)) {
    if (
      !Object.hasOwn(parameterTypes, key) ||
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    )
      return invalid("template.fields");
    const field = key as keyof ModelParameters;
    const v = raw as Record<string, unknown>,
      type = parameterTypes[field];
    if (
      Object.keys(v).some((k) => !["type", "minimum", "maximum", "choices", "unit"].includes(k)) ||
      v.type !== type
    )
      return invalid(key);
    const rule: ModelParameterRule = { type };
    for (const k of ["minimum", "maximum"] as const)
      if (v[k] !== undefined) {
        if (type === "string" || typeof v[k] !== "number" || !Number.isFinite(v[k]))
          return invalid(key);
        rule[k] = v[k] as number;
      }
    if (rule.minimum !== undefined && rule.maximum !== undefined && rule.minimum > rule.maximum)
      return invalid(key);
    if (v.choices !== undefined) {
      if (
        !Array.isArray(v.choices) ||
        !v.choices.length ||
        v.choices.length > 128 ||
        !v.choices.every((c) => validType(c, type))
      )
        return invalid(key);
      rule.choices = v.choices;
    }
    if (v.unit !== undefined) {
      if (typeof v.unit !== "string" || v.unit.length > 64) return invalid(key);
      rule.unit = v.unit;
    }
    fields[field] = rule;
  }
  return { id: d.id, operationId: d.operationId as ProviderOperation, fields };
}
