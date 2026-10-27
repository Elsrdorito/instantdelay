'use strict';
// Tests for the still-picture H.264 encoder. The bitstream checks need ffmpeg
// (the reference decoder); without it only the parsing tests run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ScreenEncoder, parseAvcC, parseSps, unsupportedReason, H264Error } = require('../src/h264');
const { flvHeader, encodeTag, FlvParser, TAG_VIDEO } = require('../src/flv');

const FF = process.env.FFMPEG || 'ffmpeg';
const haveFfmpeg = spawnSync(FF, ['-version']).status === 0;

// AVC sequence headers (avcC) captured from x264 for various profiles.
const AVCC = {
  high720_bf3: '0164001fffe1001a6764001facd9405005bb0110000003001000000303c0f183196001000468ef8fcbfdf8f800',
  high1080_bf0: '01640028ffe1001967640028acb403c0113f2e0220000003002000000781e3065401000468ef0fcbfdf8f800',
  base360: '0142c01effe100196742c01eda0280bfe5c044000003000400000300f03c58ba8001000468ce0fc8',
  main1080_bf2: '014d4028ffe1001a674d4028eca03c0113f2e022000003000200000300781e30632c01000468ef8fc8',
  high1080_8x8: '01640028ffe1001b67640028acd940780227e5c044000003000400000300f03c60c65801000568e938fcb0fdf8f800',
};
const avcc = (k) => Buffer.from(AVCC[k], 'hex');

// A synthetic test card: gradient, flat areas, hard edges and a noisy patch.
function testPlanes(W, H, { white = false } = {}) {
  const y = new Uint8Array(W * H), u = new Uint8Array(W * H / 4), v = new Uint8Array(W * H / 4);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let Y = white ? 16 : 40 + Math.round(120 * i / W) + Math.round(40 * j / H);
    if (white && i > W / 4 && i < W / 2 && j > H / 4 && j < H / 2) Y = 235;
    if (!white) {
      if (i > W * 0.1 && i < W * 0.4 && j > H * 0.2 && j < H * 0.3) Y = ((i >> 3) + (j >> 3)) & 1 ? 235 : 16; // checkerboard "text"
      if (i > W * 0.6 && i < W * 0.9 && j > H * 0.6 && j < H * 0.8) Y = 60 + Math.round(rnd() * 150);
      if (i > W * 0.5 && i < W * 0.55) Y = 200;
    }
    y[j * W + i] = Y;
  }
  for (let j = 0; j < H / 2; j++) for (let i = 0; i < W / 2; i++) {
    u[j * (W / 2) + i] = white ? 128 : 90 + Math.round(70 * i / (W / 2));
    v[j * (W / 2) + i] = white ? 128 : 160 - Math.round(60 * j / (H / 2));
  }
  return { y, u, v };
}

function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.length; i++) se += (a[i] - b[i]) ** 2;
  if (!se) return Infinity;
  return 10 * Math.log10(255 * 255 / (se / a.length));
}

const videoTag = (data) => ({ type: TAG_VIDEO, data });
const flvOf = (tags) => Buffer.concat([flvHeader(), ...tags.map((t, i) => encodeTag(t.type, t.ts ?? i * 100, t.data))]);
const avcPacket = (key, body, seq = false) => Buffer.concat([Buffer.from([key ? 0x17 : 0x27, seq ? 0 : 1, 0, 0, 0]), body]);

