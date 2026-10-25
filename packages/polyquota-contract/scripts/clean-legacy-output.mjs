import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

for (const extension of ["js", "js.map", "d.ts", "d.ts.map"]) {
  await rm(fileURLToPath(new URL(`../dist/channels.${extension}`, import.meta.url)), {
    force: true,
  });
}
