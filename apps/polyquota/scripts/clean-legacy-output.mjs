import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// TypeScript does not remove outputs for deleted sources. Do not distribute the
// retired business bridge when building over an existing checkout.
for (const filename of ["ipc.js", "ipc.js.map", "preload.cjs", "preload.cjs.map"]) {
  await rm(fileURLToPath(new URL(`../dist/${filename}`, import.meta.url)), { force: true });
}
