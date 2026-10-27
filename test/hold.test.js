'use strict';
// The hold (keep-alive filler) in the delay engine, with a fake clock and a fake hold source.
const test = require('node:test');
const assert = require('node:assert');
const { DelayEngine } = require('../src/delay');
const { TAG_AUDIO, TAG_VIDEO, TAG_SCRIPT } = require('../src/flv');

const GOP = 10;
const FRAME = 33;

// A stand-in for HoldSource: 100 ms video ticks (keyframe at k % 20 == 0, header first), 20 ms audio.
function fakeHoldSource({ audio = true, fail = false } = {}) {
  const src = { sessions: 0, session() {
    if (fail) return null;
    src.sessions++;
    return {
      kind: 'screen', videoIntervalMs: 100, audioIntervalMs: audio ? 20 : 0,
      videoTags(k) {
        const tags = [];
        if (k === 0) tags.push({ type: TAG_VIDEO, data: Buffer.from('HOLDHDR'), header: true });
        tags.push({ type: TAG_VIDEO, data: Buffer.from(k % 20 === 0 ? 'HOLDKEY' : 'HOLDP'), isKey: k % 20 === 0 });
        return tags;
      },
      audioTag() { return { type: TAG_AUDIO, data: Buffer.from('HOLDAUD') }; },
    };
  } };
  return src;
}

function setup(opts = {}, hold = {}) {
  const engine = new DelayEngine(opts);
  engine.holdSource = fakeHoldSource(hold);
  engine.keepAlive = true;
  const out = [];
  engine.on('tag', (t) => out.push(t));
  let now = 0;
  let frame = 0;
  const feedHeaders = (ts = 0) => {
    engine.push({ type: TAG_SCRIPT, ts, data: Buffer.from('meta'), isKey: false, isSeq: true }, now);
    engine.push({ type: TAG_VIDEO, ts, data: Buffer.from([0x17, 0]), isKey: true, isSeq: true }, now);
    engine.push({ type: TAG_AUDIO, ts, data: Buffer.from([0xaf, 0]), isKey: false, isSeq: true }, now);
  };
  const feed = (frames) => {
    for (let i = 0; i < frames; i++, frame++, now += FRAME) {
      const ts = frame * FRAME;
      engine.push({ type: TAG_VIDEO, ts, data: Buffer.from([frame % GOP ? 0x27 : 0x17, 1]), isKey: frame % GOP === 0, isSeq: false, frame }, now);
      engine.push({ type: TAG_AUDIO, ts, data: Buffer.from([0xaf, 1]), isKey: false, isSeq: false }, now);
    }
  };
  // Let wall-clock pass without input, ticking the engine like its timer would.
  const idle = (ms, step = 10) => { for (let t = 0; t < ms; t += step) { now += step; engine.tick(now); } };
  return { engine, out, feed, feedHeaders, idle, get now() { return now; }, holdTags: () => out.filter((t) => t.hold), real: () => out.filter((t) => !t.hold && !t.header) };
}

function assertMonotonic(tags) {
  for (const type of [TAG_AUDIO, TAG_VIDEO]) {
    const ts = tags.filter((t) => t.type === type && !t.header).map((t) => t.ts);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1], `track ${type} went backwards at ${i}: ${ts[i - 1]} -> ${ts[i]}`);
  }
}

