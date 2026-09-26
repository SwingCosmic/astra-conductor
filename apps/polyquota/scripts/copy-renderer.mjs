import { access, cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(desktopRoot, "../../packages/polyquota-ui/dist");
const target = path.join(desktopRoot, "renderer");

try {
  await access(source);
} catch {
  console.error(
    "packages/polyquota-ui/dist is missing. Run pnpm --filter @llm-usage/ui build first.",
  );
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
