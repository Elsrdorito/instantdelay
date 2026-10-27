'use strict';
// A very small H.264 encoder, just enough to put a still picture into a running
// stream without re-encoding anything else:
//
//  - parses the stream's own SPS (from the AVC sequence header OBS sent),
//  - adds one extra PPS (CAVLC, deblocking on) that refers to that SPS, so the
//    encoder never has to match the stream's CABAC / 8x8 settings,
//  - encodes an IDR picture with Intra_16x16 macroblocks + CAVLC residuals
//    (I_PCM as a safety net for blocks whose levels would not fit),
//  - and emits "all skipped" P pictures, which are ~10 bytes each and repeat
//    the previous picture.
//
// Everything follows ITU-T H.264 (clauses 7, 8.3, 8.5, 8.6, 9.2); the VLC
// tables are the standard ones. Output is raw NAL units; the caller wraps them
// for FLV. Supports what OBS produces: 4:2:0, 8-bit, progressive, POC type 0/2.

class H264Error extends Error {}

// ------------------------------------------------------------------ bits

class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos >> 3];
      if (byte === undefined) throw new H264Error('SPS too short');
      v = (v * 2) + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  ue() {
    let zeros = 0;
    while (this.u(1) === 0) { if (++zeros > 31) throw new H264Error('bad Exp-Golomb code'); }
    return zeros ? (1 << zeros) - 1 + this.u(zeros) : 0;
  }
  se() { const k = this.ue(); return (k & 1) ? (k + 1) >> 1 : -(k >> 1); }
}

class BitWriter {
  constructor(size = 4096) { this.buf = Buffer.alloc(size); this.pos = 0; }
  _grow(bits) {
    if ((this.pos + bits + 7) >> 3 <= this.buf.length) return;
    const nb = Buffer.alloc(Math.max(this.buf.length * 2, ((this.pos + bits) >> 3) + 1024));
    this.buf.copy(nb, 0, 0, (this.pos + 7) >> 3);
    this.buf = nb;
  }
  u(n, v) {
    this._grow(n);
    for (let i = n - 1; i >= 0; i--) {
      if ((v / 2 ** i) & 1) this.buf[this.pos >> 3] |= 0x80 >> (this.pos & 7);
      this.pos++;
    }
  }
  ue(v) { const len = 32 - Math.clz32(v + 1); this.u(len - 1, 0); this.u(len, v + 1); }
  se(v) { this.ue(v > 0 ? 2 * v - 1 : -2 * v); }
  get byteAligned() { return (this.pos & 7) === 0; }
  align() { while (!this.byteAligned) this.u(1, 0); }
  bytes(arr) { this.align(); this._grow(arr.length * 8); for (let i = 0; i < arr.length; i++) this.buf[this.pos >> 3] = arr[i], this.pos += 8; }
  trailing() { this.u(1, 1); this.align(); }
  result() { return this.buf.subarray(0, (this.pos + 7) >> 3); }
}

// Remove / insert emulation prevention bytes (00 00 03).
function unescapeNal(nal) {
  const out = Buffer.alloc(nal.length);
  let n = 0, zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}
