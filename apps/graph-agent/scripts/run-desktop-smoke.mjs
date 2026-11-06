import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import electron from "electron";
const root = await mkdtemp(path.join(tmpdir(), "graph-desktop-smoke-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["test/desktop-smoke.mjs", "--root", root], {
  env,
  stdio: "inherit",
  windowsHide: true,
});
const timeout = setTimeout(() => {
  child.kill();
  console.error(`Desktop smoke timeout: ${root}`);
  process.exit(1);
}, 180_000);
child.on("error", () => {
  clearTimeout(timeout);
  process.exit(1);
});
child.on("exit", (code) => {
  clearTimeout(timeout);
  console.log(`GraphAgent desktop artifacts: ${root}`);
  process.exit(code ?? 1);
});
