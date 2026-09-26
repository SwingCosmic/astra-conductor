import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const polyquotaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron = (await import("electron")).default;
const worker = path.join(polyquotaRoot, "scripts", "generate-icons-electron.mjs");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const code = await new Promise((resolve, reject) => {
  const child = spawn(electron, [worker], {
    cwd: polyquotaRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  child.once("error", reject);
  child.once("exit", (exitCode) => resolve(exitCode ?? 1));
});

process.exitCode = code;
