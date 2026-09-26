import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const polyquotaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(polyquotaRoot, "../..");
const iconRoot = path.join(polyquotaRoot, "assets", "icons");

interface IconManifest {
  icoSizes: number[];
  sources: Record<string, string>;
  outputs: Record<string, string>;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function pngDimensions(filename: string): { width: number; height: number } {
  const png = readFileSync(path.join(iconRoot, filename));
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("PolyQuota icon assets", () => {
  it("keeps generated assets synchronized with the final SVG sources", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(iconRoot, "manifest.json"), "utf8"),
    ) as IconManifest;
    expect(manifest.icoSizes).toEqual([16, 20, 24, 32, 40, 48, 64, 256]);
    for (const [relativeSource, expectedHash] of Object.entries(manifest.sources)) {
      expect(sha256(readFileSync(path.join(repositoryRoot, relativeSource)))).toBe(expectedHash);
    }
    for (const [filename, expectedHash] of Object.entries(manifest.outputs)) {
      expect(sha256(readFileSync(path.join(iconRoot, filename)))).toBe(expectedHash);
    }
  });

  it("contains a multi-size Windows icon and directly rendered tray images", () => {
    const ico = readFileSync(path.join(iconRoot, "polyquota.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const imageCount = ico.readUInt16LE(4);
    expect(imageCount).toBe(8);
    const sizes = Array.from({ length: imageCount }, (_, index) => {
      const encoded = ico.readUInt8(6 + index * 16);
      return encoded === 0 ? 256 : encoded;
    });
    expect(sizes).toEqual([16, 20, 24, 32, 40, 48, 64, 256]);
    for (let index = 0; index < imageCount; index += 1) {
      const size = sizes[index];
      const entry = 6 + index * 16;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      const image = ico.subarray(offset, offset + length);
      if (size === 256) {
        expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      } else {
        expect(image.readUInt32LE(0)).toBe(40);
        expect(image.readInt32LE(4)).toBe(size);
        expect(image.readInt32LE(8)).toBe(size * 2);
        expect(image.readUInt16LE(14)).toBe(32);
      }
    }
    expect(pngDimensions("polyquota.png")).toEqual({ width: 256, height: 256 });
    expect(pngDimensions("tray-16.png")).toEqual({ width: 16, height: 16 });
    expect(pngDimensions("tray-32.png")).toEqual({ width: 32, height: 32 });
  });

  it("wires the generated assets into Electron and electron-builder", () => {
    const main = readFileSync(path.join(polyquotaRoot, "src", "main.ts"), "utf8");
    const builder = readFileSync(path.join(polyquotaRoot, "electron-builder.yml"), "utf8");
    const packager = readFileSync(path.join(polyquotaRoot, "scripts", "package.mjs"), "utf8");
    expect(main).toContain('icon: loadProductIcon("polyquota.png")');
    expect(main).toContain('loadProductIcon("tray-16.png")');
    expect(main).toContain('loadProductIcon("tray-32.png")');
    expect(main).not.toContain("data:image/svg+xml");
    expect(builder).toContain("icon: assets/icons/polyquota.ico");
    expect(builder).toContain("installerIcon: assets/icons/polyquota.ico");
    expect(builder).toContain("uninstallerIcon: assets/icons/polyquota.ico");
    expect(builder).toContain("from: assets/icons");
    expect(packager).toContain('path.join(releaseRoot, "win-unpacked")');
    expect(packager).toContain("await rm(unpackedOutput, { recursive: true, force: true })");
  });
});
