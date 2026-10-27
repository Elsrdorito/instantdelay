'use strict';
// Turns a picture (RGBA) into the 4:2:0 planes the screen encoder needs:
// scaled to fit the stream's visible size (letterboxed, never stretched),
// placed on the coded (macroblock-aligned) canvas, converted to limited-range
// Y'CbCr (BT.709 for HD, BT.601 below 720 lines, like OBS).

const MAX_SIDE = 4096;

// Resampling weights for one axis: box filter when shrinking, linear when enlarging.
function axisWeights(srcN, dstN) {
  const scale = srcN / dstN;
  const rows = [];
  for (let d = 0; d < dstN; d++) {
    const w = [];
    if (scale >= 1) {
      const a = d * scale, b = (d + 1) * scale;
      for (let s = Math.floor(a); s < Math.min(srcN, Math.ceil(b)); s++) {
        const cover = Math.min(b, s + 1) - Math.max(a, s);
        if (cover > 0) w.push([s, cover / scale]);
      }
    } else {
      const c = (d + 0.5) * scale - 0.5;
      const s0 = Math.max(0, Math.min(srcN - 1, Math.floor(c)));
      const s1 = Math.min(srcN - 1, s0 + 1);
      const t = Math.max(0, Math.min(1, c - s0));
      w.push([s0, 1 - t]);
      if (s1 !== s0 && t > 0) w.push([s1, t]);
    }
    rows.push(w);
  }
  return rows;
}

// RGBA -> RGB (alpha over black), resampled to dstW x dstH. Returns Float32Array RGB.
function resample(img, dstW, dstH) {
  const { width: sw, height: sh, data } = img;
  const wx = axisWeights(sw, dstW), wy = axisWeights(sh, dstH);
  const tmp = new Float32Array(dstW * sh * 3);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0;
      for (const [s, w] of wx[x]) {
        const o = row + s * 4;
        const a = data[o + 3] / 255 * w;
        r += data[o] * a; g += data[o + 1] * a; b += data[o + 2] * a;
      }
      const t = (y * dstW + x) * 3;
      tmp[t] = r; tmp[t + 1] = g; tmp[t + 2] = b;
    }
  }
  const out = new Float32Array(dstW * dstH * 3);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0;
      for (const [s, w] of wy[y]) {
        const t = (s * dstW + x) * 3;
        r += tmp[t] * w; g += tmp[t + 1] * w; b += tmp[t + 2] * w;
      }
      const o = (y * dstW + x) * 3;
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
  }
  return out;
}

// Average colour of the picture's outer edge: what the letterbox bars are painted with.
function borderColor(img) {
  const { width: w, height: h, data } = img;
  let r = 0, g = 0, b = 0, n = 0;
  const add = (x, y) => { const o = (y * w + x) * 4, a = data[o + 3] / 255; r += data[o] * a; g += data[o + 1] * a; b += data[o + 2] * a; n++; };
  for (let x = 0; x < w; x++) { add(x, 0); if (h > 1) add(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { add(0, y); if (w > 1) add(w - 1, y); }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

// target: { width, height (visible), codedWidth, codedHeight }
function prepareScreen(img, target) {
  if (img.width > MAX_SIDE || img.height > MAX_SIDE) throw new Error(`picture is too large (max ${MAX_SIDE}x${MAX_SIDE})`);
  const { width: vw, height: vh, codedWidth: cw, codedHeight: ch } = target;
  // Fit inside the visible area, keeping the aspect ratio; even sizes keep chroma simple.
  const scale = Math.min(vw / img.width, vh / img.height);
  const dw = Math.max(2, Math.floor(img.width * scale) & ~1);
  const dh = Math.max(2, Math.floor(img.height * scale) & ~1);
  const ox = ((vw - dw) >> 1) & ~1, oy = ((vh - dh) >> 1) & ~1;
  const pic = resample(img, dw, dh);
  const fill = borderColor(img);

  const hd = vh >= 720;
  const Kr = hd ? 0.2126 : 0.299, Kb = hd ? 0.0722 : 0.114, Kg = 1 - Kr - Kb;
  const Y = new Uint8Array(cw * ch), U = new Uint8Array((cw * ch) >> 2), V = new Uint8Array((cw * ch) >> 2);
  const pb = new Float32Array(cw * ch), pr = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    // Rows/columns outside the visible picture repeat the edge (they are cropped away by the player).
    const sy = Math.min(y, vh - 1);
    for (let x = 0; x < cw; x++) {
      const sx = Math.min(x, vw - 1);
      let r, g, b;
      if (sx >= ox && sx < ox + dw && sy >= oy && sy < oy + dh) {
        const o = ((sy - oy) * dw + (sx - ox)) * 3;
        r = pic[o]; g = pic[o + 1]; b = pic[o + 2];
      } else [r, g, b] = fill;
      const yy = (Kr * r + Kg * g + Kb * b) / 255;
      Y[y * cw + x] = Math.max(16, Math.min(235, Math.round(16 + 219 * yy)));
      pb[y * cw + x] = (b / 255 - yy) / (2 * (1 - Kb));
      pr[y * cw + x] = (r / 255 - yy) / (2 * (1 - Kr));
    }
  }
  const hw = cw >> 1;
  for (let y = 0; y < ch >> 1; y++) {
    for (let x = 0; x < hw; x++) {
      const o = 2 * y * cw + 2 * x;
      const cb = (pb[o] + pb[o + 1] + pb[o + cw] + pb[o + cw + 1]) / 4;
      const cr = (pr[o] + pr[o + 1] + pr[o + cw] + pr[o + cw + 1]) / 4;
      U[y * hw + x] = Math.max(16, Math.min(240, Math.round(128 + 224 * cb)));
      V[y * hw + x] = Math.max(16, Math.min(240, Math.round(128 + 224 * cr)));
    }
  }
  return { y: Y, u: U, v: V, placed: { x: ox, y: oy, width: dw, height: dh } };
}

module.exports = { prepareScreen, resample, axisWeights, MAX_SIDE };
