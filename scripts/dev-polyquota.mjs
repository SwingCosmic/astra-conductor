import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 5173;
const children = [];
let stopping = false;
const pnpmScript = process.env.npm_execpath;

if (!pnpmScript) {
  throw new Error("Unable to locate the pnpm entrypoint");
}

function run(args, extraEnv = {}) {
  const child = spawn(process.execPath, [pnpmScript, ...args], {
    cwd: root,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  return child;
}

async function stopAll() {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || !child.pid) {
        return;
      }
      if (process.platform === "win32") {
        await new Promise((resolve) => {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.once("exit", resolve);
          killer.once("error", resolve);
        });
      } else {
        child.kill("SIGTERM");
      }
    }),
  );
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

function assertPortAvailable(host, targetPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () =>
      reject(new Error(`dev server port ${host}:${targetPort} is already in use`)),
    );
    server.listen(targetPort, host, () => server.close(resolve));
  });
}

function exitCode(child) {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

process.on("SIGINT", () => {
  stopping = true;
  void stopAll().then(() => {
    process.exitCode = 130;
  });
});

const coreBuildCode = await exitCode(run(["--filter", "@astra-conductor/core", "run", "build"]));
if (coreBuildCode !== 0) {
  await stopAll();
  process.exitCode = coreBuildCode;
  process.exit();
}

let rendererReady = false;
await assertPortAvailable("127.0.0.1", port);
const vite = run([
  "--filter",
  "@astra-conductor/polyquota-ui",
  "exec",
  "vite",
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--strictPort",
]);

vite.once("exit", (code) => {
  if (rendererReady && !stopping) {
    console.error(`vite exited with code ${code ?? 1}`);
    void stopAll().then(() => {
      process.exitCode = code ?? 1;
    });
  }
});

try {
  await Promise.race([
    waitForPort("127.0.0.1", port),
    exitCode(vite).then((code) => {
      throw new Error(`vite exited early with code ${code}`);
    }),
  ]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stopping = true;
  await stopAll();
  process.exitCode = 1;
  process.exit();
}
rendererReady = true;

const compileCode = await exitCode(
  run(["--filter", "@astra-conductor/polyquota", "run", "build:main"]),
);
if (compileCode !== 0) {
  stopping = true;
  await stopAll();
  process.exitCode = compileCode;
  process.exit();
}

const electron = run(["--filter", "@astra-conductor/polyquota", "run", "dev:electron"], {
  POLYQUOTA_DEV_SERVER: `http://127.0.0.1:${port}`,
});

electron.once("exit", (code) => {
  stopping = true;
  void stopAll().then(() => {
    process.exitCode = code ?? 0;
  });
});
