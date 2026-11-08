import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import electron from "electron";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "polyquota-private-ui-"));
const bundle = path.join(root, "dist/private-ui-smoke.mjs");
try {
  await build({
    entryPoints: [path.join(root, "test/private-ui-smoke-entry.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  const child = spawn(electron, [bundle], {
    cwd: root,
    windowsHide: true,
    stdio: "inherit",
    env: { ...process.env, POLYQUOTA_PRIVATE_UI_DATA: temporary },
  });
  const timeout = setTimeout(() => {
    console.error("Private UI smoke exceeded 60 seconds");
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
  await rm(bundle, { force: true });
  if (!path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep))
    throw new Error("Unexpected temporary path");
  await rm(temporary, { recursive: true, force: true });
}
