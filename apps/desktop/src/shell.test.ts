import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "main.ts"),
  "utf8",
);

describe("desktop shell", () => {
  it("isolates the renderer and does not reference OmniRoute", () => {
    expect(mainSource).toContain("contextIsolation: true");
    expect(mainSource).toContain("nodeIntegration: false");
    expect(mainSource).toContain("sandbox: true");
    expect(mainSource).not.toMatch(/omniroute/i);
  });
});