function escapeRbsp(rbsp) {
  const out = Buffer.alloc(rbsp.length + (rbsp.length >> 1) + 4);
  let n = 0, zeros = 0;
  for (let i = 0; i < rbsp.length; i++) {
    const b = rbsp[i];
    if (zeros >= 2 && b <= 3) { out[n++] = 3; zeros = 0; }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}
function nal(refIdc, type, rbsp) {
  return Buffer.concat([Buffer.from([(refIdc << 5) | type]), escapeRbsp(rbsp)]);
}

// ---------------------------------------------------------- parameter sets

// AVCDecoderConfigurationRecord -> { lengthSize, sps: [nal], pps: [nal] }
function parseAvcC(buf) {
  if (!buf || buf.length < 7 || buf[0] !== 1) throw new H264Error('not an AVC sequence header');
  const lengthSize = (buf[4] & 3) + 1;
  let off = 5;
  const read = (count) => {
    const list = [];
    for (let i = 0; i < count; i++) {
      const len = buf.readUInt16BE(off);
      list.push(buf.subarray(off + 2, off + 2 + len));
      off += 2 + len;
    }
    return list;
  };
  const sps = read(buf[off++] & 0x1f);
  const pps = read(buf[off++]);
  return { lengthSize, sps, pps, profile: buf[1], compat: buf[2], level: buf[3] };
}

// Same record with one PPS added (everything else byte-identical).
function avcCWithPps(buf, extraPps) {
  const { sps, pps } = parseAvcC(buf);
  const parts = [buf.subarray(0, 5), Buffer.from([0xe0 | sps.length])];
  for (const s of sps) { const l = Buffer.alloc(2); l.writeUInt16BE(s.length); parts.push(l, s); }
  parts.push(Buffer.from([pps.length + 1]));
  for (const p of [...pps, extraPps]) { const l = Buffer.alloc(2); l.writeUInt16BE(p.length); parts.push(l, p); }
  return Buffer.concat(parts);
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function parseSps(nalBuf) {
  if ((nalBuf[0] & 0x1f) !== 7) throw new H264Error('not an SPS');
  const r = new BitReader(unescapeNal(nalBuf.subarray(1)));
  const s = { profile: r.u(8), constraints: r.u(8), level: r.u(8), chromaFormat: 1, bitDepth: 8, scalingMatrix: false };
  s.spsId = r.ue();
  if (HIGH_PROFILES.has(s.profile)) {
    s.chromaFormat = r.ue();
    if (s.chromaFormat === 3) r.u(1); // separate_colour_plane_flag
    s.bitDepth = 8 + r.ue();
    r.ue(); // bit_depth_chroma_minus8
    r.u(1); // qpprime_y_zero_transform_bypass_flag
    if (r.u(1)) { // seq_scaling_matrix_present_flag
      s.scalingMatrix = true;
      for (let i = 0; i < (s.chromaFormat !== 3 ? 8 : 12); i++) {
        if (!r.u(1)) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next) next = (last + r.se() + 256) % 256;
          last = next || last;
        }
      }
    }
  }
  s.log2MaxFrameNum = r.ue() + 4;
  s.pocType = r.ue();
  if (s.pocType === 0) s.log2MaxPocLsb = r.ue() + 4;
  else if (s.pocType === 1) {
    r.u(1); r.se(); r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  s.numRefFrames = r.ue();
  r.u(1); // gaps_in_frame_num_value_allowed_flag
  s.mbW = r.ue() + 1;
  s.mbH = r.ue() + 1;
  s.frameMbsOnly = r.u(1);
  if (!s.frameMbsOnly) { r.u(1); s.mbH *= 2; }
  r.u(1); // direct_8x8_inference_flag
  s.crop = { left: 0, right: 0, top: 0, bottom: 0 };
  if (r.u(1)) {
    // Crop units for 4:2:0 progressive: 2 luma samples horizontally and vertically.
    const cx = s.chromaFormat === 1 || s.chromaFormat === 2 ? 2 : 1;
    const cy = (s.chromaFormat === 1 ? 2 : 1) * (s.frameMbsOnly ? 1 : 2);
    s.crop = { left: r.ue() * cx, right: r.ue() * cx, top: r.ue() * cy, bottom: r.ue() * cy };
  }
  s.codedWidth = s.mbW * 16;
  s.codedHeight = s.mbH * 16;
  s.width = s.codedWidth - s.crop.left - s.crop.right;
  s.height = s.codedHeight - s.crop.top - s.crop.bottom;
  return s;
}

function parsePpsId(nalBuf) {
  return new BitReader(unescapeNal(nalBuf.subarray(1))).ue();
}

// What we cannot encode for (the caller then falls back to repeating a keyframe).
function unsupportedReason(sps) {
  if (sps.chromaFormat !== 1) return 'chroma format is not 4:2:0';
  if (sps.bitDepth !== 8) return `${sps.bitDepth}-bit video`;
  if (!sps.frameMbsOnly) return 'interlaced video';
  if (sps.pocType === 1) return 'pic_order_cnt_type 1';
  if (sps.scalingMatrix) return 'custom quantization matrices';
  if (sps.numRefFrames < 1) return 'no reference frames';
  return null;
}

// Our PPS: CAVLC, no weighted prediction, deblocking controlled per slice.
function buildPps(ppsId, spsId) {
  const w = new BitWriter(16);
  w.ue(ppsId); w.ue(spsId);
  w.u(1, 0); // entropy_coding_mode_flag (CAVLC)
  w.u(1, 0); // bottom_field_pic_order_in_frame_present_flag
  w.ue(0); // num_slice_groups_minus1
  w.ue(0); w.ue(0); // num_ref_idx_l0/l1_default_active_minus1
  w.u(1, 0); w.u(2, 0); // weighted_pred_flag, weighted_bipred_idc
  w.se(0); w.se(0); // pic_init_qp_minus26, pic_init_qs_minus26
  w.se(0); // chroma_qp_index_offset
  w.u(1, 1); // deblocking_filter_control_present_flag
  w.u(1, 0); // constrained_intra_pred_flag
  w.u(1, 0); // redundant_pic_cnt_present_flag
  w.trailing();
  return nal(3, 8, w.result());
}

// ------------------------------------------------------------- VLC tables

// coeff_token: [table][4 * TotalCoeff + TrailingOnes] -> length / code (Table 9-5).
const COEFF_TOKEN_LEN = [
  [1, 0, 0, 0, 6, 2, 0, 0, 8, 6, 3, 0, 9, 8, 7, 5, 10, 9, 8, 6, 11, 10, 9, 7, 13, 11, 10, 8, 13, 13, 11, 9, 13, 13, 13, 10, 14, 14, 13, 11, 14, 14, 14, 13, 15, 15, 14, 14, 15, 15, 15, 14, 16, 15, 15, 15, 16, 16, 16, 15, 16, 16, 16, 16, 16, 16, 16, 16],
  [2, 0, 0, 0, 6, 2, 0, 0, 6, 5, 3, 0, 7, 6, 6, 4, 8, 6, 6, 4, 8, 7, 7, 5, 9, 8, 8, 6, 11, 9, 9, 6, 11, 11, 11, 7, 12, 11, 11, 9, 12, 12, 12, 11, 12, 12, 12, 11, 13, 13, 13, 12, 13, 13, 13, 13, 13, 14, 13, 13, 14, 14, 14, 13, 14, 14, 14, 14],
  [4, 0, 0, 0, 6, 4, 0, 0, 6, 5, 4, 0, 6, 5, 5, 4, 7, 5, 5, 4, 7, 5, 5, 4, 7, 6, 6, 4, 7, 6, 6, 4, 8, 7, 7, 5, 8, 8, 7, 6, 9, 8, 8, 7, 9, 9, 8, 8, 9, 9, 9, 8, 10, 9, 9, 9, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
  [6, 0, 0, 0, 6, 6, 0, 0, 6, 6, 6, 0, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6],
];
const COEFF_TOKEN_BITS = [
  [1, 0, 0, 0, 5, 1, 0, 0, 7, 4, 1, 0, 7, 6, 5, 3, 7, 6, 5, 3, 7, 6, 5, 4, 15, 6, 5, 4, 11, 14, 5, 4, 8, 10, 13, 4, 15, 14, 9, 4, 11, 10, 13, 12, 15, 14, 9, 12, 11, 10, 13, 8, 15, 1, 9, 12, 11, 14, 13, 8, 7, 10, 9, 12, 4, 6, 5, 8],
  [3, 0, 0, 0, 11, 2, 0, 0, 7, 7, 3, 0, 7, 10, 9, 5, 7, 6, 5, 4, 4, 6, 5, 6, 7, 6, 5, 8, 15, 6, 5, 4, 11, 14, 13, 4, 15, 10, 9, 4, 11, 14, 13, 12, 8, 10, 9, 8, 15, 14, 13, 12, 11, 10, 9, 12, 7, 11, 6, 8, 9, 8, 10, 1, 7, 6, 5, 4],
  [15, 0, 0, 0, 15, 14, 0, 0, 11, 15, 13, 0, 8, 12, 14, 12, 15, 10, 11, 11, 11, 8, 9, 10, 9, 14, 13, 9, 8, 10, 9, 8, 15, 14, 13, 13, 11, 14, 10, 12, 15, 10, 13, 12, 11, 14, 9, 12, 8, 10, 13, 8, 13, 7, 9, 12, 9, 12, 11, 10, 5, 8, 7, 6, 1, 4, 3, 2],
  [3, 0, 0, 0, 0, 1, 0, 0, 4, 5, 6, 0, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63],
];
// Chroma DC (nC == -1): [4 * TotalCoeff + TrailingOnes].
const CHROMA_DC_TOKEN_LEN = [2, 0, 0, 0, 6, 1, 0, 0, 6, 6, 3, 0, 6, 7, 7, 6, 6, 8, 8, 7];
const CHROMA_DC_TOKEN_BITS = [1, 0, 0, 0, 7, 1, 0, 0, 4, 6, 1, 0, 3, 3, 2, 5, 2, 3, 2, 0];
// total_zeros: [TotalCoeff - 1][total_zeros] (Tables 9-7, 9-8, 9-9a).
const TOTAL_ZEROS_LEN = [
  [1, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 9], [3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 6, 6, 6, 6], [4, 3, 3, 3, 4, 4, 3, 3, 4, 5, 5, 6, 5, 6],
  [5, 3, 4, 4, 3, 3, 3, 4, 3, 4, 5, 5, 5], [4, 4, 4, 3, 3, 3, 3, 3, 4, 5, 4, 5], [6, 5, 3, 3, 3, 3, 3, 3, 4, 3, 6], [6, 5, 3, 3, 3, 2, 3, 4, 3, 6],
  [6, 4, 5, 3, 2, 2, 3, 3, 6], [6, 6, 4, 2, 2, 3, 2, 5], [5, 5, 3, 2, 2, 2, 4], [4, 4, 3, 3, 1, 3], [4, 4, 2, 1, 3], [3, 3, 1, 2], [2, 2, 1], [1, 1],
];
const TOTAL_ZEROS_BITS = [
  [1, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 1], [7, 6, 5, 4, 3, 5, 4, 3, 2, 3, 2, 3, 2, 1, 0], [5, 7, 6, 5, 4, 3, 4, 3, 2, 3, 2, 1, 1, 0],
  [3, 7, 5, 4, 6, 5, 4, 3, 3, 2, 2, 1, 0], [5, 4, 3, 7, 6, 5, 4, 3, 2, 1, 1, 0], [1, 1, 7, 6, 5, 4, 3, 2, 1, 1, 0], [1, 1, 5, 4, 3, 3, 2, 1, 1, 0],
  [1, 1, 1, 3, 3, 2, 2, 1, 0], [1, 0, 1, 3, 2, 1, 1, 1], [1, 0, 1, 3, 2, 1, 1], [0, 1, 1, 2, 1, 3], [0, 1, 1, 1, 1], [0, 1, 1, 1], [0, 1, 1], [0, 1],
];
const CHROMA_DC_TOTAL_ZEROS_LEN = [[1, 2, 3, 3], [1, 2, 2], [1, 1]];
const CHROMA_DC_TOTAL_ZEROS_BITS = [[1, 1, 1, 0], [1, 1, 0], [1, 0]];
// run_before: [min(zerosLeft, 7) - 1][run_before] (Table 9-10).
const RUN_LEN = [[1, 1], [1, 2, 2], [2, 2, 2, 2], [2, 2, 2, 3, 3], [2, 2, 3, 3, 3, 3], [2, 3, 3, 3, 3, 3, 3], [3, 3, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11]];
const RUN_BITS = [[1, 0], [1, 1, 0], [3, 2, 1, 0], [3, 2, 1, 1, 0], [3, 2, 3, 2, 1, 0], [3, 0, 1, 3, 2, 5, 4], [7, 6, 5, 4, 3, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1]];

// Writes one residual block (coefficients in scan order) with CAVLC (9.2).
function writeResidualBlock(w, coeffs, maxNumCoeff, nC) {
  let total = 0, last = -1;
  for (let i = 0; i < maxNumCoeff; i++) if (coeffs[i]) { total++; last = i; }
  let t1 = 0;
  for (let i = last; i >= 0 && t1 < 3; i--) {
    if (!coeffs[i]) continue;
    if (Math.abs(coeffs[i]) !== 1) break;
    t1++;
  }
  if (nC === -1) w.u(CHROMA_DC_TOKEN_LEN[4 * total + t1], CHROMA_DC_TOKEN_BITS[4 * total + t1]);
  else {
    const tab = nC < 2 ? 0 : nC < 4 ? 1 : nC < 8 ? 2 : 3;
    w.u(COEFF_TOKEN_LEN[tab][4 * total + t1], COEFF_TOKEN_BITS[tab][4 * total + t1]);
  }
  if (!total) return 0;

  // Levels, highest frequency first.
  const levels = [];
  for (let i = last; i >= 0; i--) if (coeffs[i]) levels.push(coeffs[i]);
  for (let i = 0; i < t1; i++) w.u(1, levels[i] < 0 ? 1 : 0);
  let suffixLength = total > 10 && t1 < 3 ? 1 : 0;
  for (let i = t1; i < total; i++) {
    const level = levels[i];
    let levelCode = level > 0 ? 2 * level - 2 : -2 * level - 1;
    if (i === t1 && t1 < 3) levelCode -= 2;
    if (suffixLength === 0) {
      if (levelCode < 14) w.u(levelCode + 1, 1);
      else if (levelCode < 30) { w.u(15, 1); w.u(4, levelCode - 14); }
      else writeEscape(w, levelCode - 30);
    } else if ((levelCode >> suffixLength) < 15) {
      w.u((levelCode >> suffixLength) + 1, 1);
      w.u(suffixLength, levelCode & ((1 << suffixLength) - 1));
    } else writeEscape(w, levelCode - (15 << suffixLength));
    if (suffixLength === 0) suffixLength = 1;
    if (Math.abs(level) > (3 << (suffixLength - 1)) && suffixLength < 6) suffixLength++;
  }

  if (total < maxNumCoeff) {
    const totalZeros = last + 1 - total;
    if (nC === -1) w.u(CHROMA_DC_TOTAL_ZEROS_LEN[total - 1][totalZeros], CHROMA_DC_TOTAL_ZEROS_BITS[total - 1][totalZeros]);
    else w.u(TOTAL_ZEROS_LEN[total - 1][totalZeros], TOTAL_ZEROS_BITS[total - 1][totalZeros]);
    let zerosLeft = totalZeros;
    let pos = last;
    for (let i = 0; i < total - 1 && zerosLeft > 0; i++) {
      let run = 0;
      for (pos--; pos >= 0 && !coeffs[pos]; pos--) run++;
      const row = Math.min(zerosLeft, 7) - 1;
      w.u(RUN_LEN[row][run], RUN_BITS[row][run]);
      zerosLeft -= run;
    }
  }
  return total;
}
// level_prefix 15 escape (12-bit suffix). Larger levels never happen: such
// macroblocks are coded as I_PCM instead.
function writeEscape(w, v) {
  if (v >= 4096) throw new H264Error('level too large');
  w.u(16, 1); w.u(12, v);
}

// -------------------------------------------------------- transform / quant

const ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
const CLASS = ZIGZAG.map(() => 0).map((_, p) => { const i = p >> 2, j = p & 3; return (i & 1) === 0 && (j & 1) === 0 ? 0 : (i & 1) && (j & 1) ? 1 : 2; });
const MF = [[13107, 5243, 8066], [11916, 4660, 7490], [10082, 4194, 6554], [9362, 3647, 5825], [8192, 3355, 5243], [7282, 2893, 4559]];
const VS = [[10, 16, 13], [11, 18, 14], [13, 20, 16], [14, 23, 18], [16, 25, 20], [18, 29, 23]];
const QPC = [29, 30, 31, 32, 32, 33, 34, 34, 35, 35, 36, 36, 37, 37, 37, 38, 38, 38, 39, 39, 39, 39];
const chromaQp = (qp) => (qp < 30 ? qp : QPC[qp - 30]);
// Luma 4x4 block order inside a macroblock (luma4x4BlkIdx -> x, y in 4-sample units).
const BLK_X = [0, 1, 0, 1, 2, 3, 2, 3, 0, 1, 0, 1, 2, 3, 2, 3];
const BLK_Y = [0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 3, 3];
const PCM_LEVEL_LIMIT = 2000;

// Forward 4x4 integer transform (8.5.12 inverse's counterpart), in place.
function fdct4(d) {
  for (let i = 0; i < 16; i += 4) {
    const a = d[i] + d[i + 3], b = d[i + 1] + d[i + 2], c = d[i + 1] - d[i + 2], e = d[i] - d[i + 3];
    d[i] = a + b; d[i + 1] = 2 * e + c; d[i + 2] = a - b; d[i + 3] = e - 2 * c;
  }
  for (let j = 0; j < 4; j++) {
    const a = d[j] + d[12 + j], b = d[4 + j] + d[8 + j], c = d[4 + j] - d[8 + j], e = d[j] - d[12 + j];
    d[j] = a + b; d[4 + j] = 2 * e + c; d[8 + j] = a - b; d[12 + j] = e - 2 * c;
  }
}
// Inverse 4x4 transform of dequantized coefficients -> residual (8.5.12.2).
function idct4(d) {
  for (let i = 0; i < 16; i += 4) {
    const e = d[i] + d[i + 2], f = d[i] - d[i + 2], g = (d[i + 1] >> 1) - d[i + 3], h = d[i + 1] + (d[i + 3] >> 1);
    d[i] = e + h; d[i + 1] = f + g; d[i + 2] = f - g; d[i + 3] = e - h;
  }
  for (let j = 0; j < 4; j++) {
    const e = d[j] + d[8 + j], f = d[j] - d[8 + j], g = (d[4 + j] >> 1) - d[12 + j], h = d[4 + j] + (d[12 + j] >> 1);
    d[j] = (e + h + 32) >> 6; d[4 + j] = (f + g + 32) >> 6; d[8 + j] = (f - g + 32) >> 6; d[12 + j] = (e - h + 32) >> 6;
  }
}
// 4x4 Hadamard (luma DC), in place, no scaling.
function hadamard4(d) {
  for (let i = 0; i < 16; i += 4) {
    const a = d[i] + d[i + 3], b = d[i + 1] + d[i + 2], c = d[i + 1] - d[i + 2], e = d[i] - d[i + 3];
    d[i] = a + b; d[i + 1] = e + c; d[i + 2] = a - b; d[i + 3] = e - c;
  }
  for (let j = 0; j < 4; j++) {
    const a = d[j] + d[12 + j], b = d[4 + j] + d[8 + j], c = d[4 + j] - d[8 + j], e = d[j] - d[12 + j];
    d[j] = a + b; d[4 + j] = e + c; d[8 + j] = a - b; d[12 + j] = e - c;
  }
}
function hadamard2(c) {
  return [c[0] + c[1] + c[2] + c[3], c[0] - c[1] + c[2] - c[3], c[0] + c[1] - c[2] - c[3], c[0] - c[1] - c[2] + c[3]];
}
const clip = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

class Quant {
  constructor(qp) {
    this.qp = qp;
    this.q6 = Math.floor(qp / 6);
    this.qm = qp % 6;
    this.qbits = 15 + this.q6;
    this.f = Math.floor((1 << this.qbits) / 3); // intra rounding
  }
  // AC / plain coefficient at raster position p.
  quant(w, p) {
    const a = Math.abs(w);
    const l = (a * MF[this.qm][CLASS[p]] + this.f) >> this.qbits;
    return w < 0 ? -l : l;
  }
  dequant(level, p) {
    const ls = 16 * VS[this.qm][CLASS[p]];
    return this.q6 >= 4 ? (level * ls) << (this.q6 - 4) : (level * ls + (1 << (3 - this.q6))) >> (4 - this.q6);
  }
  // Hadamard'ed DC coefficients. The decoder scales luma DC by 2^(qp/6-2) and
  // chroma DC by 2^(qp/6-1) (8.5.10 / 8.5.11.2), hence the extra shift here.
  quantDc(w, extraShift) {
    const a = Math.abs(w);
    const l = (a * MF[this.qm][0] + (this.f << extraShift)) >> (this.qbits + extraShift);
    return w < 0 ? -l : l;
  }
  dequantLumaDc(c) { // c = inverse-Hadamard'ed level (8.5.10)
    const ls = 16 * VS[this.qm][0];
    return this.q6 >= 6 ? (c * ls) << (this.q6 - 6) : (c * ls + (1 << (5 - this.q6))) >> (6 - this.q6);
  }
  dequantChromaDc(c) { // (8.5.11.2, 4:2:0)
    return ((c * 16 * VS[this.qm][0]) << this.q6) >> 5;
  }
}

// -------------------------------------------------------------- encoder

class ScreenEncoder {
  // avcC: the stream's AVC sequence header body (after the 5-byte FLV prefix).
  constructor(avcC, { qp = 22, deblock = true, pcmLimit = PCM_LEVEL_LIMIT } = {}) {
    this.deblock = deblock;
    this.pcmLimit = pcmLimit;
    const rec = parseAvcC(avcC);
    if (!rec.sps.length) throw new H264Error('sequence header has no SPS');
    this.sps = parseSps(rec.sps[0]);
    const why = unsupportedReason(this.sps);
    if (why) throw new H264Error(`cannot encode for this stream: ${why}`);
    const used = new Set(rec.pps.map(parsePpsId));
    this.ppsId = 0;
    while (used.has(this.ppsId)) this.ppsId++;
    if (this.ppsId > 255) throw new H264Error('no free PPS id');
    this.lengthSize = rec.lengthSize;
    this.qp = Math.max(10, Math.min(40, Math.round(qp)));
    this.pps = buildPps(this.ppsId, this.sps.spsId);
    this.avcC = avcCWithPps(avcC, this.pps);
    this.idrCount = 0;
  }

  get width() { return this.sps.width; }
  get height() { return this.sps.height; }
  get codedWidth() { return this.sps.codedWidth; }
  get codedHeight() { return this.sps.codedHeight; }

  // Wraps NAL units for an FLV AVC packet (length-prefixed).
  packNals(nals) {
    const parts = [];
    for (const n of nals) {
      const l = Buffer.alloc(this.lengthSize);
      l.writeUIntBE(n.length, 0, this.lengthSize);
      parts.push(l, n);
    }
    return Buffer.concat(parts);
  }

  _sliceHeaderCommon(w, isIdr, frameNum) {
    const s = this.sps;
    w.ue(0); // first_mb_in_slice
    w.ue(isIdr ? 7 : 5); // slice_type: I / P (all slices of the picture)
    w.ue(this.ppsId);
    w.u(s.log2MaxFrameNum, frameNum % (1 << s.log2MaxFrameNum));
    if (isIdr) w.ue(this.idrCount++ & 0xffff); // idr_pic_id
    if (s.pocType === 0) w.u(s.log2MaxPocLsb, (2 * frameNum) % (1 << s.log2MaxPocLsb));
  }

  // IDR picture of the given 4:2:0 planes (coded size). Returns the slice NAL.
  encodeIdr(planes) {
    const s = this.sps;
    const { y, u, v } = planes;
    if (y.length !== s.codedWidth * s.codedHeight) throw new H264Error('wrong plane size');
    const W = s.codedWidth, CW = W >> 1;
    const recY = new Uint8Array(y.length), recU = new Uint8Array(u.length), recV = new Uint8Array(v.length);
    const q = new Quant(this.qp), qc = new Quant(chromaQp(this.qp));
    const PCM_LEVEL_LIMIT = this.pcmLimit;
    const w = new BitWriter(1 << 16);
    this._sliceHeaderCommon(w, true, 0);
    w.u(1, 0); w.u(1, 0); // dec_ref_pic_marking: no_output_of_prior_pics, long_term_reference
    w.se(this.qp - 26); // slice_qp_delta
    w.ue(this.deblock ? 0 : 1); // disable_deblocking_filter_idc
    if (this.deblock) { w.se(0); w.se(0); } // default alpha/beta offsets

    // Non-zero coefficient counts per 4x4 block, for CAVLC's nC (luma: 4x4 per MB; chroma: 2x2 per MB per component).
    const nzY = new Uint8Array(s.mbW * 4 * s.mbH * 4);
    const nzU = new Uint8Array(s.mbW * 2 * s.mbH * 2);
    const nzV = new Uint8Array(s.mbW * 2 * s.mbH * 2);
    const nC = (arr, bw, bx, by, availL, availT) => {
      const a = availL ? arr[by * bw + bx - 1] : -1;
      const b = availT ? arr[(by - 1) * bw + bx] : -1;
      if (a >= 0 && b >= 0) return (a + b + 1) >> 1;
      return a >= 0 ? a : b >= 0 ? b : 0;
    };

    const orig = new Int32Array(256), pred = new Int32Array(256), res = new Int32Array(16);
    const origC = [new Int32Array(64), new Int32Array(64)], predC = [new Int32Array(64), new Int32Array(64)];
    for (let mby = 0; mby < s.mbH; mby++) {
      for (let mbx = 0; mbx < s.mbW; mbx++) {
        const availL = mbx > 0, availT = mby > 0;
        const px = mbx * 16, py = mby * 16;
        for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) orig[j * 16 + i] = y[(py + j) * W + px + i];
        for (let c = 0; c < 2; c++) {
          const plane = c ? v : u;
          for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) origC[c][j * 8 + i] = plane[((py >> 1) + j) * CW + (px >> 1) + i];
        }

        // --- luma: pick the Intra_16x16 prediction mode with the smallest SAD
        const lumaMode = predictLuma16(recY, W, px, py, availL, availT, orig, pred);
        // Transform + quantize all 16 blocks; keep the DC terms for the Hadamard.
        const ac = new Array(16); // per block: 15 AC levels in zigzag order
        const dc = new Int32Array(16); // raster by block position
        let anyAc = false, big = false;
        for (let b = 0; b < 16; b++) {
          const bx = BLK_X[b] * 4, by = BLK_Y[b] * 4;
          for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) res[j * 4 + i] = orig[(by + j) * 16 + bx + i] - pred[(by + j) * 16 + bx + i];
          fdct4(res);
          dc[BLK_Y[b] * 4 + BLK_X[b]] = res[0];
          const lv = new Int32Array(15);
          for (let k = 1; k < 16; k++) {
            const l = q.quant(res[ZIGZAG[k]], ZIGZAG[k]);
            lv[k - 1] = l;
            if (l) anyAc = true;
            if (Math.abs(l) > PCM_LEVEL_LIMIT) big = true;
          }
          ac[b] = lv;
        }
        hadamard4(dc);
        const dcLv = new Int32Array(16);
        for (let k = 0; k < 16; k++) { dcLv[k] = q.quantDc(dc[ZIGZAG[k]], 2); if (Math.abs(dcLv[k]) > PCM_LEVEL_LIMIT) big = true; }

        // --- chroma
        const chromaMode = predictChroma(recU, recV, CW, px >> 1, py >> 1, availL, availT, origC, predC);
        const cdcLv = [new Int32Array(4), new Int32Array(4)];
        const cac = [new Array(4), new Array(4)];
        let anyCdc = false, anyCac = false;
        for (let c = 0; c < 2; c++) {
          const cdc = new Int32Array(4);
          for (let b = 0; b < 4; b++) {
            const bx = (b & 1) * 4, by = (b >> 1) * 4;
            for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) res[j * 4 + i] = origC[c][(by + j) * 8 + bx + i] - predC[c][(by + j) * 8 + bx + i];
            fdct4(res);
            cdc[b] = res[0];
            const lv = new Int32Array(15);
            for (let k = 1; k < 16; k++) {
              const l = qc.quant(res[ZIGZAG[k]], ZIGZAG[k]);
              lv[k - 1] = l;
              if (l) anyCac = true;
              if (Math.abs(l) > PCM_LEVEL_LIMIT) big = true;
            }
            cac[c][b] = lv;
          }
          const h = hadamard2(cdc);
          for (let k = 0; k < 4; k++) { cdcLv[c][k] = qc.quantDc(h[k], 1); if (cdcLv[c][k]) anyCdc = true; if (Math.abs(cdcLv[c][k]) > PCM_LEVEL_LIMIT) big = true; }
        }

        if (big) {
          // I_PCM: raw samples, lossless, 384 bytes. Keeps every level within the VLC range.
          w.ue(25);
          w.align();
          const raw = [];
          for (let k = 0; k < 256; k++) raw.push(Math.max(1, orig[k]));
          for (let c = 0; c < 2; c++) for (let k = 0; k < 64; k++) raw.push(Math.max(1, origC[c][k]));
          w.bytes(raw);
          for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) recY[(py + j) * W + px + i] = Math.max(1, orig[j * 16 + i]);
          for (let c = 0; c < 2; c++) {
            const rec = c ? recV : recU;
            for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) rec[((py >> 1) + j) * CW + (px >> 1) + i] = Math.max(1, origC[c][j * 8 + i]);
          }
          for (let b = 0; b < 16; b++) nzY[(mby * 4 + BLK_Y[b]) * s.mbW * 4 + mbx * 4 + BLK_X[b]] = 16;
          for (let b = 0; b < 4; b++) { nzU[(mby * 2 + (b >> 1)) * s.mbW * 2 + mbx * 2 + (b & 1)] = 16; nzV[(mby * 2 + (b >> 1)) * s.mbW * 2 + mbx * 2 + (b & 1)] = 16; }
          continue;
        }

        const chromaCbp = anyCac ? 2 : anyCdc ? 1 : 0;
        const acFlag = anyAc ? 1 : 0;
        w.ue(1 + lumaMode + 4 * chromaCbp + 12 * acFlag); // mb_type I_16x16_<pred>_<chroma>_<luma>
        w.ue(chromaMode); // intra_chroma_pred_mode
        w.se(0); // mb_qp_delta

        // Residual: luma DC, luma AC (if any), chroma DC, chroma AC.
        const bw = s.mbW * 4;
        writeResidualBlock(w, dcLv, 16, nC(nzY, bw, mbx * 4, mby * 4, availL, availT));
        for (let b = 0; b < 16; b++) {
          const bx = mbx * 4 + BLK_X[b], by = mby * 4 + BLK_Y[b];
          let count = 0;
          if (acFlag) count = writeResidualBlock(w, ac[b], 15, nC(nzY, bw, bx, by, bx > 0, by > 0));
          nzY[by * bw + bx] = count;
        }
        if (chromaCbp >= 1) for (let c = 0; c < 2; c++) writeResidualBlock(w, cdcLv[c], 4, -1);
        for (let c = 0; c < 2; c++) {
          const nz = c ? nzV : nzU;
          const cbw = s.mbW * 2;
          for (let b = 0; b < 4; b++) {
            const bx = mbx * 2 + (b & 1), by = mby * 2 + (b >> 1);
            let count = 0;
            if (chromaCbp === 2) count = writeResidualBlock(w, cac[c][b], 15, nC(nz, cbw, bx, by, bx > 0, by > 0));
            nz[by * cbw + bx] = count;
          }
        }

        // --- reconstruct exactly like a decoder would, for the next blocks' prediction
        const dcq = new Int32Array(16);
        for (let k = 0; k < 16; k++) dcq[ZIGZAG[k]] = dcLv[k];
        hadamard4(dcq);
        for (let k = 0; k < 16; k++) dcq[k] = q.dequantLumaDc(dcq[k]);
        for (let b = 0; b < 16; b++) {
          const bx = BLK_X[b] * 4, by = BLK_Y[b] * 4;
          res.fill(0);
          res[0] = dcq[BLK_Y[b] * 4 + BLK_X[b]];
          if (acFlag) for (let k = 1; k < 16; k++) if (ac[b][k - 1]) res[ZIGZAG[k]] = q.dequant(ac[b][k - 1], ZIGZAG[k]);
          idct4(res);
          for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) recY[(py + by + j) * W + px + bx + i] = clip(pred[(by + j) * 16 + bx + i] + res[j * 4 + i]);
        }
        for (let c = 0; c < 2; c++) {
          const rec = c ? recV : recU;
          const dcc = chromaCbp >= 1 ? hadamard2(cdcLv[c]).map((x) => qc.dequantChromaDc(x)) : [0, 0, 0, 0];
          for (let b = 0; b < 4; b++) {
            const bx = (b & 1) * 4, by = (b >> 1) * 4;
            res.fill(0);
            res[0] = dcc[b];
            if (chromaCbp === 2) for (let k = 1; k < 16; k++) if (cac[c][b][k - 1]) res[ZIGZAG[k]] = qc.dequant(cac[c][b][k - 1], ZIGZAG[k]);
            idct4(res);
            for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) rec[((py >> 1) + by + j) * CW + (px >> 1) + bx + i] = clip(predC[c][(by + j) * 8 + bx + i] + res[j * 4 + i]);
          }
        }
      }
    }
    w.trailing();
    return { nal: nal(3, 5, w.result()), recon: { y: recY, u: recU, v: recV } };
  }

  // P picture where every macroblock is skipped: repeats the previous picture.
  // frameNum counts reference pictures since the IDR (1, 2, ...).
  encodeSkip(frameNum) {
    const w = new BitWriter(32);
    this._sliceHeaderCommon(w, false, frameNum);
    w.u(1, 0); // num_ref_idx_active_override_flag
    w.u(1, 0); // ref_pic_list_modification_flag_l0
    w.u(1, 0); // dec_ref_pic_marking: adaptive_ref_pic_marking_mode_flag (sliding window)
    w.se(0); // slice_qp_delta
    w.ue(1); // disable_deblocking_filter_idc: nothing to filter
    w.ue(this.sps.mbW * this.sps.mbH); // mb_skip_run
    w.trailing();
    return nal(2, 1, w.result());
  }
}

