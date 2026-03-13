"use strict";
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

function uint32BE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function createChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = crc32(Buffer.concat([typeBuffer, data]));
  return Buffer.concat([uint32BE(data.length), typeBuffer, data, uint32BE(crc)]);
}

function createPNG(width, height, pixelFn) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = createChunk("IHDR", ihdrData);

  const rowBytes = width * 4 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const off = y * rowBytes + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  const idat = createChunk("IDAT", zlib.deflateSync(raw));
  const iend = createChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

// CRC32
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function blend(bgR, bgG, bgB, bgA, fgR, fgG, fgB, fgA) {
  const a = fgA / 255;
  const ia = 1 - a;
  return [
    Math.round(fgR * a + bgR * ia),
    Math.round(fgG * a + bgG * ia),
    Math.round(fgB * a + bgB * ia),
    Math.min(255, Math.round(bgA + fgA * ia + fgA))
  ];
}

function drawIcon(x, y, w, h) {
  const cx = x / w;
  const cy = y / w;
  const s = w;
  const radius = 0.18;

  // Background: rounded rect
  const margin = 0.04;
  const nx = cx - 0.5;
  const ny = cy - 0.5;
  const halfSize = 0.5 - margin;
  const dx = Math.max(0, Math.abs(nx) - halfSize + radius);
  const dy = Math.max(0, Math.abs(ny) - halfSize + radius);
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist > radius) return [0, 0, 0, 0]; // outside rounded rect

  const edgeDist = radius - dist;
  let bgAlpha = Math.min(1, edgeDist * s * 1.2);

  // Gradient: top-left indigo to bottom-right violet
  const grad = (cx + cy) / 2;
  const bgR = Math.round(lerp(79, 124, grad));   // #4F46E5 -> #7C3AED
  const bgG = Math.round(lerp(70, 58, grad));
  const bgB = Math.round(lerp(229, 237, grad));

  let r = bgR, g = bgG, b = bgB, a = Math.round(bgAlpha * 255);

  // Viewfinder brackets (white)
  const bracketLen = 0.14;
  const bracketThick = 0.055;
  const bracketInset = 0.2;
  const bracketOuter = 0.5 - bracketInset;

  function inBracket(px, py) {
    const ax = Math.abs(px - 0.5);
    const ay = Math.abs(py - 0.5);
    const nearCornerX = ax > bracketOuter - bracketLen && ax < bracketOuter + bracketThick;
    const nearCornerY = ay > bracketOuter - bracketLen && ay < bracketOuter + bracketThick;
    const isHorizontal = ax < bracketOuter + bracketThick && ax > bracketOuter - bracketLen &&
                         ay > bracketOuter - bracketThick / 2 && ay < bracketOuter + bracketThick / 2;
    const isVertical = ay < bracketOuter + bracketThick && ay > bracketOuter - bracketLen &&
                       ax > bracketOuter - bracketThick / 2 && ax < bracketOuter + bracketThick / 2;
    return isHorizontal || isVertical;
  }

  if (inBracket(cx, cy)) {
    [r, g, b, a] = blend(r, g, b, a, 255, 255, 255, Math.round(bgAlpha * 240));
  }

  // Center circle (flash/lens)
  const centerDist = Math.sqrt((cx - 0.5) ** 2 + (cy - 0.5) ** 2);
  const circleR = 0.1;
  if (centerDist < circleR) {
    const circleAlpha = Math.min(1, (circleR - centerDist) * s * 1.5);
    [r, g, b, a] = blend(r, g, b, a, 255, 255, 255, Math.round(circleAlpha * bgAlpha * 200));
  }

  // Small dot (recording indicator) top-right
  const dotCx = 0.38;
  const dotCy = 0.26;
  const dotR = 0.04;
  const dotDist = Math.sqrt((cx - dotCx) ** 2 + (cy - dotCy) ** 2);
  if (dotDist < dotR) {
    const dotAlpha = Math.min(1, (dotR - dotDist) * s * 2);
    [r, g, b, a] = blend(r, g, b, a, 255, 100, 100, Math.round(dotAlpha * bgAlpha * 230));
  }

  return [r, g, b, a];
}

const sizes = [16, 48, 128];
const dir = path.resolve(__dirname);

for (const size of sizes) {
  const png = createPNG(size, size, (x, y, w, h) => drawIcon(x, y, w, h));
  const filepath = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(filepath, png);
  console.log(`Generated: ${filepath} (${png.length} bytes)`);
}

console.log("Done!");
