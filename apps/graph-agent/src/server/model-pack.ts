import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  modelFactValue,
  type RateCard,
  type ModelParameterTemplate,
  type ModelPack,
  type ModelPresetOption,
  type ModelFacts,
  type ModelPrice,
  type ModelIOProfile,
  type ModelParameters,
  type ProviderOperation,
} from "@astra-conductor/contract/graph-agent";
import { readTemplate, checkParameterValues } from "./model-parameters.js";
import { AppError, parseRateCard } from "@astra-conductor/core/internal";

export interface PresetCapability {
  operation: ProviderOperation;
  parameterTemplateRef: string;
  rateCardRefs: { rateCardId: string; revision: string; planKey: string }[];
  ioProfiles: ModelIOProfile[];
  facts: Partial<ModelFacts>;
  parameters: Partial<ModelParameters>;
}
export interface PackPreset extends ModelPresetOption {
  family: string;
  series: string;
  sourceRef: string;
  capabilities: PresetCapability[];
  inherit?: { presetKey: string; fields: (keyof ModelFacts)[]; referenceUrl: string };
  prices: ModelPrice[];
}
export interface ValidatedPack {
  document: ModelPack;
  presets: PackPreset[];
  byKey: Map<string, PackPreset>;
  byExactId: Map<string, PackPreset[]>;
  templates: Map<string, ModelParameterTemplate>;
  rates: Map<string, RateCard>;
  digest: string;
}
function invalid(field: string): never {
  throw new AppError("validation", "模型预置包字段无效：" + field);
}
function record(raw: unknown, keys: string[], field: string): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !keys.includes(k))
  )
    return invalid(field);
  return raw as Record<string, unknown>;
}
function text(raw: unknown, field: string, max = 256): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > max || /[\u0000-\u001f]/u.test(raw))
    return invalid(field);
  return raw;
}
function list(raw: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length > max) return invalid(field);
  return raw;
}
function unique<T>(values: T[], key: (v: T) => string, field: string): T[] {
  if (new Set(values.map(key)).size !== values.length) invalid(field);
  return values;
}
function modalities(raw: unknown, field: string): string[] {
  const choices = ["text", "image", "video", "audio", "file", "choice", "vector", "scores"];
  return unique(
    list(raw, field, 8).map((v) => {
      if (typeof v !== "string" || !choices.includes(v)) return invalid(field);
      return v;
    }),
    (v) => v,
    field,
  );
}
function profile(raw: unknown): ModelIOProfile {
  const p = record(raw, ["kind", "requiredInputs", "optionalInputs", "outputs"], "profile");
  const requiredInputs = modalities(p.requiredInputs, "requiredInputs");
  const optionalInputs = modalities(p.optionalInputs, "optionalInputs");
  const outputs = modalities(p.outputs, "outputs");
  if (
    !requiredInputs.length ||
    !outputs.length ||
    optionalInputs.some((v) => requiredInputs.includes(v))
  )
    return invalid("ioProfiles");
  return { kind: text(p.kind, "profile.kind"), requiredInputs, optionalInputs, outputs };
}
const operations: ProviderOperation[] = [
  "chat",
  "image-generation",
  "audio-speech",
  "audio-transcription",
  "rerank",
  "video-generation",
  "embeddings",
  "music-generation",
  "decision",
];
function capability(raw: unknown): PresetCapability {
  const p = record(
    raw,
    ["operation", "ioProfiles", "facts", "parameters", "parameterTemplateRef", "rateCardRefs"],
    "capability",
  );
  const op = p.operation as ProviderOperation;
  if (!operations.includes(op)) return invalid("operation");
  const ioProfiles = unique(
    list(p.ioProfiles, "ioProfiles", 32).map(profile),
    (v) => v.kind,
    "profile.kind",
  );
  if (!ioProfiles.length || !p.facts || typeof p.facts !== "object" || Array.isArray(p.facts))
    return invalid("facts");
  const facts: Partial<ModelFacts> = {};
  for (const [name, value] of Object.entries(p.facts))
    Object.assign(facts, { [name]: modelFactValue(name as keyof ModelFacts, value) });
  if (facts.operations && !facts.operations.includes(op)) invalid("operations");
  const parameters = record(
    p.parameters ?? {},
    [
      "contextWindow",
      "maxOutputTokens",
      "thinkingEnabled",
      "returnFullReasoning",
      "effort",
      "temperature",
      "topP",
      "size",
      "quality",
      "count",
      "voice",
      "format",
      "durationSeconds",
      "dimensions",
      "topK",
    ],
    "parameters",
  ) as Partial<ModelParameters>;
  const rateCardRefs = unique(
    list(p.rateCardRefs ?? [], "rateCardRefs", 64).map((v) => {
      const r = record(v, ["rateCardId", "revision", "planKey"], "rateCardRef");
      if (["__proto__", "prototype", "constructor"].includes(String(r.planKey)))
        return invalid("planKey");
      return {
        rateCardId: text(r.rateCardId, "rateCardId"),
        revision: text(r.revision, "revision"),
        planKey: text(r.planKey, "planKey"),
      };
    }),
    (r) => JSON.stringify([r.rateCardId, r.revision, r.planKey]),
    "rateCardRefs",
  );
  return {
    operation: op,
    ioProfiles,
    facts,
    parameters,
    parameterTemplateRef: text(p.parameterTemplateRef, "parameterTemplateRef"),
    rateCardRefs,
  };
}
function preset(raw: unknown, revision: string): PackPreset {
  const p = record(
    raw,
    [
      "key",
      "vendor",
      "family",
      "series",
      "modelId",
      "displayName",
      "checkedAt",
      "referenceUrl",
      "capabilities",
      "prices",
      "inherit",
      "sourceRef",
    ],
    "preset",
  );
  const referenceUrl = text(p.referenceUrl, "referenceUrl", 2048);
  if (!/^https?:\/\//.test(referenceUrl)) invalid("referenceUrl");
  const checkedAt = text(p.checkedAt, "checkedAt", 32);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) || !Number.isFinite(Date.parse(checkedAt)))
    invalid("checkedAt");
  const capabilities = unique(
    list(p.capabilities, "capabilities", 16).map(capability),
    (v) => v.operation,
    "operation",
  );
  if (!capabilities.length) invalid("capabilities");
  const prices = list(p.prices ?? [], "prices", 64).map((raw) => {
    const r = record(
      raw,
      ["kind", "unit", "currency", "amount", "tier", "durationSeconds"],
      "price",
    );
    const kind = r.kind as ModelPrice["kind"];
    if (
      !["input", "output", "cache-read", "cache-write"].includes(kind) ||
      typeof r.amount !== "string" ||
      !/^\d{1,25}(?:\.\d{1,20})?$/.test(r.amount)
    )
      return invalid("price");
    if (
      r.durationSeconds !== null &&
      (!Number.isSafeInteger(r.durationSeconds) || Number(r.durationSeconds) <= 0)
    )
      return invalid("durationSeconds");
    return {
      kind,
      currency: text(r.currency, "currency", 16),
      unit: text(r.unit, "unit", 64),
      amount: r.amount,
      tier: r.tier === null ? null : text(r.tier, "tier", 64),
      durationSeconds: r.durationSeconds as number | null,
    };
  });
  let inherit: PackPreset["inherit"];
  if (p.inherit !== undefined) {
    const rule = record(p.inherit, ["presetKey", "fields", "referenceUrl"], "inherit");
    const fields = list(rule.fields, "inherit.fields", 10).map((field) => {
      if (
        typeof field !== "string" ||
        ![
          "toolCalling",
          "parallelToolCalling",
          "reasoningMode",
          "structuredOutput",
          "outputModalities",
          "contextWindow",
          "maxInputTokens",
          "maxOutputTokens",
        ].includes(field)
      )
        return invalid("inherit.fields");
      return field as keyof ModelFacts;
    });
    const referenceUrl = text(rule.referenceUrl, "inherit.referenceUrl", 2048);
    if (!/^https?:\/\//.test(referenceUrl) || !fields.length) invalid("inherit");
    inherit = { presetKey: text(rule.presetKey, "inherit.presetKey"), fields, referenceUrl };
  }
  return {
    sourceRef: text(p.sourceRef, "sourceRef"),
    inherit,
    key: text(p.key, "key"),
    vendor: text(p.vendor, "vendor"),
    family: text(p.family, "family"),
    series: text(p.series, "series"),
    modelId: text(p.modelId, "modelId"),
    displayName: text(p.displayName, "displayName"),
    checkedAt,
    referenceUrl,
    revision,
    capabilities,
    prices,
  };
}
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

