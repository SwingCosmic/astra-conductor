import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import electron from "electron";
import { startServer } from "../dist/platform/node/start-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.resolve(root, "../../packages/polyquota-ui");
const require = createRequire(path.join(ui, "package.json"));
const viteRoot = path.dirname(require.resolve("vite/package.json"));
const { createServer } = await import(pathToFileURL(path.join(viteRoot, "dist/node/index.js")));
const temporary = await mkdtemp(path.join(tmpdir(), "polyquota-protocol-"));
let backend;
let vite;
try {
  await build({
    entryPoints: [path.join(root, "test/protocol-smoke-entry.ts")],
    outfile: path.join(root, "dist/protocol-smoke.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  await build({
    entryPoints: [path.join(ui, "src/services/http-polyquota-service.ts")],
    outfile: path.join(root, "dist/protocol-client.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "ProtocolClient",
  });
  backend = await startServer({
    port: 0,
    dataDirectory: path.join(temporary, "node"),
    env: {},
    origins: ["http://127.0.0.1:5179"],
  });
  vite = await createServer({
    root: ui,
    configFile: path.join(ui, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 5179, strictPort: true },
    define: {
      "import.meta.env.VITE_POLYQUOTA_MODE": JSON.stringify("web"),
      "import.meta.env.VITE_POLYQUOTA_API_BASE": JSON.stringify(backend.url),
    },
  });
  await vite.listen();
  const url = vite.resolvedUrls.local[0];
  const child = spawn(electron, [path.join(root, "dist/protocol-smoke.mjs")], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      POLYQUOTA_PROTOCOL_DATA: path.join(temporary, "electron"),
      POLYQUOTA_PROTOCOL_VITE: url,
      POLYQUOTA_PROTOCOL_BACKEND: backend.url,
    },
  });
  const timeout = setTimeout(() => {
    console.error("Protocol smoke exceeded 60 seconds");
    child.kill();
  }, 60_000);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await vite?.close();
  await backend?.stop();
  if (!path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep))
    throw new Error("Unexpected temporary path");
  await rm(temporary, { recursive: true, force: true });
}
