'use strict';
// Minimal PNG decoder (Node's zlib does the inflating). Returns 8-bit RGBA.
// Supports every colour type and bit depth of a non-interlaced PNG, which is
// what image editors save by default. Used for the delay screen.
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

class PngError extends Error {}

function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new PngError('not a PNG file');
  let off = 8;
  let hdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (data.length !== len) throw new PngError('truncated PNG');
    off += 12 + len; // length + type + data + crc (not verified)
    if (type === 'IHDR') {
      hdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9],
        compression: data[10], filter: data[11], interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!hdr) throw new PngError('PNG has no header');
  const { width, height, depth, colorType } = hdr;
  if (!(colorType in CHANNELS) || ![1, 2, 4, 8, 16].includes(depth)) throw new PngError('unsupported PNG format');
  if (hdr.interlace) throw new PngError('interlaced PNGs are not supported; save it again without interlacing');
  if (hdr.compression || hdr.filter) throw new PngError('unsupported PNG compression');
  if (!width || !height || width > 8192 || height > 8192) throw new PngError('PNG size must be between 1x1 and 8192x8192');
  if (colorType === 3 && !palette) throw new PngError('paletted PNG without a palette');

  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil(width * bitsPerPixel / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3); // bytes per complete pixel, for filtering
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { throw new PngError('PNG image data is corrupt'); }
  if (raw.length < (stride + 1) * height) throw new PngError('PNG image data is incomplete');

  // Undo the per-scanline filters.
  const px = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const line = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      switch (ft) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; break; }
        default: throw new PngError(`bad PNG filter ${ft}`);
      }
      line[i] = v & 0xff;
    }
    prev = line;
  }

  // Expand to RGBA.
  const out = new Uint8Array(width * height * 4);
  const maxv = (1 << depth) - 1;
  const trnsGray = trns && colorType === 0 ? trns.readUInt16BE(0) : -1;
  const trnsRgb = trns && colorType === 2 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  for (let y = 0; y < height; y++) {
    const line = px.subarray(y * stride, (y + 1) * stride);
    // Sample `i` of the row as 8 bits (palette indexes are returned as-is).
    const sample = (i) => {
      if (depth === 8) return line[i];
      if (depth === 16) return line[i * 2]; // high byte is the 8-bit value
      const bit = i * depth;
      return (line[bit >> 3] >> (8 - depth - (bit & 7))) & maxv;
    };
    const sample16 = (i) => (depth === 16 ? line.readUInt16BE(i * 2) : sample(i));
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r, g, b, a = 255;
      if (colorType === 0) {
        const v = sample(x);
        r = g = b = depth < 8 ? Math.round(v * 255 / maxv) : v;
        if (trnsGray >= 0 && sample16(x) === trnsGray) a = 0;
      } else if (colorType === 2) {
        r = sample(x * 3); g = sample(x * 3 + 1); b = sample(x * 3 + 2);
        if (trnsRgb && sample16(x * 3) === trnsRgb[0] && sample16(x * 3 + 1) === trnsRgb[1] && sample16(x * 3 + 2) === trnsRgb[2]) a = 0;
      } else if (colorType === 3) {
        const idx = sample(x);
        if (idx * 3 + 2 >= palette.length) throw new PngError('PNG palette index out of range');
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
        if (trns && idx < trns.length) a = trns[idx];
      } else if (colorType === 4) {
        r = g = b = sample(x * 2); a = sample(x * 2 + 1);
      } else {
        r = sample(x * 4); g = sample(x * 4 + 1); b = sample(x * 4 + 2); a = sample(x * 4 + 3);
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  return { width, height, data: out };
}

module.exports = { decodePng, PngError };
