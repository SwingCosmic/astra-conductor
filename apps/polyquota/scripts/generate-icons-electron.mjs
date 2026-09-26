import { app, BrowserWindow } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const polyquotaRoot = path.resolve(scriptDir, "..");
const repositoryRoot = path.resolve(polyquotaRoot, "../..");
const sourceRoot = path.join(repositoryRoot, "docs", "common", "icon-design");
const outputRoot = path.join(polyquotaRoot, "assets", "icons");
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 256];
const variants = [
  "polyquota",
  "polyquota-green",
  "polyquota-orange",
  "polyquota-red",
  "polyquota-unknown",
];

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Generated icon is not a PNG image");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function createDibIconImage(size, bitmap) {
  const pixelBytes = size * size * 4;
  if (bitmap.length !== pixelBytes) {
    throw new Error(`Unexpected ${size}px bitmap size: ${bitmap.length}`);
  }
  const maskStride = Math.ceil(size / 32) * 4;
  const maskBytes = maskStride * size;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(pixelBytes, 20);

  const pixels = Buffer.alloc(pixelBytes);
  const mask = Buffer.alloc(maskBytes);
  for (let sourceY = 0; sourceY < size; sourceY += 1) {
    const targetY = size - sourceY - 1;
    const sourceOffset = sourceY * size * 4;
    const targetOffset = targetY * size * 4;
    bitmap.copy(pixels, targetOffset, sourceOffset, sourceOffset + size * 4);
    for (let x = 0; x < size; x += 1) {
      if (bitmap[sourceOffset + x * 4 + 3] === 0) {
        mask[targetY * maskStride + Math.floor(x / 8)] |= 0x80 >> x % 8;
      }
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

function createIco(images) {
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = headerSize;
  images.forEach(({ size, buffer }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(buffer.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += buffer.length;
  });
  return Buffer.concat([header, ...images.map(({ buffer }) => buffer)]);
}

async function renderSvg(window, source, size) {
  const svg = await readFile(source, "utf8");
  const imageUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const html = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><style>',
    `html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}`,
    `img{display:block;width:${size}px;height:${size}px}`,
    "</style></head>",
    `<body><img src="${imageUrl}"></body></html>`,
  ].join("");
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await delay(25);
  let image;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      image = await window.webContents.capturePage(
        { x: 0, y: 0, width: size, height: size },
        { stayHidden: true, stayAwake: true },
      );
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await delay(75 * attempt);
    }
  }
  if (!image) throw new Error(`Unable to render ${path.basename(source)} at ${size}px`);
  const png = image.toPNG();
  const dimensions = pngDimensions(png);
  if (dimensions.width !== size || dimensions.height !== size) {
    throw new Error(
      `Unexpected ${path.basename(source)} size: ${dimensions.width}x${dimensions.height}`,
    );
  }
  const bitmap = image.toBitmap();
  let transparentPixels = 0;
  let visiblePixels = 0;
  for (let index = 3; index < bitmap.length; index += 4) {
    const alpha = bitmap[index];
    if (alpha === 0) transparentPixels += 1;
    if (alpha > 0) visiblePixels += 1;
  }
  if (transparentPixels === 0 || visiblePixels === 0) {
    throw new Error(`${path.basename(source)} did not retain a transparent background`);
  }
  return { png, bitmap };
}

async function generate() {
  await mkdir(outputRoot, { recursive: true });
  const window = new BrowserWindow({
    show: false,
    width: 256,
    height: 256,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const manifest = { sources: {}, outputs: {} };
  try {
    for (const variant of variants) {
      const source = path.join(sourceRoot, `${variant}.svg`);
      const sourceContent = await readFile(source);
      manifest.sources[path.relative(repositoryRoot, source).replaceAll("\\", "/")] = createHash(
        "sha256",
      )
        .update(sourceContent)
        .digest("hex");
      const { png: master } = await renderSvg(window, source, 256);
      const masterName = `${variant}.png`;
      await writeFile(path.join(outputRoot, masterName), master);
      manifest.outputs[masterName] = createHash("sha256").update(master).digest("hex");
      for (const size of [16, 32]) {
        const { png: tray } = await renderSvg(window, source, size);
        const state = variant === "polyquota" ? "" : variant.slice("polyquota-".length);
        const trayName = `tray${state ? `-${state}` : ""}-${size}.png`;
        await writeFile(path.join(outputRoot, trayName), tray);
        manifest.outputs[trayName] = createHash("sha256").update(tray).digest("hex");
      }
    }
    const icoImages = [];
    const baseSource = path.join(sourceRoot, "polyquota.svg");
    for (const size of icoSizes) {
      const rendered = await renderSvg(window, baseSource, size);
      icoImages.push({
        size,
        buffer: size === 256 ? rendered.png : createDibIconImage(size, rendered.bitmap),
      });
    }
    const ico = createIco(icoImages);
    await writeFile(path.join(outputRoot, "polyquota.ico"), ico);
    manifest.outputs["polyquota.ico"] = createHash("sha256").update(ico).digest("hex");
    const expandedSizes = `"icoSizes": [\n${icoSizes.map((size) => `    ${size}`).join(",\n")}\n  ]`;
    const manifestJson = JSON.stringify({ icoSizes, ...manifest }, null, 2).replace(
      expandedSizes,
      `"icoSizes": [${icoSizes.join(", ")}]`,
    );
    await writeFile(path.join(outputRoot, "manifest.json"), `${manifestJson}\n`);
  } finally {
    window.destroy();
  }
}

app
  .whenReady()
  .then(generate)
  .then(() => {
    console.log(`Generated PolyQuota icons in ${outputRoot}`);
    app.quit();
  })
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    app.exit(1);
  });
