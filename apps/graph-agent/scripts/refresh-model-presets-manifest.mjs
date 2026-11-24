// 重新生成 resources/model-presets/manifest.json。
//
// 数据分片(families/*.json、parameters/*.json)是唯一的人工编辑面;本脚本扫描两处目录,
// 按与服务端校验器相同的规范化规则重算每个分片的 SHA-256 并重写清单:
//   摘要 = sha256(JSON.stringify({ presets, templates?, sources?, rateCards? }))
// 其中 presets 恒存在(parameters/ 分片物理上无该键,装配补空数组),键序固定,紧凑序列化。
//
// 用法:node scripts/refresh-model-presets-manifest.mjs [--check]
//   默认    重写 manifest.json(新增分片追加条目,已删除的分片连同条目移除)
//   --check 只比对不写入;清单会发生变化时以非零码退出(适合提交前确认)
//
// 无网络依赖、无一次性参数;数据更新流程见 resources/model-presets/README.md。
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const rootPath = fileURLToPath(new URL("../resources/model-presets/", import.meta.url));
const checkOnly = process.argv.includes("--check");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const shardPathPattern = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.json$/;

// ── 扫描数据分片(parameters/、families/ 各一层)────────────────────────────
const discovered = [];
for (const dir of ["parameters", "families"]) {
  const dirPath = join(rootPath, dir);
  if (!existsSync(dirPath)) continue;
  for (const item of readdirSync(dirPath, { withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith(".json")) continue;
    const path = `${dir}/${item.name}`;
    if (!shardPathPattern.test(path)) throw new Error(`分片路径不合法:${path}`);
    discovered.push(path);
  }
}
discovered.sort();

// ── 读取旧清单(仅取 revision/schemaVersion,条目全部重算)──────────────────
const manifestPath = join(rootPath, "manifest.json");
const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
if (previous.schemaVersion !== 2)
  throw new Error(`manifest.schemaVersion 无效:${previous.schemaVersion}`);

// ── 逐片计算规范化摘要(键序与 validateModelPack 一致)──────────────────────
const contentsOf = (raw) => ({
  presets: Array.isArray(raw.presets) ? raw.presets : [],
  ...(raw.templates !== undefined && { templates: raw.templates }),
  ...(raw.sources !== undefined && { sources: raw.sources }),
  ...(raw.rateCards !== undefined && { rateCards: raw.rateCards }),
});

const entries = [];
for (const path of discovered) {
  const raw = JSON.parse(readFileSync(join(rootPath, path), "utf8"));
  const unknown = Object.keys(raw).filter(
    (k) => !["presets", "templates", "sources", "rateCards"].includes(k),
  );
  if (unknown.length) throw new Error(`${path} 含未知键:${unknown.join(", ")}`);
  if (!Array.isArray(raw.presets ?? []) && raw.presets !== undefined)
    throw new Error(`${path} 的 presets 不是数组`);
  entries.push({ path, sha256: digest(contentsOf(raw)) });
}

const before = new Map(previous.files.map((e) => [e.path, e.sha256]));
const after = new Map(entries.map((e) => [e.path, e.sha256]));
const dropped = [...before.keys()].filter((path) => !after.has(path));
if (dropped.length) console.log(`移除已消失的分片条目:${dropped.join(", ")}`);

let changed = dropped.length > 0 || before.size !== after.size;
for (const entry of entries) {
  if (!before.has(entry.path)) {
    console.log(`新分片:${entry.path}`);
    changed = true;
  } else if (before.get(entry.path) !== entry.sha256) {
    console.log(`摘要更新:${entry.path}`);
    changed = true;
  }
}

const next = {
  schemaVersion: previous.schemaVersion,
  revision: previous.revision,
  files: entries,
};
const serialized = JSON.stringify(next, null, 2) + "\n";
if (checkOnly) {
  if (changed || serialized !== readFileSync(manifestPath, "utf8")) {
    console.error(
      "清单与数据分片不一致:运行 node scripts/refresh-model-presets-manifest.mjs 修复。",
    );
    process.exit(1);
  }
  console.log(`清单一致(${entries.length} 个分片,revision ${previous.revision})。`);
} else {
  writeFileSync(manifestPath, serialized);
  console.log(
    `manifest.json 已重写:${entries.length} 个分片,revision ${previous.revision}(未变更)。`,
  );
}
