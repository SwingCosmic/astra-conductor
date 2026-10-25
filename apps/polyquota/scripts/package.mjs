import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
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

const args = ["exec", "electron-builder", "--win", "nsis", "--publish", "never"];
if (process.platform === "win32" && process.arch === "x64") {
  // Reuse the workspace's pinned distribution rather than downloading it again.
  const require = createRequire(import.meta.url);
  const distribution = path.dirname((await import("electron")).default);
  const version = (await readFile(path.join(distribution, "version"), "utf8")).trim();
  if (version.replace(/^v/, "") !== require("electron/package.json").version)
    throw new Error("Installed Electron distribution does not match the pinned package");
  args.push(`--config.electronDist=${distribution}`);
}
await rm(unpackedOutput, { recursive: true, force: true });
process.exitCode = await run(args);
