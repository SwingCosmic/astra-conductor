import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pnpmScript = process.env.npm_execpath;
if (!pnpmScript) throw new Error("Unable to locate the pnpm entrypoint");

const polyquotaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(polyquotaRoot, "release");
const unpackedOutput = path.join(releaseRoot, "win-unpacked");
if (path.dirname(unpackedOutput) !== releaseRoot) {
  throw new Error(`Refusing to clean unexpected package output: ${unpackedOutput}`);
}

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

await rm(unpackedOutput, { recursive: true, force: true });
process.exitCode = await run(["exec", "electron-builder", "--win", "nsis", "--publish", "never"]);
