import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (!new Set(["dev", "reset", "codex-cli-smoke", "ipc-smoke"]).has(mode)) {
  throw new Error("Expected dev, reset, codex-cli-smoke, or ipc-smoke mode");
}

const polyquotaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(polyquotaRoot, "src");
const electron = (await import("electron")).default;
const pnpmScript = process.env.npm_execpath;
const temporaryUserData =
  mode === "codex-cli-smoke" || mode === "ipc-smoke"
    ? await mkdtemp(path.join(tmpdir(), "polyquota-live-"))
    : null;

const env = {
  ...process.env,
  ...(mode === "reset" ? { POLYQUOTA_RESET_DATA: "1" } : {}),
  ...(mode === "codex-cli-smoke" ? { POLYQUOTA_CODEX_CLI_SMOKE: "1" } : {}),
  ...(mode === "ipc-smoke" ? { POLYQUOTA_IPC_SMOKE: "1" } : {}),
  ...(temporaryUserData ? { POLYQUOTA_USER_DATA: temporaryUserData } : {}),
};

function spawnElectron(withIpc = false) {
  return spawn(electron, ["."], {
    cwd: polyquotaRoot,
    env,
    stdio: withIpc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
    windowsHide: true,
    shell: false,
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
}

function runBuild() {
  if (!pnpmScript) throw new Error("Unable to locate the pnpm entrypoint");
  const child = spawn(process.execPath, [pnpmScript, "run", "build:main"], {
    cwd: polyquotaRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  return waitForExit(child);
}

async function runDevelopmentSupervisor() {
  let electronChild = null;
  let expectedExit = false;
  let stopping = false;
  let rebuilding = false;
  let rebuildQueued = false;
  let debounceTimer = null;

  const sourceWatcher = watch(sourceRoot, { recursive: true }, (_eventType, filename) => {
    const relativePath = filename?.toString().replaceAll("\\", "/") ?? "";
    if (!relativePath.endsWith(".ts")) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void rebuildAndRestart(), 150);
  });

  function launchElectron() {
    const child = spawnElectron(true);
    electronChild = child;
    child.once("exit", (exitCode) => {
      if (electronChild === child) electronChild = null;
      if (expectedExit || stopping) return;
      stopping = true;
      sourceWatcher.close();
      process.exitCode = exitCode ?? 1;
    });
    child.once("error", (error) => {
      console.error("Unable to start Electron", error);
      if (electronChild === child) electronChild = null;
      stopping = true;
      sourceWatcher.close();
      process.exitCode = 1;
    });
  }

  async function stopElectronForRestart() {
    const child = electronChild;
    if (!child || child.exitCode !== null) return;
    expectedExit = true;
    if (!child.connected) throw new Error("Electron development IPC channel is unavailable");
    child.send({ type: "polyquota:dev-restart" });
    await waitForExit(child);
    expectedExit = false;
  }

  async function rebuildAndRestart() {
    rebuildQueued = true;
    if (rebuilding || stopping) return;
    rebuilding = true;
    try {
      while (rebuildQueued && !stopping) {
        rebuildQueued = false;
        const buildCode = await runBuild();
        if (buildCode !== 0) {
          console.error(
            `Electron rebuild failed with code ${buildCode}; keeping the current instance`,
          );
          continue;
        }
        await stopElectronForRestart();
        if (!stopping) launchElectron();
      }
    } catch (error) {
      console.error(
        "Electron restart failed",
        error instanceof Error ? error.message : "unknown error",
      );
      stopping = true;
      sourceWatcher.close();
      process.exitCode = 1;
    } finally {
      rebuilding = false;
    }
  }

  async function stopSupervisor(exitCode) {
    if (stopping) return;
    stopping = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    sourceWatcher.close();
    const child = electronChild;
    if (child && child.exitCode === null && child.connected) {
      expectedExit = true;
      child.send({ type: "polyquota:dev-restart" });
      await waitForExit(child);
    }
    process.exitCode = exitCode;
  }

  sourceWatcher.once("error", (error) => {
    console.error("Electron source watcher failed", error);
    void stopSupervisor(1);
  });
  process.once("SIGINT", () => void stopSupervisor(130));
  process.once("SIGTERM", () => void stopSupervisor(143));
  launchElectron();
}

try {
  if (mode === "dev") {
    await runDevelopmentSupervisor();
  } else {
    process.exitCode = await waitForExit(spawnElectron());
  }
} finally {
  if (temporaryUserData) await rm(temporaryUserData, { recursive: true, force: true });
}
