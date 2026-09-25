import { spawn } from "node:child_process";

const pnpmScript = process.env.npm_execpath;
if (!pnpmScript) throw new Error("Unable to locate the pnpm entrypoint");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pnpmScript, ...args], {
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

process.exitCode = await run(["exec", "electron-builder", "--win", "nsis", "--publish", "never"]);