// Intra_16x16 prediction (8.3.3): tries V, H, DC, Plane; fills `pred`, returns the mode.
function predictLuma16(rec, W, px, py, availL, availT, orig, pred) {
  const top = new Int32Array(16), left = new Int32Array(16);
  if (availT) for (let i = 0; i < 16; i++) top[i] = rec[(py - 1) * W + px + i];
  if (availL) for (let j = 0; j < 16; j++) left[j] = rec[(py + j) * W + px - 1];
  const tl = availL && availT ? rec[(py - 1) * W + px - 1] : 0;
  const cand = new Int32Array(256);
  let best = -1, bestSad = Infinity;
  const consider = (mode, fill) => {
    fill(cand);
    let sad = 0;
    for (let k = 0; k < 256 && sad < bestSad; k++) sad += Math.abs(orig[k] - cand[k]);
    if (sad < bestSad) { bestSad = sad; best = mode; pred.set(cand); }
  };
  if (availT) consider(0, (p) => { for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) p[j * 16 + i] = top[i]; });
  if (availL) consider(1, (p) => { for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) p[j * 16 + i] = left[j]; });
  consider(2, (p) => {
    let v = 128;
    if (availL && availT) { let sum = 16; for (let i = 0; i < 16; i++) sum += top[i] + left[i]; v = sum >> 5; }
    else if (availL) { let sum = 8; for (let i = 0; i < 16; i++) sum += left[i]; v = sum >> 4; }
    else if (availT) { let sum = 8; for (let i = 0; i < 16; i++) sum += top[i]; v = sum >> 4; }
    p.fill(v);
  });
  if (availL && availT) consider(3, (p) => {
    let H = 0, V = 0;
    for (let i = 0; i < 8; i++) {
      H += (i + 1) * (top[8 + i] - (i === 7 ? tl : top[6 - i]));
      V += (i + 1) * (left[8 + i] - (i === 7 ? tl : left[6 - i]));
    }
    const a = 16 * (left[15] + top[15]), b = (5 * H + 32) >> 6, c = (5 * V + 32) >> 6;
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) p[j * 16 + i] = clip((a + b * (i - 7) + c * (j - 7) + 16) >> 5);
  });
  return best;
}

