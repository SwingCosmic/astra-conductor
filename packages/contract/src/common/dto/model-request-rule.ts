import { exact, fail, object } from "../validation/request.js";
import type { JsonValue } from "./model.js";

/** A local, declarative chat rule for one offering endpoint. */
export interface ModelRequestRule {
  operation: "chat";
  defaults?: { temperature?: number; topP?: number; maxOutputTokens?: number; effort?: string };
  byModel?: Record<string, Omit<ModelRequestRule, "byModel" | "operation" | "models">>;
  models?: string[];
  aliases?: Record<string, string>;
  modelTemplate?: string;
  targets?: string[];
  windowLabels?: Record<string, string>;
  consume?: ("effort" | "window")[];
  headers?: Record<string, string>;
  body?: Record<string, JsonValue>;
}

const protoKeys = new Set(["__proto__", "prototype", "constructor"]);
const topLevelReserved = new Set([
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
function cleanBody(value: unknown, depth: number): JsonValue {
  if (depth > 8) return fail("requestRule.body");
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (
    typeof value === "string" &&
    value.length <= 2048 &&
    !/(?:Bearer\s|sk-|nap_)[a-z\d_-]{8,}/i.test(value)
  )
    return value;
  if (Array.isArray(value) && value.length <= 64)
    return value.map((item) => cleanBody(item, depth + 1));
  const row = object(value, "requestRule.body");
  return Object.fromEntries(
    Object.entries(row).map(([name, item]) => {
      const lower = name.toLowerCase();
      if (
        !/^[a-z][a-z\d_-]{0,63}$/i.test(name) ||
        protoKeys.has(lower) ||
        (depth === 0 && topLevelReserved.has(lower))
      )
        return fail("requestRule.body." + name);
      return [name, cleanBody(item, depth + 1)];
    }),
  );
}
export function parseModelExtensionBody(value: unknown): Record<string, JsonValue> {
  const body = object(value, "requestRule.body");
  if (JSON.stringify(body).length > 32768) return fail("requestRule.body");
  return cleanBody(body, 0) as Record<string, JsonValue>;
}
function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\x00-\x1f\x7f{}]/.test(value) ||
    ["constructor", "prototype", "__proto__"].includes(value)
  )
    return fail("requestRule.model");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1024) return fail("requestRule.models");
  return [...new Set(value.map(identifier))];
}
function map(value: unknown) {
  return Object.fromEntries(
    Object.entries(object(value, "requestRule")).map(([k, v]) => [identifier(k), identifier(v)]),
  );
}
export function parseModelRequestRule(
  input: unknown,
  parseHeaders: (value: unknown) => Record<string, string>,
  nested = false,
): ModelRequestRule {
  const row = object(input, "requestRule");
  exact(
    row,
    [
      "operation",
      "defaults",
      "byModel",
      "models",
      "aliases",
      "modelTemplate",
      "targets",
      "windowLabels",
      "consume",
      "headers",
      "body",
    ],
    "requestRule",
  );
  if (row.operation !== "chat" || JSON.stringify(row).length > 32768) return fail("requestRule");
  const rule: ModelRequestRule = { operation: "chat" };
  if (row.defaults !== undefined) {
    const defaults = object(row.defaults, "requestRule.defaults");
    exact(defaults, ["temperature", "topP", "maxOutputTokens", "effort"], "requestRule.defaults");
    rule.defaults = {};
    for (const field of ["temperature", "topP", "maxOutputTokens"] as const) {
      const v = defaults[field];
      if (v === undefined) continue;
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        v < 0 ||
        (field === "temperature" && v > 2) ||
        (field === "topP" && v > 1) ||
        (field === "maxOutputTokens" && (!Number.isSafeInteger(v) || v < 1))
      )
        return fail("requestRule.defaults." + field);
      rule.defaults[field] = v;
    }
    if (defaults.effort !== undefined) rule.defaults.effort = identifier(defaults.effort);
  }
  if (row.byModel !== undefined) {
    if (nested) return fail("requestRule.byModel");
    rule.byModel = Object.fromEntries(
      Object.entries(object(row.byModel, "requestRule.byModel")).map(([model, raw]) => {
        const specific = object(raw, "requestRule.byModel");
        if ("operation" in specific || "models" in specific) return fail("requestRule.byModel");
        const { operation: _, ...values } = parseModelRequestRule(
          { ...specific, operation: "chat" },
          parseHeaders,
          true,
        );
        return [identifier(model), values];
      }),
    );
  }
  if (row.models !== undefined) rule.models = strings(row.models);
  if (row.targets !== undefined) rule.targets = strings(row.targets);
  if (row.aliases !== undefined) rule.aliases = map(row.aliases);
  if (row.windowLabels !== undefined) rule.windowLabels = map(row.windowLabels);
  if (row.modelTemplate !== undefined) {
    if (typeof row.modelTemplate !== "string" || !row.modelTemplate.includes("{model}"))
      return fail("requestRule.modelTemplate");
    identifier(row.modelTemplate.replace(/\{(model|effort|windowLabel)\}/g, "x"));
    rule.modelTemplate = row.modelTemplate;
  }
  if (row.consume !== undefined)
    rule.consume = strings(row.consume).map((k) => {
      if (
        (k !== "effort" && k !== "window") ||
        !rule.modelTemplate?.includes(k === "effort" ? "{effort}" : "{windowLabel}")
      )
        return fail("requestRule.consume");
      return k;
    });
  if (!nested && rule.modelTemplate && !rule.targets?.length) return fail("requestRule.targets");
  for (const key of Object.keys(rule.aliases ?? {})) {
    const seen = new Set<string>();
    let id = key;
    while (rule.aliases && Object.hasOwn(rule.aliases, id)) {
      if (seen.has(id)) return fail("requestRule.aliases");
      seen.add(id);
      id = rule.aliases[id]!;
    }
    if (!nested && !rule.modelTemplate && rule.targets?.length && !rule.targets.includes(id))
      return fail("requestRule.targets");
  }
  if (row.body !== undefined) rule.body = parseModelExtensionBody(row.body);
  if (row.headers !== undefined) rule.headers = parseHeaders(row.headers);
  return rule;
}
