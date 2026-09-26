import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coreRuntime } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|vue|js|mjs|cjs)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("core boundary", () => {
  it("stays on the node side of the desktop shell", () => {
    expect(coreRuntime).toBe("node");
  });

  it("keeps Electron and the OmniRoute reference checkout out of runtime code", () => {
    for (const packageDir of ["packages/core", "packages/polyquota-ui"]) {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, packageDir, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const declared = { ...manifest.dependencies, ...manifest.devDependencies };
      expect(declared.electron, packageDir).toBeUndefined();
      expect(
        Object.keys(declared).filter((name) => name.startsWith("@omniroute/")),
        packageDir,
      ).toEqual([]);

      for (const file of sourceFiles(path.join(repoRoot, packageDir, "src"))) {
        const text = readFileSync(file, "utf8");
        expect(text, file).not.toMatch(/["']electron["']/);
        expect(text, file).not.toMatch(/references\/omniroute/);
        if (packageDir === "packages/polyquota-ui") {
          expect(text, file).not.toMatch(/@omniroute\//);
        }
      }
    }
  });

  it("maps named OmniRoute aliases only to vendored source", () => {
    const coreTsconfig = JSON.parse(
      readFileSync(path.join(repoRoot, "packages/core/tsconfig.json"), "utf8"),
    ) as { compilerOptions?: { paths?: Record<string, string[]> } };

    expect(coreTsconfig.compilerOptions?.paths).toEqual({
      "@omniroute/open-sse/*": ["./src/vendor/omniroute/open-sse/*"],
      "@omniroute/src/*": ["./src/vendor/omniroute/src/*"],
    });

    const vendorRoot = path.join(repoRoot, "packages/core/src/vendor/omniroute");
    for (const file of sourceFiles(vendorRoot)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from\s+["']@\//);
    }
  });
});