function decodeWithFfmpeg(flv, width, height) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h264test-'));
  const inFile = path.join(dir, 'in.flv'), outFile = path.join(dir, 'out.yuv');
  fs.writeFileSync(inFile, flv);
  const r = spawnSync(FF, ['-v', 'error', '-y', '-i', inFile, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', outFile], { encoding: 'utf8' });
  const raw = fs.existsSync(outFile) ? fs.readFileSync(outFile) : Buffer.alloc(0);
  fs.rmSync(dir, { recursive: true, force: true });
  const frameSize = width * height * 3 / 2;
  const frames = [];
  for (let o = 0; o + frameSize <= raw.length; o += frameSize) {
    frames.push({ y: raw.subarray(o, o + width * height), u: raw.subarray(o + width * height, o + width * height * 5 / 4), v: raw.subarray(o + width * height * 5 / 4, o + frameSize) });
  }
  return { frames, stderr: r.stderr.trim() };
}

// The visible (cropped) part of a coded-size plane.
function cropPlane(plane, codedW, w, h, sub = 1) {
  const out = new Uint8Array((w / sub) * (h / sub));
  for (let j = 0; j < h / sub; j++) for (let i = 0; i < w / sub; i++) out[j * (w / sub) + i] = plane[j * (codedW / sub) + i];
  return out;
}

test('parses x264 sequence headers', () => {
  const s = parseSps(parseAvcC(avcc('high720_bf3')).sps[0]);
  assert.strictEqual(s.profile, 100);
  assert.deepStrictEqual([s.width, s.height, s.codedWidth, s.codedHeight], [1280, 720, 1280, 720]);
  assert.strictEqual(s.pocType, 0);
  assert.strictEqual(unsupportedReason(s), null);
  const t = parseSps(parseAvcC(avcc('high1080_bf0')).sps[0]);
  assert.deepStrictEqual([t.width, t.height, t.codedHeight, t.crop.bottom], [1920, 1080, 1088, 8]);
  assert.strictEqual(t.pocType, 2); // x264 without B-frames
  const b = parseSps(parseAvcC(avcc('base360')).sps[0]);
  assert.deepStrictEqual([b.profile, b.width, b.height], [66, 640, 360]);
  assert.ok(b.numRefFrames >= 1);
});

test('refuses what it cannot encode', () => {
  assert.throws(() => new ScreenEncoder(Buffer.from('00', 'hex')), H264Error);
  // High 4:4:4 would be chroma_format_idc 3; fake it by checking the reason function directly.
  assert.match(unsupportedReason({ chromaFormat: 3, bitDepth: 8, frameMbsOnly: 1, pocType: 0, scalingMatrix: false, numRefFrames: 1 }), /4:2:0/);
  assert.match(unsupportedReason({ chromaFormat: 1, bitDepth: 10, frameMbsOnly: 1, pocType: 0, scalingMatrix: false, numRefFrames: 1 }), /10-bit/);
});

test('adds a free PPS id and keeps the original parameter sets', () => {
  const enc = new ScreenEncoder(avcc('high720_bf3'));
  const rec = parseAvcC(enc.avcC);
  assert.strictEqual(rec.pps.length, 2);
  assert.ok(rec.sps[0].equals(parseAvcC(avcc('high720_bf3')).sps[0]));
  assert.strictEqual(enc.ppsId, 1);
  assert.strictEqual(enc.lengthSize, 4);
});

test('NAL units contain no start-code emulation', () => {
  const enc = new ScreenEncoder(avcc('base360'), { qp: 12 });
  const { nal } = enc.encodeIdr(testPlanes(640, 368));
  for (let i = 2; i < nal.length; i++) assert.ok(!(nal[i - 2] === 0 && nal[i - 1] === 0 && nal[i] <= 2), `start code emulation at ${i}`);
  assert.ok(nal.length > 1000 && nal.length < 200000, `size ${nal.length}`);
  const skip = enc.encodeSkip(1);
  assert.ok(skip.length < 16, `skip frame is ${skip.length} bytes`);
});

for (const [name, opts] of [['high720_bf3', {}], ['high1080_bf0', {}], ['base360', {}], ['main1080_bf2', {}], ['high1080_8x8', { qp: 28 }]]) {
  test(`decodes bit-exact with the reference decoder: ${name}`, { skip: !haveFfmpeg && 'ffmpeg not installed' }, () => {
    const enc = new ScreenEncoder(avcc(name), { deblock: false, ...opts });
    const planes = testPlanes(enc.codedWidth, enc.codedHeight);
    const { nal, recon } = enc.encodeIdr(planes);
    const tags = [
      videoTag(avcPacket(true, enc.avcC, true)),
      videoTag(avcPacket(true, enc.packNals([enc.pps, nal]))),
      ...[1, 2, 3].map((k) => videoTag(avcPacket(false, enc.packNals([enc.encodeSkip(k)])))),
      videoTag(avcPacket(true, enc.packNals([enc.pps, enc.encodeIdr(planes).nal]))),
      videoTag(avcPacket(false, enc.packNals([enc.encodeSkip(1)]))),
    ];
    const { frames, stderr } = decodeWithFfmpeg(flvOf(tags), enc.width, enc.height);
    assert.strictEqual(stderr, '', 'decoder complained');
    assert.strictEqual(frames.length, 6);
    const W = enc.codedWidth;
    for (const [plane, sub] of [['y', 1], ['u', 2], ['v', 2]]) {
      const ours = cropPlane(recon[plane], W, enc.width, enc.height, sub);
      assert.ok(Buffer.from(ours).equals(frames[0][plane]), `${plane} reconstruction differs from the decoder`);
      // Skip frames repeat the picture exactly; the second IDR is identical too.
      for (let f = 1; f < frames.length; f++) assert.ok(frames[f][plane].equals(frames[0][plane]), `frame ${f} ${plane} differs`);
      assert.ok(psnr(cropPlane(planes[plane], W, enc.width, enc.height, sub), frames[0][plane]) > 34, `${plane} quality`);
    }
  });
}

test('deblocking on: decodes cleanly with good quality', { skip: !haveFfmpeg && 'ffmpeg not installed' }, () => {
  const enc = new ScreenEncoder(avcc('high720_bf3'), { qp: 20 });
  const planes = testPlanes(1280, 720);
  const { nal } = enc.encodeIdr(planes);
  const tags = [videoTag(avcPacket(true, enc.avcC, true)), videoTag(avcPacket(true, enc.packNals([enc.pps, nal]))), videoTag(avcPacket(false, enc.packNals([enc.encodeSkip(1)])))];
  const { frames, stderr } = decodeWithFfmpeg(flvOf(tags), 1280, 720);
  assert.strictEqual(stderr, '');
  assert.strictEqual(frames.length, 2);
  const p = psnr(planes.y, frames[0].y);
  assert.ok(p > 38, `luma PSNR ${p.toFixed(1)} dB`);
  console.log(`  720p test card at qp 20: ${nal.length} bytes, luma PSNR ${p.toFixed(1)} dB`);
});

test('huge levels fall back to I_PCM and stay bit-exact', { skip: !haveFfmpeg && 'ffmpeg not installed' }, () => {
  const enc = new ScreenEncoder(avcc('base360'), { qp: 12, deblock: false, pcmLimit: 40 });
  const planes = testPlanes(640, 368, { white: true });
  const { nal, recon } = enc.encodeIdr(planes);
  assert.ok(nal.length > 384 * 4, 'expected some I_PCM macroblocks');
  const { frames, stderr } = decodeWithFfmpeg(flvOf([videoTag(avcPacket(true, enc.avcC, true)), videoTag(avcPacket(true, enc.packNals([enc.pps, nal])))]), 640, 360);
  assert.strictEqual(stderr, '');
  assert.ok(Buffer.from(cropPlane(recon.y, 640, 640, 360)).equals(frames[0].y));
});

test('our pictures can be spliced into a real x264 stream', { skip: !haveFfmpeg && 'ffmpeg not installed' }, () => {
  // 2 GOPs of x264 (CABAC, B-frames) -> our screen -> x264 again, like a hold in the middle of a stream.
  const r = spawnSync(FF, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-frames:v', '40', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '20', '-bf', '3', '-f', 'flv', 'pipe:1'], { maxBuffer: 1 << 26 });
  assert.strictEqual(r.status, 0, r.stderr.toString());
  const tags = [];
  new FlvParser((t) => tags.push(t)).push(r.stdout);
  const video = tags.filter((t) => t.type === TAG_VIDEO);
  const seq = video.find((t) => t.isSeq);
  const frames = video.filter((t) => !t.isSeq && t.data[1] === 1); // drop the "end of sequence" packet
  const secondKey = frames.findIndex((t, i) => i > 0 && t.isKey);
  assert.ok(seq && secondKey > 0);
  const enc = new ScreenEncoder(seq.data.subarray(5), { qp: 22 });
  const planes = testPlanes(640, 368);
  const ours = [
    { ...videoTag(avcPacket(true, enc.avcC, true)) },
    videoTag(avcPacket(true, enc.packNals([enc.pps, enc.encodeIdr(planes).nal]))),
    ...[1, 2, 3, 4].map((k) => videoTag(avcPacket(false, enc.packNals([enc.encodeSkip(k)])))),
  ];
  let ts = 0;
  const withTs = (list) => list.map((t) => ({ ...t, ts: (ts += 33) }));
  const spliced = [{ ...seq, ts: 0 }, ...withTs(frames.slice(0, secondKey)), ...withTs(ours), { ...seq, ts }, ...withTs(frames.slice(secondKey))];
  const { frames: out, stderr } = decodeWithFfmpeg(flvOf(spliced), 640, 360);
  assert.strictEqual(stderr, '', 'decoder complained about the splice');
  assert.strictEqual(out.length, frames.length + 5);
  // The held picture is ours (compare with a standalone decode of it).
  const alone = decodeWithFfmpeg(flvOf(ours), 640, 360).frames[0];
  assert.ok(psnr(alone.y, out[secondKey].y) > 45, 'held picture differs after the splice');
});