function renameKey(obj: Record<string, unknown>, oldKey: string, newKey: string): boolean {
  if (!Object.hasOwn(obj, oldKey) || Object.hasOwn(obj, newKey)) return false;
  obj[newKey] = obj[oldKey];
  delete obj[oldKey];
  return true;
}

export function migrateLegacyRateCardJson(raw: unknown): { card: unknown; changed: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { card: raw, changed: false };
  const card = structuredClone(raw) as Record<string, unknown>;
  let changed = false;
  if (card.scope && typeof card.scope === "object" && !Array.isArray(card.scope)) {
    const scope = card.scope as Record<string, unknown>;
    if (renameKey(scope, "operationId", "operation")) changed = true;
    if (renameKey(scope, "planId", "planKey")) changed = true;
    if (renameKey(scope, "protocolRouteId", "protocol")) changed = true;
  }
  return { card, changed };
}

export function migrateLegacyModelPackJson(
  raw: unknown,
): { document: ModelPack; digest: string; changed: boolean } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const copy = structuredClone(raw) as Record<string, unknown>;
  if (!Array.isArray(copy.files)) return null;
  let changed = false;
  for (const file of copy.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) continue;
    const f = file as Record<string, unknown>;
    let fileChanged = false;
    if (Array.isArray(f.presets)) {
      for (const item of f.presets) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const p = item as Record<string, unknown>;
        if (renameKey(p, "vendorId", "vendor")) fileChanged = true;
        if (Array.isArray(p.capabilities)) {
          for (const capItem of p.capabilities) {
            if (!capItem || typeof capItem !== "object" || Array.isArray(capItem)) continue;
            const cap = capItem as Record<string, unknown>;
            if (renameKey(cap, "operationId", "operation")) fileChanged = true;
            if (Array.isArray(cap.ioProfiles)) {
              for (const ioItem of cap.ioProfiles) {
                if (!ioItem || typeof ioItem !== "object" || Array.isArray(ioItem)) continue;
                if (renameKey(ioItem as Record<string, unknown>, "id", "kind")) fileChanged = true;
              }
            }
          }
        }
      }
    }
    if (Array.isArray(f.templates)) {
      for (const tplItem of f.templates) {
        if (!tplItem || typeof tplItem !== "object" || Array.isArray(tplItem)) continue;
        if (renameKey(tplItem as Record<string, unknown>, "operationId", "operation"))
          fileChanged = true;
      }
    }
    if (Array.isArray(f.rateCards)) {
      f.rateCards = f.rateCards.map((cardItem) => {
        const res = migrateLegacyRateCardJson(cardItem);
        if (res.changed) fileChanged = true;
        return res.card;
      });
    }
    if (fileChanged) {
      const contents = {
        presets: f.presets,
        ...(f.templates !== undefined && { templates: f.templates }),
        ...(f.sources !== undefined && { sources: f.sources }),
        ...(f.rateCards !== undefined && { rateCards: f.rateCards }),
      };
      f.sha256 = digest(contents);
      changed = true;
    }
  }
  if (!changed) return null;
  copy.manifest = (copy.files as Record<string, unknown>[]).map((f) => ({
    path: f.path,
    sha256: f.sha256,
  }));
  const validated = validateModelPack(copy);
  return { document: validated.document, digest: validated.digest, changed: true };
}
export const maxModelPackBytes = 2 * 1024 * 1024;
/** 分片相对路径:仅限 `[a-zA-Z0-9_-]` 段,天然排除 "."/".." 与绝对路径。 */
export const packShardPathPattern = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.json$/;
export function validateModelPack(raw: unknown): ValidatedPack {
  const row = record(raw, ["schemaVersion", "revision", "files", "manifest"], "manifest");
  if (Buffer.byteLength(JSON.stringify(row), "utf8") > maxModelPackBytes) invalid("预置包大小");
  if (row.schemaVersion !== 2) invalid("schemaVersion");
  const revision = text(row.revision, "revision", 128);
  const presets: PackPreset[] = [],
    templates: ModelParameterTemplate[] = [],
    rates: RateCard[] = [];
  const sources = new Map<string, { url: string; checkedAt: string }>();
  const files = unique(
    list(row.files, "files", 128).map((raw) => {
      const f = record(
        raw,
        ["path", "sha256", "presets", "templates", "sources", "rateCards"],
        "file",
      );
      const path = text(f.path, "path");
      if (!packShardPathPattern.test(path)) invalid("path");
      const data = list(f.presets, "presets", 2048);
      const templateData =
          f.templates === undefined ? undefined : list(f.templates, "templates", 256),
        sourceData = f.sources === undefined ? undefined : list(f.sources, "sources", 4096),
        cardData = f.rateCards === undefined ? undefined : list(f.rateCards, "rateCards", 2048);
      const contents = {
        presets: data,
        ...(templateData && { templates: templateData }),
        ...(sourceData && { sources: sourceData }),
        ...(cardData && { rateCards: cardData }),
      };
      if (f.sha256 !== digest(contents)) invalid(path + ".sha256");
      presets.push(...data.map((p) => preset(p, revision)));
      templates.push(...(templateData ?? []).map((t) => readTemplate(t, operations)));
      rates.push(...(cardData ?? []).map(parseRateCard));
      for (const raw of sourceData ?? []) {
        const source = record(raw, ["id", "url", "checkedAt"], "source");
        const id = text(source.id, "source.id"),
          url = text(source.url, "source.url", 2048),
          checkedAt = text(source.checkedAt, "source.checkedAt", 32);
        if (
          sources.has(id) ||
          !/^https?:\/\//.test(url) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) ||
          !Number.isFinite(Date.parse(checkedAt))
        )
          invalid("source");
        sources.set(id, { url, checkedAt });
      }
      return { path, sha256: f.sha256 as string, ...contents };
    }),
    (v) => v.path,
    "path",
  );
  if (!files.length || presets.length > 8192) invalid("files");
  unique(presets, (v) => v.key, "key");
  unique(presets, (v) => JSON.stringify([v.vendor, v.modelId]), "modelId");
  const manifest = unique(
    list(row.manifest, "manifest", 128).map((raw) => {
      const entry = record(raw, ["path", "sha256"], "manifest.file");
      const path = text(entry.path, "manifest.path"),
        sha256 = text(entry.sha256, "manifest.sha256");
      if (!files.some((f) => f.path === path && f.sha256 === sha256))
        return invalid("manifest." + path);
      return { path, sha256 };
    }),
    (m) => m.path,
    "manifest.path",
  );
  if (manifest.length !== files.length) invalid("manifest.files");
  unique(templates, (t) => t.id, "template.id");
  unique(rates, (r) => JSON.stringify([r.rateCardId, r.revision]), "rateCard.revision");
  for (const op of operations)
    if (!templates.some((t) => t.id === op && t.operation === op))
      invalid("default template." + op);
  for (const item of presets) {
    const source = sources.get(item.sourceRef);
    if (!source || source.url !== item.referenceUrl || source.checkedAt !== item.checkedAt)
      invalid("sourceRef");
    for (const cap of item.capabilities) {
      const template = templates.find((t) => t.id === cap.parameterTemplateRef);
      if (!template || template.operation !== cap.operation) invalid("parameterTemplateRef");
      checkParameterValues(template, cap.parameters);
      for (const ref of cap.rateCardRefs) {
        const card = rates.find(
          (r) => r.rateCardId === ref.rateCardId && r.revision === ref.revision,
        );
        if (
          !card?.scope ||
          card.scope.operation !== cap.operation ||
          (card.scope.upstreamModelId && card.scope.upstreamModelId !== item.modelId)
        )
          invalid("rateCardRef");
      }
    }
    if (!item.inherit) continue;
    const parent = presets.find((p) => p.key === item.inherit!.presetKey);
    if (
      !parent ||
      parent.key === item.key ||
      parent.inherit ||
      parent.vendor !== item.vendor ||
      parent.family !== item.family ||
      parent.series !== item.series
    )
      invalid("inherit.presetKey");
    for (const cap of item.capabilities) {
      const base = parent.capabilities.find((c) => c.operation === cap.operation);
      if (!base || JSON.stringify(base.ioProfiles) !== JSON.stringify(cap.ioProfiles))
        invalid("inherit.ioProfiles");
    }
  }
  const document: ModelPack = { schemaVersion: 2, revision, manifest, files };
  const byExactId = new Map<string, PackPreset[]>();
  for (const p of presets) {
    const list = byExactId.get(p.modelId) ?? [];
    list.push(p);
    byExactId.set(p.modelId, list);
  }
  return {
    document,
    presets,
    byKey: new Map(presets.map((p) => [p.key, p])),
    byExactId,
    templates: new Map(templates.map((t) => [t.id, t])),
    rates: new Map(rates.map((r) => [JSON.stringify([r.rateCardId, r.revision]), r])),
    digest: digest(document),
  };
}
let cachedBundledPack: ValidatedPack | undefined;
/**
 * 随包预置目录的装配:manifest.json 单独承载修订号与逐片 SHA-256,
 * `families/*.json`(按家族的模型数据)与 `parameters/*.json`(按模型类型 /
 * 厂商家族限定的参数模板)只含纯数据。装配结果仍走 validateModelPack,
 * 分片摘要、清单对应关系与逐条引用在那一层统一校验。
 */
