import { app, BrowserWindow } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Keep the approved SVG unchanged; rasterize it with the bundled Chromium renderer.
const source = new URL("../../../docs/common/icon-design/graphagent.svg", import.meta.url);
const output = new URL("../assets/icons/", import.meta.url);
const sizes = [16, 20, 24, 32, 40, 48, 64, 256];

function createDib(size, rgba) {
  const pixelBytes = size * size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const dib = Buffer.alloc(40 + pixelBytes + maskStride * size);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(pixelBytes, 20);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4;
      const bottomY = size - y - 1;
      const to = 40 + (bottomY * size + x) * 4;
      dib[to] = rgba[from + 2];
      dib[to + 1] = rgba[from + 1];
      dib[to + 2] = rgba[from];
      dib[to + 3] = rgba[from + 3];
      if (rgba[from + 3] === 0) {
        dib[40 + pixelBytes + bottomY * maskStride + Math.floor(x / 8)] |= 0x80 >> x % 8;
      }
    }
  }
  return dib;
}

async function generate() {
  const svg = await readFile(source);
  await mkdir(output, { recursive: true });
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await window.loadURL("data:text/html,<html></html>");
    const rendered = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(`data:image/svg+xml;base64,${svg.toString("base64")}`)};
      await image.decode();
      return ${JSON.stringify(sizes)}.map(size => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, size, size);
        return {
          size,
          png: canvas.toDataURL("image/png").split(",")[1],
          rgba: Array.from(context.getImageData(0, 0, size, size).data),
        };
      });
    })()`);
    const header = Buffer.alloc(6 + sizes.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    const images = [];
    let offset = header.length;
    for (const [index, { size, png, rgba }] of rendered.entries()) {
      if (!rgba.some((value, i) => i % 4 === 3 && value > 0)) {
        throw new Error(`Empty ${size}px icon`);
      }
      const data = size === 256 ? Buffer.from(png, "base64") : createDib(size, rgba);
      const entry = 6 + index * 16;
      header[entry] = header[entry + 1] = size === 256 ? 0 : size;
      header.writeUInt16LE(1, entry + 4);
      header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(data.length, entry + 8);
      header.writeUInt32LE(offset, entry + 12);
      images.push(data);
      offset += data.length;
      if (size === 256) await writeFile(new URL("graphagent.png", output), data);
    }
    await writeFile(new URL("graphagent.ico", output), Buffer.concat([header, ...images]));
    await writeFile(new URL("graphagent.svg", output), svg);
    console.log(`Generated GraphAgent icons in ${fileURLToPath(output)}`);
  } finally {
    window.destroy();
  }
}

app.disableHardwareAcceleration();
app
  .whenReady()
  .then(generate)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
