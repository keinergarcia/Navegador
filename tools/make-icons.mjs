#!/usr/bin/env node
// Genera los iconos PNG del panel sin dependencias externas.
// Uso: node tools/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "gateway", "web", "assets");

// --- CRC32 -----------------------------------------------------------------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Geometría (coordenadas normalizadas 0..1) -----------------------------
function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function gradient(t) {
  // #2dd4bf -> #38bdf8 -> #818cf8
  const stops = [
    [45, 212, 191],
    [56, 189, 248],
    [129, 140, 248],
  ];
  const pos = Math.min(0.999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  const a = stops[i];
  const b = stops[Math.min(stops.length - 1, i + 1)];
  return a.map((v, k) => Math.round(v + (b[k] - v) * f));
}

function render(size) {
  const SS = 4; // supersampling
  const rgba = Buffer.alloc(size * size * 4);
  const dark = [4, 33, 31];
  const screen = [11, 58, 66];

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bgHits = 0;
      let screenHits = 0;
      let innerHits = 0;
      let standHits = 0;
      let baseHits = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (insideRoundRect(x, y, 0.03, 0.03, 0.97, 0.97, 0.22)) bgHits += 1;
          if (insideRoundRect(x, y, 0.20, 0.20, 0.80, 0.54, 0.045)) screenHits += 1;
          if (insideRoundRect(x, y, 0.225, 0.225, 0.775, 0.515, 0.03)) innerHits += 1;
          if (insideRoundRect(x, y, 0.475, 0.54, 0.525, 0.72, 0.008)) standHits += 1;
          if (insideRoundRect(x, y, 0.36, 0.72, 0.64, 0.775, 0.02)) baseHits += 1;
        }
      }

      const total = SS * SS;
      const bgA = bgHits / total;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (bgA > 0) {
        const [gr, gg, gb] = gradient((px / size) * 0.55 + (py / size) * 0.55);
        r = gr;
        g = gg;
        b = gb;
        a = bgA;
      }

      const composite = (color, coverage) => {
        if (coverage <= 0) return;
        const alpha = coverage / total;
        const outA = alpha + a * (1 - alpha);
        if (outA === 0) return;
        r = Math.round((color[0] * alpha + r * a * (1 - alpha)) / outA);
        g = Math.round((color[1] * alpha + g * a * (1 - alpha)) / outA);
        b = Math.round((color[2] * alpha + b * a * (1 - alpha)) / outA);
        a = outA;
      };

      composite(dark, screenHits);
      composite(screen, innerHits);
      composite(dark, standHits);
      composite(dark, baseHits);

      const offset = (py * size + px) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = Math.round(a * 255);
    }
  }

  return encodePng(size, size, rgba);
}

mkdirSync(OUT, { recursive: true });
for (const size of [180, 192, 512]) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, render(size));
  process.stdout.write(`icono generado: ${file} (${size}x${size})\n`);
}
