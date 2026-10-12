import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
      readFileSync(path.join(polyquotaRoot, "test", "fixtures", "icons-manifest.json"), "utf8"),
    ) as IconManifest;
    expect(readdirSync(iconRoot).sort()).toEqual(Object.keys(manifest.outputs).sort());
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
    expect(pngDimensions("tray-24.png")).toEqual({ width: 24, height: 24 });
  });

  it("wires the generated assets into Electron and electron-builder", () => {
    const main = readFileSync(path.join(polyquotaRoot, "src", "main.ts"), "utf8");
    const builder = readFileSync(path.join(polyquotaRoot, "electron-builder.yml"), "utf8");
    const packager = readFileSync(path.join(polyquotaRoot, "scripts", "package.mjs"), "utf8");
    expect(main).toContain(
      'icon: loadProductIcon(process.platform === "win32" ? "polyquota.ico" : "polyquota.png")',
    );
    const generator = readFileSync(
      path.join(polyquotaRoot, "scripts", "generate-icons-electron.mjs"),
      "utf8",
    );
    expect(generator).not.toContain("size <= 24 ? createSmallIconSvg");
    expect(generator).toContain("small: true");
    expect(generator).toContain("resizeIcon(brandMaster, size)");
    expect(main).toContain("loadTrayStatusIcon");
    expect(main).toContain("tray-24.png");
    expect(main).toContain("tray-unknown-24.png");
    expect(main).not.toContain("tray-16.png");
    expect(main).not.toContain("tray-32.png");
    const chrome = readFileSync(path.join(polyquotaRoot, "src", "quota-chrome.ts"), "utf8");
    expect(chrome).toContain("tray-green-24.png");
    expect(chrome).toContain("tray-orange-24.png");
    expect(chrome).toContain("tray-red-24.png");
    expect(chrome).toContain("tray-unknown-24.png");
    expect(main).not.toContain("data:image/svg+xml");
    expect(builder).toContain("icon: assets/icons/polyquota.ico");
    expect(builder).toContain("installerIcon: assets/icons/polyquota.ico");
    expect(builder).toContain("uninstallerIcon: assets/icons/polyquota.ico");
    expect(builder).toContain("from: assets/icons");
    expect(packager).toContain('path.join(releaseRoot, "win-unpacked")');
    expect(packager).toContain("await rm(unpackedOutput, { recursive: true, force: true })");
  });

  it("uses pixel geometry for 24px tray icons and preserves state colors", async () => {
    const { createSmallIconSvg } = (await import(
      path.join(polyquotaRoot, "scripts", "small-icon.mjs")
    )) as {
      createSmallIconSvg: (source: string, size: number) => string;
    };
    const states = [
      ["", ["#FFFFFF", "#FFFFFF", "#FFFFFF"]],
      ["-green", ["#168C4B", "#168C4B", "#168C4B"]],
      ["-orange", ["#FFFFFF", "#D97908", "#D97908"]],
      ["-red", ["#FFFFFF", "#FFFFFF", "#DA304B"]],
      ["-unknown", ["#6E7C8A", "#6E7C8A", "#6E7C8A"]],
    ] as const;
    for (const size of [16, 20, 24]) {
      for (const [state, colors] of states) {
        if (size === 24)
          expect(pngDimensions(`tray${state}-${size}.png`)).toEqual({
            width: size,
            height: size,
          });
        const svg = createSmallIconSvg(
          readFileSync(path.join(iconRoot, `polyquota${state}.svg`), "utf8"),
          size,
        );
        expect(svg).toContain('stroke-width="1"');
        const rects = [
          ...svg.matchAll(
            /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"([^>]*)\/>/g,
          ),
        ];
        const [outer, ...bars] = rects.map((match) => ({
          x: Number(match[1]),
          y: Number(match[2]),
          width: Number(match[3]),
          height: Number(match[4]),
          attributes: match[5],
        }));
        const runs: { color: string; count: number }[] = [];
        for (const color of colors) {
          const previous = runs.at(-1);
          if (previous?.color === color) previous.count += 1;
          else runs.push({ color, count: 1 });
        }
        expect(bars).toHaveLength(runs.length);
        expect(outer.attributes).toContain('fill="#164BDD"');
        expect(outer.attributes).toContain('data-border-width="1"');

        bars.forEach((bar, index) => {
          expect(bar.x - outer.x).toBe(1);
          expect(outer.width - bar.width).toBe(2);
          expect(bar.height).toBeGreaterThanOrEqual(1);
          expect(bar.attributes).not.toContain("rx=");
          expect(bar.attributes).toContain(`fill="${runs[index].color}"`);
          expect(bar.height).toBeCloseTo(((outer.height - 2) * runs[index].count) / 3);
          if (index > 0) {
            expect(bar.y - bars[index - 1].y - bars[index - 1].height).toBeCloseTo(0);
          }
        });
        expect(bars[0].y - outer.y).toBe(1);
        expect(outer.y + outer.height - bars.at(-1)!.y - bars.at(-1)!.height).toBeCloseTo(1);
      }
    }
  });
});
