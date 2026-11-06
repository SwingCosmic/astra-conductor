import { build } from "esbuild";
await build({
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
await build({
  entryPoints: ["src/renderer.ts"],
  outfile: "renderer/app.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome130",
});
