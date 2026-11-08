import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const index = process.argv.indexOf("--publish");
if (index < 0 || !process.argv[index + 1])
  throw new Error("Expected --publish <self-contained broker directory>");
const root = await mkdtemp(path.join(os.tmpdir(), "astra-sharing-loop-"));
const product = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  (await import("electron")).default,
  [
    path.join(product, "test", "credential-sharing-loop-electron.mjs"),
    "--root",
    root,
    "--publish",
    path.resolve(process.argv[index + 1]),
    ...(process.argv.includes("--restart-export") ? ["--restart-export"] : []),
  ],
  { cwd: product, env, windowsHide: true, stdio: "inherit" },
);
console.log(`Isolated sharing loop: ${root}`);
const timer = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 600_000);
child.on("error", () => {
  clearTimeout(timer);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exitCode = code ?? 1;
});
