import { app, BrowserWindow, nativeImage } from "electron";
import { createSmallIconSvg } from "./small-icon.mjs";
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
    for (let x = 0; x < size; x += 1) {
      const sourceIndex = sourceOffset + x * 4;
      const targetIndex = targetOffset + x * 4;
      const alpha = bitmap[sourceIndex + 3];
      if (alpha === 0) {
        mask[targetY * maskStride + Math.floor(x / 8)] |= 0x80 >> x % 8;
        continue;
      }
      if (alpha === 255) {
        bitmap.copy(pixels, targetIndex, sourceIndex, sourceIndex + 4);
        continue;
      }
      pixels[targetIndex] = Math.min(255, Math.round((bitmap[sourceIndex] * 255) / alpha));
      pixels[targetIndex + 1] = Math.min(255, Math.round((bitmap[sourceIndex + 1] * 255) / alpha));
      pixels[targetIndex + 2] = Math.min(255, Math.round((bitmap[sourceIndex + 2] * 255) / alpha));
      pixels[targetIndex + 3] = alpha;
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

function resizeIcon(png, size) {
  const image = nativeImage.createFromBuffer(png).resize({
    width: size,
    height: size,
    quality: "best",
  });
  const outPng = image.toPNG();
  const dimensions = pngDimensions(outPng);
  if (dimensions.width !== size || dimensions.height !== size) {
    throw new Error(`Unexpected resized icon size: ${dimensions.width}x${dimensions.height}`);
  }
  const bitmap = image.toBitmap();
  if (bitmap.length !== size * size * 4) {
    throw new Error(`Unexpected ${size}px bitmap size: ${bitmap.length}`);
  }
  return { png: outPng, bitmap };
}

async function renderSvg(window, source, size, options = {}) {
  const height = options.height ?? size;
  const transparent = options.transparent ?? true;
  const original = await readFile(source, "utf8");
  const svg = options.small ? createSmallIconSvg(original, size) : original;
  const imageUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const html = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><style>',
    `html,body{margin:0;width:${size}px;height:${height}px;overflow:hidden;background:transparent}`,
    `img{display:block;width:${size}px;height:${height}px}`,
    "</style></head>",
    `<body><img src="${imageUrl}"></body></html>`,
  ].join("");
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await window.webContents.executeJavaScript(
    "Promise.all([...document.images].map((image) => image.decode()))",
  );
  await delay(25);
  let image;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      image = await window.webContents.capturePage(
        { x: 0, y: 0, width: size, height },
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
  if (dimensions.width !== size || dimensions.height !== height) {
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
  if ((transparent && transparentPixels === 0) || visiblePixels === 0) {
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
    for (const source of [
      path.join(scriptDir, "small-icon.mjs"),
      path.join(sourceRoot, "polyquota-white.svg"),
    ]) {
      manifest.sources[path.relative(repositoryRoot, source).replaceAll("\\", "/")] = createHash(
        "sha256",
      )
        .update(await readFile(source))
        .digest("hex");
    }
    for (const variant of variants) {
      const source = path.join(sourceRoot, `${variant}.svg`);
      const sourceContent = await readFile(source);
      manifest.sources[path.relative(repositoryRoot, source).replaceAll("\\", "/")] = createHash(
        "sha256",
      )
        .update(sourceContent)
        .digest("hex");
      await writeFile(path.join(outputRoot, variant + ".svg"), sourceContent);
      manifest.outputs[variant + ".svg"] = createHash("sha256").update(sourceContent).digest("hex");
      const { png: master } = await renderSvg(window, source, 256);
      const masterName = `${variant}.png`;
      await writeFile(path.join(outputRoot, masterName), master);
      manifest.outputs[masterName] = createHash("sha256").update(master).digest("hex");
      // Other standalone PNG sizes are no longer exported: [16, 20, 32].
      for (const size of [24]) {
        const { png: tray } = await renderSvg(window, source, size, { small: true });
        const state = variant === "polyquota" ? "" : variant.slice("polyquota-".length);
        const trayName = `tray${state ? `-${state}` : ""}-${size}.png`;
        await writeFile(path.join(outputRoot, trayName), tray);
        manifest.outputs[trayName] = createHash("sha256").update(tray).digest("hex");
      }
    }
    const icoImages = [];
    const brandMaster = await readFile(path.join(outputRoot, "polyquota.png"));
    for (const size of icoSizes) {
      const rendered = size === 256 ? { png: brandMaster } : resizeIcon(brandMaster, size);
      icoImages.push({
        size,
        buffer: size === 256 ? rendered.png : createDibIconImage(size, rendered.bitmap),
      });
    }
    const ico = createIco(icoImages);
    await writeFile(path.join(outputRoot, "polyquota.ico"), ico);
    manifest.outputs["polyquota.ico"] = createHash("sha256").update(ico).digest("hex");
    // Optional review sheets and small SVG exports are disabled for the final asset set.
    // const reviewPath = path.join(sourceRoot, "product-family-review.svg");
    // let reviewSvg = await readFile(reviewPath, "utf8");
    // reviewSvg = reviewSvg.replace(
    // /    <!-- small-icons:start -->[\s\S]*?<!-- small-icons:end -->\n/g,
    // "",
    // );
    // const smallSymbols = [];
    // for (const variant of [...variants, "polyquota-white"]) {
    // const source = await readFile(path.join(sourceRoot, variant + ".svg"), "utf8");
    // const id = variant.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    // const regularBody = source
    // .slice(source.indexOf("</title>") + 8, source.lastIndexOf("</svg>"))
    // .trim();
    // reviewSvg = reviewSvg.replace(
    // new RegExp('    <symbol id="' + id + '"[\\s\\S]*?</symbol>'),
    // '    <symbol id="' + id + '" viewBox="0 0 64 64">\n' + regularBody + "\n    </symbol>",
    // );
    // for (const size of [16, 20, 24]) {
    // const small = createSmallIconSvg(source, size);
    // await writeFile(path.join(outputRoot, variant + "-" + size + ".svg"), small);
    // manifest.outputs[variant + "-" + size + ".svg"] = createHash("sha256")
    // .update(small)
    // .digest("hex");
    // const body = small
    // .replace(/<svg[^>]*>/, "")
    // .replace("</svg>", "")
    // .replaceAll('id="card"', 'id="card-' + id + size + '"')
    // .replaceAll("url(#card)", "url(#card-" + id + size + ")");
    // smallSymbols.push(
    // '<symbol id="' +
    // id +
    // "Small" +
    // size +
    // '" viewBox="0 0 ' +
    // size +
    // " " +
    // size +
    // '">' +
    // body +
    // "</symbol>",
    // );
    // }
    // }
    // const defsEnd = reviewSvg.indexOf('    <symbol id="graphagent"');
    // reviewSvg =
    // reviewSvg.slice(0, defsEnd) +
    // "    <!-- small-icons:start -->\n" +
    // smallSymbols.join("\n") +
    // "\n    <!-- small-icons:end -->\n" +
    // reviewSvg.slice(defsEnd);
    // reviewSvg = reviewSvg.replace(
    // /href="#(polyquota(?:White)?)(?:Small(?:16|20|24))?"([^>]*width="(16|20|24)"[^>]*)/g,
    // (_, id, attrs, size) => 'href="#' + id + "Small" + size + '"' + attrs,
    // );
    // await writeFile(reviewPath, reviewSvg);
    // window.setContentSize(1080, 1180);
    // const { png: review } = await renderSvg(
    // window,
    // path.join(sourceRoot, "product-family-review.svg"),
    // 1080,
    // 1180,
    // false,
    // );
    // await writeFile(path.join(sourceRoot, "product-family-review.png"), review);
    // const cells = [];
    // for (const [row, size] of [16, 20, 24].entries()) {
    // for (const [column, variant] of variants.entries()) {
    // const state = variant === "polyquota" ? "" : "-" + variant.slice("polyquota-".length);
    // const png = await readFile(path.join(outputRoot, "tray" + state + "-" + size + ".png"));
    // const url = "data:image/png;base64," + png.toString("base64");
    // const x = 30 + column * 150;
    // const y = 90 + row * 130;
    // cells.push(
    // '<text x="' +
    // x +
    // '" y="' +
    // y +
    // '" fill="#647087" font-size="12">' +
    // size +
    // "px / 4×</text>",
    // );
    // cells.push(
    // '<image href="' +
    // url +
    // '" x="' +
    // x +
    // '" y="' +
    // (y + 20) +
    // '" width="' +
    // size +
    // '" height="' +
    // size +
    // '"/>',
    // );
    // cells.push(
    // '<image href="' +
    // url +
    // '" x="' +
    // (x + 38) +
    // '" y="' +
    // (y + 14) +
    // '" width="' +
    // size * 4 +
    // '" height="' +
    // size * 4 +
    // '" style="image-rendering:pixelated"/>',
    // );
    // }
    // }
    // const smallReview =
    // '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480"><rect width="800" height="480" fill="#F3F5F9"/><g font-family="Segoe UI, Microsoft YaHei, sans-serif"><text x="30" y="30" font-size="20" fill="#172A43">PolyQuota · 超小图标实际像素预览</text>' +
    // ["默认", "绿色 3 条", "橙色 2 条", "红色 1 条", "未知"]
    // .map(
    // (label, index) =>
    // '<text x="' +
    // (30 + index * 150) +
    // '" y="60" font-size="14" fill="#172A43">' +
    // label +
    // "</text>",
    // )
    // .join("") +
    // cells.join("") +
    // "</g></svg>";
    // const smallReviewPath = path.join(sourceRoot, "polyquota-small-review.svg");
    // await writeFile(smallReviewPath, smallReview + "\n");
    // window.setContentSize(800, 480);
    // const { png: smallReviewPng } = await renderSvg(window, smallReviewPath, 800, 480, false);
    // await writeFile(path.join(sourceRoot, "polyquota-small-review.png"), smallReviewPng);
    const expandedSizes = `"icoSizes": [\n${icoSizes.map((size) => `    ${size}`).join(",\n")}\n  ]`;
    const manifestJson = JSON.stringify({ icoSizes, ...manifest }, null, 2).replace(
      expandedSizes,
      `"icoSizes": [${icoSizes.join(", ")}]`,
    );
    const fixtureRoot = path.join(polyquotaRoot, "test", "fixtures");
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(path.join(fixtureRoot, "icons-manifest.json"), `${manifestJson}\n`);
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
