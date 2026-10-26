'use strict';
// Unit tests for the delay engine, driven by a fake clock. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { DelayEngine } = require('../src/delay');
const { TAG_AUDIO, TAG_VIDEO, TAG_SCRIPT } = require('../src/flv');

const GOP = 10; // keyframe every 10 frames
const FRAME = 33;

// Feeds a 30fps A/V stream into the engine with `now` advancing in lockstep.
function setup(opts) {
  const engine = new DelayEngine(opts);
  const out = [];
  engine.on('tag', (t) => out.push(t));
  let now = 0;
  let frame = 0;
  const feedHeaders = (ts = 0) => {
    engine.push({ type: TAG_SCRIPT, ts, data: Buffer.from('meta'), isKey: false, isSeq: true }, now);
    engine.push({ type: TAG_VIDEO, ts, data: Buffer.from([0x17, 0]), isKey: true, isSeq: true }, now);
    engine.push({ type: TAG_AUDIO, ts, data: Buffer.from([0xaf, 0]), isKey: false, isSeq: true }, now);
  };
  const feed = (frames, tsBase = 0) => {
    for (let i = 0; i < frames; i++, frame++, now += FRAME) {
      const ts = tsBase + frame * FRAME;
      engine.push({ type: TAG_VIDEO, ts, data: Buffer.from([frame % GOP ? 0x27 : 0x17, 1]), isKey: frame % GOP === 0, isSeq: false, frame }, now);
      engine.push({ type: TAG_AUDIO, ts, data: Buffer.from([0xaf, 1]), isKey: false, isSeq: false }, now);
    }
  };
  return {
    engine, out, feed, feedHeaders,
    get now() { return now; },
    set now(v) { now = v; },
    resetFrames() { frame = 0; },
    media: () => out.filter((t) => !t.header),
  };
}

function assertContinuous(tags) {
  for (const type of [TAG_AUDIO, TAG_VIDEO]) {
    const ts = tags.filter((t) => t.type === type && !t.header).map((t) => t.ts);
    for (let i = 1; i < ts.length; i++) {
      assert.ok(ts[i] >= ts[i - 1], `track ${type} went backwards at ${i}: ${ts[i - 1]} -> ${ts[i]}`);
      assert.ok(ts[i] - ts[i - 1] <= 2 * FRAME, `track ${type} jumped at ${i}: ${ts[i - 1]} -> ${ts[i]}`);
    }
  }
}

test('no delay: passes through, headers first, timeline starts at 0', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(30);
  assert.deepStrictEqual(s.out.slice(0, 3).map((t) => t.type), [TAG_SCRIPT, TAG_VIDEO, TAG_AUDIO]);
  assert.ok(s.out.slice(0, 3).every((t) => t.header));
  assert.strictEqual(s.media()[0].ts, 0);
  assert.strictEqual(s.media().length, 60);
});

test('output starts on a keyframe when joined mid-GOP', () => {
  const s = setup();
  s.feedHeaders();
  s.engine.outputRestart();
  s.feed(3); // frames 0..2: keyframe at 0
  s.engine.outputRestart(); // output reconnects mid-GOP
  s.feed(15);
  const vids = s.out.filter((t) => t.type === TAG_VIDEO);
  const restartAt = vids.findIndex((t, i) => i > 0 && t.header);
  assert.ok(restartAt > 0, 'headers re-sent after restart');
  const firstAfter = s.out.slice(s.out.indexOf(vids[restartAt]) + 1).find((t) => t.type === TAG_VIDEO);
  assert.strictEqual(firstAfter.data[0] >> 4, 1, 'first video frame after restart is a keyframe');
  assertContinuous(s.out);
});

test('raising the delay holds output until the buffer is full', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(30);
  const before = s.media().length;
  s.engine.setDelay(2000, s.now);
  s.feed(30); // ~1s later: still filling
  assert.strictEqual(s.media().length, before, 'nothing released while filling');
  assert.ok(s.engine.status(s.now).fillProgress < 1);
  s.feed(60); // ~3s total: 2s delay reached
  assert.ok(s.media().length > before);
  const st = s.engine.status(s.now);
  assert.ok(Math.abs(st.bufferedMs - 2000) <= FRAME, `buffered ${st.bufferedMs}`);
  assertContinuous(s.out);
});

test('lowering the delay jumps forward to a keyframe and stays continuous', () => {
  const s = setup({ delayMs: 3000 });
  s.feedHeaders();
  s.feed(155); // 5s in, mid-GOP
  const mark = s.out.length;
  s.engine.setDelay(0, s.now);
  assert.strictEqual(s.engine.buffer.length, 0, 'buffer drained');
  assert.ok(s.engine.stats.dropped > 0, 'something was skipped');
  const firstVideo = s.out.slice(mark).find((t) => t.type === TAG_VIDEO);
  assert.strictEqual(firstVideo.data[0] >> 4, 1, 'jump lands on a keyframe');
  s.feed(30);
  assertContinuous(s.out);
});

test('jump with B-frames never shows a frame at or before one already shown', () => {
  const engine = new DelayEngine({ delayMs: 3000 });
  const out = [];
  engine.on('tag', (t) => out.push(t));
  // Display offsets seen from x264 in the e2e run: I = 67ms, P = 167ms, B = 67ms. A P-frame sent
  // just before the cut displays later than the next keyframe would if only dts were continued.
  // The cts is also stored in data[2] so the test can read it back from emitted tags.
  let now = 0;
  for (let i = 0; i < 155; i++, now += FRAME) {
    const key = i % GOP === 0;
    const cts = !key && i % 2 === 1 ? 167 : 67;
    engine.push({ type: TAG_VIDEO, ts: i * FRAME, data: Buffer.from([key ? 0x17 : 0x27, 1, cts]), isKey: key, isSeq: false, cts }, now);
  }
  const mark = out.length;
  engine.setDelay(0, now);
  const pts = (t) => t.ts + t.data[2];
  const shownBefore = Math.max(...out.slice(0, mark).map(pts));
  const key = out[mark];
  assert.strictEqual(key.data[0] >> 4, 1, 'cut lands on a keyframe');
  assert.ok(pts(key) > shownBefore, `keyframe displays at ${pts(key)}, frames already shown up to ${shownBefore}`);
});

test('OBS reconnect with timestamps reset to 0 keeps output monotonic', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(40);
  s.engine.inputRestart();
  s.resetFrames();
  s.feedHeaders(0);
  s.feed(40);
  assertContinuous(s.out);
});

test('new session restarts the output clock at 0', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(40);
  s.engine.outputRestart(true);
  const mark = s.out.length;
  s.feed(20);
  const next = s.out.slice(mark).filter((t) => !t.header);
  assert.strictEqual(next[0].ts, 0);
});

test('delay is clamped to [0, max]', () => {
  const s = setup({ maxDelayMs: 10000 });
  s.engine.setDelay(99999, 0);
  assert.strictEqual(s.engine.delayMs, 10000);
  s.engine.setDelay(-5, 0);
  assert.strictEqual(s.engine.delayMs, 0);
});
