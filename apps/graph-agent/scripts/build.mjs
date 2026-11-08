import { rm } from "node:fs/promises";
// Remove obsolete compiled business preload and flat entries from earlier builds.
for (const filename of [
  "main.js",
  "main.js.map",
  "preload.js",
  "preload.js.map",
  "preload.cjs",
  "renderer.js",
  "renderer.js.map",
  "runtime.js",
  "runtime.js.map",
  "import-service.js",
  "import-service.js.map",
  "contract.js",
  "contract.js.map",
])
  await rm(new URL(`../dist/${filename}`, import.meta.url), { force: true });
