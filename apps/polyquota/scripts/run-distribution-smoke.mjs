import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = path.join(root, "release", "win-unpacked");
const executable = path.join(unpacked, "PolyQuota.exe");
const archive = path.join(unpacked, "resources", "app.asar");
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const asar = appBuilderRequire("@electron/asar");
const entries = asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/"));
for (const filename of [
  "/dist/main.js",
  "/renderer/index.html",
  "/dist/platform/electron/protocol-adapter.js",
])
  if (!entries.includes(filename)) throw new Error(`Missing packaged entry: ${filename}`);
if (entries.some((entry) => /^\/dist\/(?:ipc\.|preload|protocol-)/.test(entry)))
  throw new Error("Legacy business bridge or test bundle was packaged");
await access(path.join(unpacked, "resources/lib/better-sqlite3/better_sqlite3.node"));
await access(path.join(unpacked, "resources/icons/polyquota.png"));

async function run(env, expected) {
  const child = spawn(executable, [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      POLYQUOTA_DEV_SERVER: "",
      POLYQUOTA_SMOKE: "",
      POLYQUOTA_DESKTOP_SMOKE: "",
      POLYQUOTA_DESKTOP_SMOKE_SCRIPT: path.join(root, "test", "desktop-smoke.js"),
      POLYQUOTA_STORAGE_SMOKE: "",
      POLYQUOTA_RESET_DATA: "",
      POLYQUOTA_CODEX_CLI_SMOKE: "",
      ...env,
    },
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 100_000) output = output.slice(-100_000);
    });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (
      code !== 0 ||
      !output.includes(expected) ||
      /SMOKE_FAILED|startup failed|shutdown failed/.test(output)
    )
      throw new Error(`Distribution verification failed (${code}):\n${output}`);
    console.log(expected);
  } finally {
    clearTimeout(timeout);
  }
}

const temporary = await mkdtemp(path.join(tmpdir(), "polyquota-distribution-"));
try {
  await run(
    { POLYQUOTA_USER_DATA: temporary, POLYQUOTA_STORAGE_SMOKE: "1" },
    "POLYQUOTA_STORAGE_SMOKE_OK",
  );
  await run(
    { POLYQUOTA_USER_DATA: temporary, POLYQUOTA_DESKTOP_SMOKE: "1" },
    "POLYQUOTA_DESKTOP_SMOKE_OK",
  );
  await run(
    { POLYQUOTA_USER_DATA: temporary, POLYQUOTA_STORAGE_SMOKE: "verify" },
    "POLYQUOTA_EXISTING_CIPHERTEXT_OK",
  );
  const previousData = process.env.POLYQUOTA_BASELINE_DATA;
  if (previousData) {
    const resolved = path.resolve(previousData);
    if (
      path.dirname(resolved) !== path.resolve(tmpdir()) ||
      !path.basename(resolved).startsWith("polyquota-upgrade-proof-")
    )
      throw new Error("Baseline must be an explicitly prepared temporary upgrade fixture");
    await run(
      { POLYQUOTA_USER_DATA: resolved, POLYQUOTA_STORAGE_SMOKE: "verify" },
      "POLYQUOTA_EXISTING_CIPHERTEXT_OK",
    );
    console.log("POLYQUOTA_PREVIOUS_BUILD_CIPHERTEXT_OK");
  }
  console.log("POLYQUOTA_DISTRIBUTION_SMOKE_OK");
} finally {
  if (path.dirname(temporary) !== path.resolve(tmpdir()))
    throw new Error("Unexpected temporary directory");
  await rm(temporary, { recursive: true, force: true });
}