test('raising the delay sends the hold instead of silence, then resumes on a keyframe', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(30); // 1 s live
  s.engine.setDelay(5000, s.now);
  s.feed(30 * 5); // 5 s of input while the buffer fills
  const hold = s.holdTags();
  assert.ok(hold.length > 0, 'hold tags were sent');
  assert.strictEqual(hold[0].header, true, 'hold starts with its sequence header');
  assert.strictEqual(hold[1].isKey, true, 'then a keyframe');
  const holdVideo = hold.filter((t) => t.type === TAG_VIDEO && !t.header);
  const holdAudio = hold.filter((t) => t.type === TAG_AUDIO);
  assert.ok(holdVideo.length >= 45 && holdVideo.length <= 51, `~50 hold video frames (${holdVideo.length})`);
  assert.ok(holdAudio.length >= 240 && holdAudio.length <= 251, `~250 hold audio frames (${holdAudio.length})`);
  assert.ok(s.engine.status(s.now).holding, 'still holding right at the end of the fill');
  // Now the buffered content comes due: the hold ends, real output restarts with headers + keyframe.
  s.feed(30);
  assert.ok(!s.engine.status(s.now).holding, 'hold ended');
  const afterHold = s.out.slice(s.out.findIndex((t, i) => i > 0 && !t.hold && t.header && s.out[i - 1].hold));
  assert.ok(afterHold.length > 0, 'real output resumed');
  assert.deepStrictEqual(afterHold.slice(0, 3).map((t) => t.type), [TAG_SCRIPT, TAG_VIDEO, TAG_AUDIO], 'own headers re-sent');
  const firstReal = afterHold.find((t) => !t.header);
  assert.ok(firstReal.type === TAG_VIDEO && firstReal.isKey, 'resumed on a keyframe');
  assertMonotonic(s.out);
  // Continuity: the first real frame follows the last hold frame closely.
  const lastHold = hold.at(-1);
  assert.ok(firstReal.ts > lastHold.ts - 150 && firstReal.ts < lastHold.ts + 150, `continuous timeline (${lastHold.ts} -> ${firstReal.ts})`);
  assert.strictEqual(s.engine.stats.holds, 1);
});

test('a short raise does not trigger a hold', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(30);
  s.engine.setDelay(1000, s.now);
  s.feed(60);
  assert.strictEqual(s.holdTags().length, 0);
  assert.strictEqual(s.engine.stats.holds, 0);
});

test('a cut hole is covered by the hold', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(30);
  s.engine.setDelay(3000, s.now);
  s.feed(30 * 4); // fill (hold #1) and a second of steady state
  assert.strictEqual(s.engine.stats.holds, 1);
  assert.ok(!s.engine.status(s.now).holding);
  s.engine.cut(2000, s.now);
  s.feed(30 * 2); // the output reaches the hole after ~1 s and holds ~2 s
  assert.strictEqual(s.engine.stats.holds, 2);
  s.feed(30 * 3);
  assert.ok(!s.engine.status(s.now).holding);
  assertMonotonic(s.out);
});

test('OBS disappearing: hold after 1 s of silence, resume when it is back', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(30);
  s.idle(3000); // nothing arrives
  const hold = s.holdTags();
  assert.ok(hold.length > 0 && s.engine.status(s.now).holding, 'holding while OBS is gone');
  assert.ok(hold[0].ts <= s.real().at(-1).ts + 1100, 'hold started about a second after the last frame');
  s.engine.inputRestart();
  s.feedHeaders();
  s.feed(25); // first GOP after reconnect starts with a keyframe
  assert.ok(!s.engine.status(s.now).holding, 'resumed');
  assertMonotonic(s.out);
});

test('no hold without an output, and none when the source has nothing to send', () => {
  const s = setup();
  s.engine.keepAlive = false;
  s.feedHeaders();
  s.feed(30);
  s.engine.setDelay(5000, s.now);
  s.feed(30 * 5);
  assert.strictEqual(s.holdTags().length, 0);

  const t = setup({}, { fail: true });
  t.feedHeaders();
  t.feed(30);
  t.engine.setDelay(5000, t.now);
  t.feed(30 * 5);
  assert.strictEqual(t.holdTags().length, 0);
  assert.strictEqual(t.engine.stats.holds, 0);
});

test('going back to live during a hold ends it cleanly', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(30);
  s.engine.setDelay(10000, s.now);
  s.feed(30 * 2);
  assert.ok(s.engine.status(s.now).holding);
  s.engine.setDelay(0, s.now);
  s.feed(15);
  assert.ok(!s.engine.status(s.now).holding);
  const idx = s.out.findIndex((t, i) => i > 0 && s.out[i - 1].hold && !t.hold);
  const firstReal = s.out.slice(idx).find((t) => !t.header);
  assert.ok(firstReal && firstReal.type === TAG_VIDEO && firstReal.isKey);
  assertMonotonic(s.out);
});

test('a new output session cancels the hold state', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(30);
  s.engine.setDelay(10000, s.now);
  s.feed(30);
  assert.ok(s.engine.status(s.now).holding);
  s.engine.outputRestart(true);
  assert.ok(!s.engine.status(s.now).holding);
});
