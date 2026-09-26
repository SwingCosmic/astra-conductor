import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(desktopRoot, "dist");

await mkdir(distDir, { recursive: true });
await copyFile(path.join(desktopRoot, "src", "preload.cjs"), path.join(distDir, "preload.cjs"));
