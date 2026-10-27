'use strict';
// PNG decoder tests. A tiny encoder here produces every colour type / depth /
// filter combination so the decoder is checked against known pixels.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { decodePng, PngError } = require('../src/png');

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// rows: array of raw scanlines (already packed); filters: filter type per row.
function encodePng({ width, height, depth, colorType, rows, filters, palette, trns, interlace = 0 }) {
  const bpp = Math.max(1, ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType] * depth >> 3);
  const out = [];
  let prev = Buffer.alloc(rows[0].length);
  rows.forEach((row, y) => {
    const ft = filters[y % filters.length];
    const f = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let pred = 0;
      if (ft === 1) pred = a; else if (ft === 2) pred = b; else if (ft === 3) pred = (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      f[i] = (row[i] - pred) & 0xff;
    }
    out.push(Buffer.from([ft]), f);
    prev = row;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = colorType; ihdr[12] = interlace;
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (palette) chunks.push(chunk('PLTE', palette));
  if (trns) chunks.push(chunk('tRNS', trns));
  chunks.push(chunk('IDAT', zlib.deflateSync(Buffer.concat(out))), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

const W = 5, H = 4;
const pix = (x, y) => [(x * 50) & 0xff, (y * 60 + 7) & 0xff, (x * y * 31 + 100) & 0xff, (255 - x * 40) & 0xff];
const expectRgba = (fn) => { const o = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) o.push(...fn(x, y)); return o; };
const check = (png, expected) => {
  const img = decodePng(png);
  assert.deepStrictEqual([img.width, img.height], [W, H]);
  assert.deepStrictEqual(Array.from(img.data), expected);
};

test('RGBA 8-bit with every filter type', () => {
  const rows = []; for (let y = 0; y < H; y++) { const r = []; for (let x = 0; x < W; x++) r.push(...pix(x, y)); rows.push(Buffer.from(r)); }
  check(encodePng({ width: W, height: H, depth: 8, colorType: 6, rows, filters: [0, 1, 2, 3, 4] }), expectRgba(pix));
  check(encodePng({ width: W, height: H, depth: 8, colorType: 6, rows, filters: [4, 3] }), expectRgba(pix));
});

test('RGB 8-bit and 16-bit', () => {
  const rows8 = [], rows16 = [];
  for (let y = 0; y < H; y++) {
    const r8 = [], r16 = [];
    for (let x = 0; x < W; x++) { const [r, g, b] = pix(x, y); r8.push(r, g, b); r16.push(r, 0x12, g, 0x34, b, 0x56); }
    rows8.push(Buffer.from(r8)); rows16.push(Buffer.from(r16));
  }
  const exp = expectRgba((x, y) => [...pix(x, y).slice(0, 3), 255]);
  check(encodePng({ width: W, height: H, depth: 8, colorType: 2, rows: rows8, filters: [1, 4] }), exp);
  check(encodePng({ width: W, height: H, depth: 16, colorType: 2, rows: rows16, filters: [2, 3] }), exp);
});

test('grayscale 1-bit, 8-bit and gray+alpha', () => {
  // 1-bit: pixel (x,y) is white when (x+y) is odd; 5 pixels per row packed MSB first.
  const rows1 = []; for (let y = 0; y < H; y++) { let b = 0; for (let x = 0; x < W; x++) if ((x + y) & 1) b |= 0x80 >> x; rows1.push(Buffer.from([b])); }
  check(encodePng({ width: W, height: H, depth: 1, colorType: 0, rows: rows1, filters: [0, 1] }), expectRgba((x, y) => { const v = (x + y) & 1 ? 255 : 0; return [v, v, v, 255]; }));
  const rows8 = []; for (let y = 0; y < H; y++) rows8.push(Buffer.from(Array.from({ length: W }, (_, x) => x * 10 + y)));
  check(encodePng({ width: W, height: H, depth: 8, colorType: 0, rows: rows8, filters: [3] }), expectRgba((x, y) => [x * 10 + y, x * 10 + y, x * 10 + y, 255]));
  const rowsGa = []; for (let y = 0; y < H; y++) { const r = []; for (let x = 0; x < W; x++) r.push(x * 10 + y, 200 - x); rowsGa.push(Buffer.from(r)); }
  check(encodePng({ width: W, height: H, depth: 8, colorType: 4, rows: rowsGa, filters: [4] }), expectRgba((x, y) => [x * 10 + y, x * 10 + y, x * 10 + y, 200 - x]));
});

test('palette with transparency, 8-bit and 2-bit indexes', () => {
  const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
  const trns = Buffer.from([255, 128, 0]); // 4th entry defaults to opaque
  const idx = (x, y) => (x + y) & 3;
  const colors = [[255, 0, 0, 255], [0, 255, 0, 128], [0, 0, 255, 0], [9, 9, 9, 255]];
  const rows8 = []; for (let y = 0; y < H; y++) rows8.push(Buffer.from(Array.from({ length: W }, (_, x) => idx(x, y))));
  check(encodePng({ width: W, height: H, depth: 8, colorType: 3, rows: rows8, filters: [0], palette, trns }), expectRgba((x, y) => colors[idx(x, y)]));
  const rows2 = []; for (let y = 0; y < H; y++) { let b0 = 0, b1 = 0; for (let x = 0; x < W; x++) { const v = idx(x, y); if (x < 4) b0 |= v << (6 - 2 * x); else b1 |= v << 6; } rows2.push(Buffer.from([b0, b1])); }
  check(encodePng({ width: W, height: H, depth: 2, colorType: 3, rows: rows2, filters: [0], palette, trns }), expectRgba((x, y) => colors[idx(x, y)]));
});

test('rejects what it should', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all, definitely not, no sir')), PngError);
  const rows = [Buffer.from([1, 2, 3, 4])];
  const interlaced = encodePng({ width: 1, height: 1, depth: 8, colorType: 6, rows, filters: [0], interlace: 1 });
  assert.throws(() => decodePng(interlaced), /interlaced/);
  const ok = encodePng({ width: 1, height: 1, depth: 8, colorType: 6, rows, filters: [0] });
  assert.deepStrictEqual(Array.from(decodePng(ok).data), [1, 2, 3, 4]);
  assert.throws(() => decodePng(ok.subarray(0, ok.length - 20)), PngError);
});

test('the built-in delay screen decodes', () => {
  const img = decodePng(require('fs').readFileSync(require('path').join(__dirname, '../public/screen.png')));
  assert.deepStrictEqual([img.width, img.height], [1920, 1080]);
  assert.ok(img.data[3] === 255 && img.data[0] < 40, 'dark opaque corner');
});
