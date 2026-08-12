import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const root = new URL("../", import.meta.url);
const src = new URL("src/", root);
const dist = new URL("dist/", root);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const browser of ["firefox", "chromium"]) {
  const target = new URL(`${browser}/`, dist);
  await cp(src, target, { recursive: true });
  const manifest = JSON.parse(
    await readFile(new URL(`manifests/${browser}.json`, root), "utf8"),
  );
  await writeFile(
    new URL("manifest.json", target),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await generateIcons(new URL("assets/icons/", target));
}

console.log("Built dist/firefox and dist/chromium");

async function generateIcons(directory) {
  await mkdir(directory, { recursive: true });
  for (const size of [16, 32, 48, 96, 128]) {
    const rgba = drawIcon(size);
    await writeFile(new URL(`icon-${size}.png`, directory), encodePng(size, rgba));
  }
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = size <= 48 ? 4 : 3;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let sampleY = 0; sampleY < samples; sampleY += 1) {
        for (let sampleX = 0; sampleX < samples; sampleX += 1) {
          const nx = (x + (sampleX + 0.5) / samples) / size;
          const ny = (y + (sampleY + 0.5) / samples) / size;
          const color = eggIconColor(nx, ny, size);
          const opacity = color[3] / 255;
          alpha += opacity;
          red += color[0] * opacity;
          green += color[1] * opacity;
          blue += color[2] * opacity;
        }
      }
      const sampleCount = samples * samples;
      setPixel(pixels, size, x, y, alpha === 0
        ? [0, 0, 0, 0]
        : [red / alpha, green / alpha, blue / alpha, 255 * alpha / sampleCount]);
    }
  }
  return pixels;
}

function eggIconColor(x, y, size) {
  const transparent = [0, 0, 0, 0];
  const badgeDistance = Math.hypot(x - 0.5, y - 0.5);
  if (badgeDistance > 0.47) return transparent;
  let color = badgeDistance > 0.445 ? [202, 189, 157, 255] : [238, 240, 222, 255];

  if (insideEgg(x, y, 0.235, 0.35)) color = [187, 132, 54, 255];
  if (insideEgg(x, y, 0.205, 0.318)) {
    color = x < 0.43 && y < 0.39 ? [255, 254, 247, 255] : [250, 231, 193, 255];
  }

  const leafPoint = rotatePoint(x - 0.72, y - 0.2, -0.72);
  if ((leafPoint.x / 0.12) ** 2 + (leafPoint.y / 0.062) ** 2 <= 1) {
    color = [112, 134, 86, 255];
  }

  const thickness = Math.max(0.012, 0.8 / size);
  const crack = [
    [0.5, 0.35, 0.46, 0.43],
    [0.46, 0.43, 0.52, 0.48],
    [0.52, 0.48, 0.48, 0.57],
    [0.46, 0.43, 0.4, 0.45],
    [0.52, 0.48, 0.59, 0.46],
  ];
  if (crack.some(([x1, y1, x2, y2]) => pointSegmentDistance(x, y, x1, y1, x2, y2) <= thickness)) {
    color = [176, 117, 42, 255];
  }
  return color;
}

function insideEgg(x, y, radiusX, radiusY) {
  const vertical = (y - 0.55) / radiusY;
  if (Math.abs(vertical) > 1) return false;
  const lowerWidth = 0.9 + 0.13 * ((vertical + 1) / 2);
  const halfWidth = radiusX * Math.sqrt(1 - vertical ** 2) * lowerWidth;
  return Math.abs(x - 0.5) <= halfWidth;
}

function rotatePoint(x, y, angle) {
  return {
    x: x * Math.cos(angle) - y * Math.sin(angle),
    y: x * Math.sin(angle) + y * Math.cos(angle),
  };
}

function pointSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function setPixel(buffer, width, x, y, color) {
  const offset = (y * width + x) * 4;
  buffer[offset] = Math.round(color[0]);
  buffer[offset + 1] = Math.round(color[1]);
  buffer[offset + 2] = Math.round(color[2]);
  buffer[offset + 3] = Math.round(color[3]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    rows[rowStart] = 0;
    rgba.copy(rows, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