// Chroma intra prediction (8.3.4) for both planes with one shared mode: DC(0), H(1), V(2), Plane(3).
function predictChroma(recU, recV, CW, cx, cy, availL, availT, orig, pred) {
  const recs = [recU, recV];
  const tops = [new Int32Array(8), new Int32Array(8)], lefts = [new Int32Array(8), new Int32Array(8)], tls = [0, 0];
  for (let c = 0; c < 2; c++) {
    if (availT) for (let i = 0; i < 8; i++) tops[c][i] = recs[c][(cy - 1) * CW + cx + i];
    if (availL) for (let j = 0; j < 8; j++) lefts[c][j] = recs[c][(cy + j) * CW + cx - 1];
    if (availL && availT) tls[c] = recs[c][(cy - 1) * CW + cx - 1];
  }
  const cand = [new Int32Array(64), new Int32Array(64)];
  let best = -1, bestSad = Infinity;
  const consider = (mode, fill) => {
    let sad = 0;
    for (let c = 0; c < 2; c++) {
      fill(cand[c], tops[c], lefts[c], tls[c]);
      for (let k = 0; k < 64 && sad < bestSad; k++) sad += Math.abs(orig[c][k] - cand[c][k]);
    }
    if (sad < bestSad) { bestSad = sad; best = mode; pred[0].set(cand[0]); pred[1].set(cand[1]); }
  };
  consider(0, (p, top, left) => {
    for (let b = 0; b < 4; b++) {
      const xO = (b & 1) * 4, yO = (b >> 1) * 4;
      let st = 0, sl = 0;
      for (let i = 0; i < 4; i++) { st += top[xO + i]; sl += left[yO + i]; }
      let v;
      const both = (xO === 0 && yO === 0) || (xO > 0 && yO > 0);
      if (both) v = availL && availT ? (st + sl + 4) >> 3 : availL ? (sl + 2) >> 2 : availT ? (st + 2) >> 2 : 128;
      else if (xO > 0) v = availT ? (st + 2) >> 2 : availL ? (sl + 2) >> 2 : 128; // top-right block prefers top
      else v = availL ? (sl + 2) >> 2 : availT ? (st + 2) >> 2 : 128; // bottom-left block prefers left
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) p[(yO + j) * 8 + xO + i] = v;
    }
  });
  if (availL) consider(1, (p, top, left) => { for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) p[j * 8 + i] = left[j]; });
  if (availT) consider(2, (p, top) => { for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) p[j * 8 + i] = top[i]; });
  if (availL && availT) consider(3, (p, top, left, tl) => {
    let H = 0, V = 0;
    for (let i = 0; i < 4; i++) {
      H += (i + 1) * (top[4 + i] - (i === 3 ? tl : top[2 - i]));
      V += (i + 1) * (left[4 + i] - (i === 3 ? tl : left[2 - i]));
    }
    const a = 16 * (left[7] + top[7]), b = (34 * H + 32) >> 6, c = (34 * V + 32) >> 6;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) p[j * 8 + i] = clip((a + b * (i - 3) + c * (j - 3) + 16) >> 5);
  });
  return best;
}

module.exports = { ScreenEncoder, H264Error, parseAvcC, parseSps, parsePpsId, unsupportedReason, avcCWithPps, BitReader, BitWriter, unescapeNal, escapeRbsp };
