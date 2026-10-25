import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode !== "web" && mode !== "demo") throw new Error("Expected web or demo");
const prepared = spawn(
  process.execPath,
  [process.env.npm_execpath, "--filter", "@astra-conductor/polyquota-contract", "build"],
  { stdio: "inherit", windowsHide: true },
);
const code = await new Promise((resolve, reject) => {
  prepared.once("error", reject);
  prepared.once("exit", resolve);
});
if (code !== 0) process.exit(Number(code ?? 1));
const child = spawn(
  process.execPath,
  [process.env.npm_execpath, "--filter", "@astra-conductor/polyquota-ui", "dev"],
  {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, VITE_POLYQUOTA_MODE: mode },
  },
);
child.once("error", () => {
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