export function readModelPackDirectory(directory: URL): ModelPack {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8"));
  const row = record(manifest, ["schemaVersion", "revision", "files"], "manifest");
  if (row.schemaVersion !== 2) invalid("manifest.schemaVersion");
  const revision = text(row.revision, "revision", 128);
  const manifestEntries = list(row.files, "manifest.files", 128).map((entry) => {
    const e = record(entry, ["path", "sha256"], "manifest.file");
    const path = text(e.path, "path");
    // 读取前先限定分片相对路径(不允许 "." 段),阻断清单被篡改时的越界读取。
    if (!packShardPathPattern.test(path)) invalid("manifest.path");
    return { path, sha256: text(e.sha256, "manifest.sha256") };
  });
  const files = manifestEntries.map(({ path, sha256 }) => {
    const raw = JSON.parse(readFileSync(new URL(path, directory), "utf8")) as Record<
      string,
      unknown
    >;
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some((k) => !["presets", "templates", "sources", "rateCards"].includes(k))
    )
      return invalid(path);
    // parameters/ 分片只含模板;装配时补齐校验器要求的空 presets 槽。
    const contents: {
      presets: unknown[];
      templates?: unknown[];
      sources?: unknown[];
      rateCards?: unknown[];
    } = { presets: Array.isArray(raw.presets) ? raw.presets : [] };
    if (raw.templates !== undefined) contents.templates = raw.templates as unknown[];
    if (raw.sources !== undefined) contents.sources = raw.sources as unknown[];
    if (raw.rateCards !== undefined) contents.rateCards = raw.rateCards as unknown[];
    return { path, sha256, ...contents };
  });
  return { schemaVersion: 2, revision, manifest: manifestEntries, files };
}

export function bundledModelPack(): ValidatedPack {
  if (!cachedBundledPack) {
    cachedBundledPack = validateModelPack(
      readModelPackDirectory(new URL("../../resources/model-presets/", import.meta.url)),
    );
  }
  return cachedBundledPack;
}
export async function fetchPack(url: string, fetcher: typeof fetch): Promise<ValidatedPack> {
  const target = new URL(url);
  if (
    target.username ||
    target.password ||
    target.hash ||
    (target.protocol !== "https:" &&
      !(
        target.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(target.hostname)
      ))
  )
    invalid("更新地址");
  const response = await fetcher(target, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body)
    throw new AppError("service-unavailable", "预置包更新源暂不可用");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxModelPackBytes) {
        await reader.cancel();
        invalid("预置包大小");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return validateModelPack(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (err) {
    if (err instanceof SyntaxError) invalid("JSON");
    throw err;
  }
}
