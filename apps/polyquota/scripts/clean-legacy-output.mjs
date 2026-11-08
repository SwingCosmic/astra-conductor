import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// TypeScript does not remove outputs for deleted sources. Do not distribute the
// retired business bridge when building over an existing checkout.
for (const filename of [
  "ipc.js",
  "ipc.js.map",
  "preload.cjs",
  "preload.cjs.map",
  ...[
    "main",
    "server-main",
    "polyquota-application-service",
    "polling-service",
    "refresh-scheduler",
    "sqlite-storage",
    "migrations",
    "safe-storage-cipher",
    "storage-smoke",
    "proxy-detection",
    "quota-chrome",
  ].flatMap((name) => [`${name}.js`, `${name}.js.map`]),
]) {
  await rm(fileURLToPath(new URL(`../dist/${filename}`, import.meta.url)), { force: true });
}
const output = fileURLToPath(new URL("../dist/", import.meta.url));
for (const directory of ["auth", "http", "runtime", "credential-sharing"]) {
  const target = fileURLToPath(new URL(`../dist/${directory}`, import.meta.url));
  if (!target.startsWith(output)) throw new Error("Unexpected legacy output path");
  await rm(target, { recursive: true, force: true });
}
