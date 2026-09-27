import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(desktopRoot, "src", "preload.ts")],
  outfile: path.join(desktopRoot, "dist", "preload.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});
