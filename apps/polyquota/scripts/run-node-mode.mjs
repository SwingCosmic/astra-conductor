import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let child;
let stopping = false;
let rebuilding = false;
let queued = false;
let debounce;

function exited(process) {
  return new Promise((resolve, reject) => {
    process.once("exit", (code) => resolve(code ?? 1));
    process.once("error", reject);
  });
}

function launch() {
  child = spawn(process.execPath, ["dist/server-main.js"], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    windowsHide: true,
    env: process.env,
  });
  child.once("error", () => {
    process.exitCode = 1;
    void stop();
  });
  child.once("exit", (code) => {
    if (!rebuilding && !stopping) {
      process.exitCode = code ?? 1;
      void stop();
    }
  });
}

async function stopChild() {
  const current = child;
  if (!current || current.exitCode !== null) return;
  const done = exited(current);
  if (current.connected) current.send({ type: "polyquota:dev-restart" });
  else current.kill("SIGTERM");
  await done;
}

async function rebuild() {
  queued = true;
  if (rebuilding || stopping) return;
  rebuilding = true;
  try {
    while (queued && !stopping) {
      queued = false;
      const build = spawn(process.execPath, [process.env.npm_execpath, "run", "build:main"], {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
      });
      if ((await exited(build)) !== 0) {
        console.error("Server rebuild failed; keeping the current runtime");
        continue;
      }
      await stopChild();
      if (!stopping) launch();
    }
  } catch {
    console.error("Server restart failed");
    process.exitCode = 1;
    await stop();
  } finally {
    rebuilding = false;
  }
}

const watcher = watch(path.join(root, "src"), { recursive: true }, (_event, filename) => {
  if (!filename?.toString().endsWith(".ts")) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => void rebuild(), 150);
});

async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(debounce);
  watcher.close();
  await stopChild();
}

watcher.once("error", () => {
  process.exitCode = 1;
  void stop();
});
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
launch();
