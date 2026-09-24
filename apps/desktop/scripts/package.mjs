import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: true,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagedNativeModule = path.join(
  packageRoot,
  "release",
  "win-unpacked",
  "resources",
  "app.asar.unpacked",
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "llm-usage-package-"));
const preservedNativeModule = path.join(temporaryDirectory, "better_sqlite3.node");

const rebuildCode = await run("electron-rebuild", [
  "--force",
  "--which-module",
  "better-sqlite3",
  "--version",
  "42.11.6",
  "--arch",
  "x64",
]);
const packageCode =
  rebuildCode === 0 ? await run("electron-builder", ["--win", "nsis", "--publish", "never"]) : 1;
let preserveCode = 0;
if (packageCode === 0) {
  try {
    await copyFile(packagedNativeModule, preservedNativeModule);
  } catch {
    preserveCode = 1;
  }
}
const restoreCode = await run("pnpm", ["rebuild", "better-sqlite3"]);
let unpackedRestoreCode = 0;
if (packageCode === 0 && preserveCode === 0) {
  try {
    await copyFile(preservedNativeModule, packagedNativeModule);
  } catch {
    unpackedRestoreCode = 1;
  }
}
await rm(temporaryDirectory, { recursive: true, force: true });

if (rebuildCode || packageCode || preserveCode || restoreCode || unpackedRestoreCode) {
  console.error(
    `package cleanup failed: rebuild=${rebuildCode} builder=${packageCode} preserve=${preserveCode} restore=${restoreCode} unpacked=${unpackedRestoreCode}`,
  );
}
process.exitCode = rebuildCode || packageCode || preserveCode || restoreCode || unpackedRestoreCode;
