import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 5173;
const children = [];

function run(args, extraEnv = {}) {
  const child = spawn("pnpm", args, {
    cwd: root,
    shell: true,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) {
      continue;
    }
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  }
}

function waitForPort(host, targetPort) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host, port: targetPort });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > 30_000) {
          reject(new Error(`dev server did not listen on ${host}:${targetPort}`));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function exitCode(child) {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

let rendererReady = false;
const vite = run([
  "--filter",
  "@llm-usage/ui",
  "exec",
  "vite",
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--strictPort",
]);

vite.once("exit", (code) => {
  if (!rendererReady) {
    console.error(`vite exited early with code ${code ?? 1}`);
    process.exit(code ?? 1);
  }
});

try {
  await waitForPort("127.0.0.1", port);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stopAll();
  process.exit(1);
}
rendererReady = true;

const compileCode = await exitCode(run(["--filter", "@llm-usage/desktop", "run", "build:main"]));
if (compileCode !== 0) {
  stopAll();
  process.exit(compileCode);
}

const electron = run(["--filter", "@llm-usage/desktop", "exec", "electron", "."], {
  LLM_USAGE_DEV_SERVER: `http://127.0.0.1:${port}`,
});

electron.once("exit", (code) => {
  stopAll();
  process.exit(code ?? 0);
});
