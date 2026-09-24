import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (!new Set(["dev", "reset", "codex-cli-smoke"]).has(mode)) {
  throw new Error("Expected dev, reset, or codex-cli-smoke mode");
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron = (await import("electron")).default;
const temporaryUserData =
  mode === "codex-cli-smoke" ? await mkdtemp(path.join(tmpdir(), "llm-usage-live-")) : null;
const needsElectronNativeModule = mode === "dev" || mode === "codex-cli-smoke";
const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;

const env = {
  ...process.env,
  ...(mode === "reset" ? { LLM_USAGE_RESET_DATA: "1" } : {}),
  ...(mode === "codex-cli-smoke" ? { LLM_USAGE_CODEX_CLI_SMOKE: "1" } : {}),
  ...(temporaryUserData ? { LLM_USAGE_USER_DATA: temporaryUserData } : {}),
};

async function restoreNodeNativeModule() {
  const pnpmScript = process.env.npm_execpath;
  if (!pnpmScript) throw new Error("Unable to locate pnpm for native module restore");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pnpmScript, "rebuild", "better-sqlite3"], {
      cwd: desktopRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
}

try {
  if (needsElectronNativeModule) {
    const { rebuild } = await import("@electron/rebuild");
    await rebuild({
      buildPath: desktopRoot,
      electronVersion,
      arch: "x64",
      onlyModules: ["better-sqlite3"],
      force: true,
    });
  }
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, ["."], {
      cwd: desktopRoot,
      env,
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  process.exitCode = code;
} finally {
  if (temporaryUserData) await rm(temporaryUserData, { recursive: true, force: true });
  if (needsElectronNativeModule) {
    const restoreCode = await restoreNodeNativeModule();
    if (restoreCode !== 0) process.exitCode = restoreCode;
  }
}
