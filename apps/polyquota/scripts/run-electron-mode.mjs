import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (!new Set(["dev", "reset", "codex-cli-smoke"]).has(mode)) {
  throw new Error("Expected dev, reset, or codex-cli-smoke mode");
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron = (await import("electron")).default;
const temporaryUserData =
  mode === "codex-cli-smoke" ? await mkdtemp(path.join(tmpdir(), "llm-usage-live-")) : null;

const env = {
  ...process.env,
  ...(mode === "reset" ? { LLM_USAGE_RESET_DATA: "1" } : {}),
  ...(mode === "codex-cli-smoke" ? { LLM_USAGE_CODEX_CLI_SMOKE: "1" } : {}),
  ...(temporaryUserData ? { LLM_USAGE_USER_DATA: temporaryUserData } : {}),
};

try {
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
}
