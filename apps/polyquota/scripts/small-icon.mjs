// Geometry is expressed in output pixels, so margins do not shrink with the icon.
export function createSmallIconSvg(source, size) {
  if (!Number.isInteger(size) || size < 16 || size > 24) {
    throw new RangeError("Small icons support integer sizes from 16 to 24 pixels");
  }
  const color = source.match(/stroke="(#[A-Fa-f0-9]+)"/)[1];
  const colors = [...source.matchAll(/<rect[^>]+fill="(#[A-Fa-f0-9]+)"/g)].map((match) => match[1]);
  const scale = size / 64;
  const side = Math.round(size / 2);
  const x = Math.floor((size - side) / 2);
  const y = Math.round(34.679 * scale - side / 2);
  // The one-pixel outer shell is the border; fills touch its inner edge with no padding.
  const barHeight = (side - 2) / 3;
  const bars = [0, 1, 2].map((index) => ({
    x: x + 1,
    y: y + 1 + index * barHeight,
    width: side - 2,
    height: barHeight,
  }));
  // Merge adjacent equal colors into one shape to avoid antialias seams.
  const runs = [];
  for (const [index, fill] of colors.entries()) {
    const previous = runs.at(-1);
    if (previous?.fill === fill) {
      previous.height += barHeight;
    } else {
      runs.push({ ...bars[index], fill });
    }
  }
  const rect = (bar, fill) =>
    `<rect x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" fill="${fill}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><mask id="card"><rect width="${size}" height="${size}" fill="white"/>${colors.length ? "" : rect({ ...bars[0], height: side - 2 }, "black")}</mask></defs>
  <g mask="url(#card)">
  <g fill="none" stroke="${color}" stroke-width="1" stroke-linecap="round">
    <circle cx="${size / 2}" cy="${34.679 * scale}" r="${25.992 * scale}"/>
    <path d="M${size / 2} ${8.687 * scale}V${34.679 * scale}M${9.4907 * scale} ${47.675 * scale} ${size / 2} ${34.679 * scale}M${54.5093 * scale} ${47.675 * scale} ${size / 2} ${34.679 * scale}"/>
  </g>
  <g fill="${color}">
    <circle cx="${size / 2}" cy="${8.687 * scale}" r="${5.2 * scale}"/>
    <circle cx="${9.4907 * scale}" cy="${47.675 * scale}" r="${5.2 * scale}"/>
    <circle cx="${54.5093 * scale}" cy="${47.675 * scale}" r="${5.2 * scale}"/>
    <rect x="${x}" y="${y}" width="${side}" height="${side}" rx="1" fill="${color}" data-border-width="1"/>
  </g>
  </g>
${colors.length ? runs.map((bar) => rect(bar, bar.fill)).join("\n  ") : ""}
</svg>\n`;
}
