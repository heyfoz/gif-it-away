#!/usr/bin/env node
// Draws the app icon as a .iconset of PNGs, for iconutil to turn into an .icns.
//
// Written out by hand rather than shipping a binary or pulling in a dependency:
// a PNG is a zlib stream in four chunks, and node already has zlib. Shapes are
// sampled 4x4 per pixel, which is what keeps the curves from stair-stepping at
// 16 and 32 across.
//
//   node mac/make-icon.mjs <output.iconset dir>

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ------------------------------------------------------------------- PNG */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // A filter byte leads every scanline; 0 means "store as is", which costs a
  // little size and saves writing four filters nothing here would benefit from.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ----------------------------------------------------------------- shapes */

/** Apple's rounded square is closer to a superellipse than to a rounded rect. */
function inSquircle(x, y, half, exponent = 5) {
  return Math.abs(x / half) ** exponent + Math.abs(y / half) ** exponent <= 1;
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const side = (x0, y0, x1, y1) => (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
  const d1 = side(ax, ay, bx, by);
  const d2 = side(bx, by, cx, cy);
  const d3 = side(cx, cy, ax, ay);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
}

const BLUE_TOP = [0x6f, 0xac, 0xff];
const BLUE_BOTTOM = [0x1b, 0x63, 0xdd];
const WHITE = [0xff, 0xff, 0xff];

/**
 * One sub-sample. Returns [r, g, b, a] for a point in 0..1 icon space.
 *
 * A blue rounded square, a white film cell across the middle with sprocket
 * holes above and below it, and a play triangle cut out of the cell. Three
 * shapes, because at 16 across anything more is mush.
 */
function sample(u, v) {
  const x = u - 0.5;
  const y = v - 0.5;

  // The bundle icon leaves a margin; 0.44 of half-width matches the system look.
  if (!inSquircle(x, y, 0.44)) return [0, 0, 0, 0];

  const cell = inRoundRect(u, v, 0.19, 0.325, 0.81, 0.675, 0.055);
  if (cell) {
    // Play triangle, cut back out of the white cell.
    if (inTriangle(u, v, 0.435, 0.415, 0.435, 0.585, 0.60, 0.5)) {
      return [...BLUE_BOTTOM, 255];
    }
    return [...WHITE, 255];
  }

  // Sprockets: four holes above the cell and four below.
  for (let i = 0; i < 4; i++) {
    const hx = 0.263 + i * 0.158;
    for (const hy of [0.245, 0.755]) {
      if (inRoundRect(u, v, hx - 0.038, hy - 0.032, hx + 0.038, hy + 0.032, 0.016)) {
        return [...WHITE, 235];
      }
    }
  }

  const t = (v - 0.06) / 0.88;
  const mix = Math.min(1, Math.max(0, t));
  return [
    Math.round(BLUE_TOP[0] + (BLUE_BOTTOM[0] - BLUE_TOP[0]) * mix),
    Math.round(BLUE_TOP[1] + (BLUE_BOTTOM[1] - BLUE_TOP[1]) * mix),
    Math.round(BLUE_TOP[2] + (BLUE_BOTTOM[2] - BLUE_TOP[2]) * mix),
    255,
  ];
}

function render(size) {
  const SS = 4; // sub-samples per axis
  const rgba = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sample(
            (px + (sx + 0.5) / SS) / size,
            (py + (sy + 0.5) / SS) / size,
          );
          // Weight colour by alpha so the edge does not darken towards black.
          const w = sa / 255;
          r += sr * w;
          g += sg * w;
          b += sb * w;
          a += sa;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const weight = alpha > 0 ? a / 255 : 1;
      const at = (py * size + px) * 4;
      rgba[at] = Math.round(r / weight);
      rgba[at + 1] = Math.round(g / weight);
      rgba[at + 2] = Math.round(b / weight);
      rgba[at + 3] = Math.round(alpha);
    }
  }
  return rgba;
}

const outDir = process.argv[2];
if (!outDir) {
  console.error('Where should the iconset go?');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// iconutil wants these exact names.
const WANTED = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];

const cache = new Map();
for (const [size, name] of WANTED) {
  if (!cache.has(size)) cache.set(size, encodePng(size, size, render(size)));
  writeFileSync(join(outDir, name), cache.get(size));
}
console.log(`wrote ${WANTED.length} png files to ${outDir}`);
