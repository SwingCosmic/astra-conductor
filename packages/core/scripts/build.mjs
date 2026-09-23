import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(packageRoot, "src");
const outputRoot = path.join(packageRoot, "dist");

async function sourceEntries(directory) {
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) {
      entries.push(...(await sourceEntries(absolute)));
    } else if (item.name.endsWith(".ts") && !item.name.endsWith(".test.ts")) {
      entries.push(absolute);
    }
  }
  return entries;
}

await rm(outputRoot, { recursive: true, force: true });

await build({
  absWorkingDir: packageRoot,
  tsconfig: path.join(packageRoot, "tsconfig.json"),
  entryPoints: await sourceEntries(sourceRoot),
  outbase: sourceRoot,
  outdir: outputRoot,
  bundle: true,
  entryNames: "[dir]/[name]",
  format: "esm",
  platform: "node",
  target: "node18",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});

const vendorLicenseSource = path.join(sourceRoot, "vendor", "omniroute", "LICENSE");
const vendorLicenseOutput = path.join(outputRoot, "vendor", "omniroute", "LICENSE");
await mkdir(path.dirname(vendorLicenseOutput), { recursive: true });
await copyFile(vendorLicenseSource, vendorLicenseOutput);
