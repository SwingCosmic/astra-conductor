import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { rebuild } from "@electron/rebuild";

const require = createRequire(import.meta.url);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageFile = require.resolve("better-sqlite3/package.json");
const packageRoot = path.dirname(packageFile);
const electronVersion = require("electron/package.json").version;
const betterSqliteVersion = require(packageFile).version;
const outputRoot = path.join(desktopRoot, "lib", "better-sqlite3");
const outputBinary = path.join(outputRoot, "better_sqlite3.node");
const outputManifest = path.join(outputRoot, "manifest.json");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "llm-usage-native-"));

function includesGeneratedContent(source) {
  const relative = path.relative(packageRoot, source);
  if (!relative) return false;
  const first = relative.split(path.sep)[0];
  return first === "build" || first === "node_modules";
}

async function replaceFile(staged, target) {
  const backup = `${target}.${process.pid}.previous`;
  let movedExisting = false;
  await rm(backup, { force: true });
  try {
    await rename(target, backup);
    movedExisting = true;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw new Error(`Unable to replace ${target}. Exit llm-usage and try again.`, {
        cause: error,
      });
    }
  }
  try {
    await rename(staged, target);
  } catch (error) {
    if (movedExisting) await rename(backup, target);
    throw error;
  }
  if (movedExisting) await rm(backup, { force: true });
}

try {
  const temporaryModule = path.join(temporaryRoot, "node_modules", "better-sqlite3");
  await mkdir(path.dirname(temporaryModule), { recursive: true });
  await cp(packageRoot, temporaryModule, {
    recursive: true,
    filter: (source) => !includesGeneratedContent(source),
  });
  await writeFile(
    path.join(temporaryRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "llm-usage-electron-native-build",
        private: true,
        dependencies: { "better-sqlite3": betterSqliteVersion },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await rebuild({
    buildPath: temporaryRoot,
    projectRootPath: temporaryRoot,
    electronVersion,
    platform: process.platform,
    arch: process.arch,
    onlyModules: ["better-sqlite3"],
    buildFromSource: true,
    force: true,
  });

  const builtBinary = path.join(temporaryModule, "build", "Release", "better_sqlite3.node");
  const binary = await readFile(builtBinary);
  const manifest = {
    schemaVersion: 1,
    electronVersion,
    betterSqliteVersion,
    platform: process.platform,
    arch: process.arch,
    sha256: createHash("sha256").update(binary).digest("hex"),
  };

  await mkdir(outputRoot, { recursive: true });
  const stagedBinary = path.join(outputRoot, `better_sqlite3.node.${process.pid}.next`);
  const stagedManifest = path.join(outputRoot, `manifest.json.${process.pid}.next`);
  await writeFile(stagedBinary, binary);
  await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await replaceFile(stagedBinary, outputBinary);
  await replaceFile(stagedManifest, outputManifest);
  console.log(
    `Prepared better-sqlite3 ${betterSqliteVersion} for Electron ${electronVersion} ${process.platform}-${process.arch}`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
