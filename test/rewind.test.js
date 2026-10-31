'use strict';
// Raising the delay by rewinding: what viewers just saw is sent again so the new delay applies
// at once, instead of a delay screen while the buffer fills. Fake clock, fake hold source.
const test = require('node:test');
const assert = require('node:assert');
const { DelayEngine } = require('../src/delay');
const { TAG_AUDIO, TAG_VIDEO, TAG_SCRIPT } = require('../src/flv');

const GOP = 10;
const FRAME = 33;

function fakeHoldSource() {
  return { session() {
    return {
      kind: 'screen', videoIntervalMs: 100, audioIntervalMs: 20,
      videoTags(k) { return [{ type: TAG_VIDEO, data: Buffer.from(k % 20 === 0 ? 'HOLDKEY' : 'HOLDP'), isKey: k % 20 === 0 }]; },
      audioTag() { return { type: TAG_AUDIO, data: Buffer.from('HOLDAUD') }; },
    };
  } };
}

// 30 fps A/V with `now` advancing in lockstep; every video frame carries its frame number in the data
// (bytes 1..4) so a replay can be told from new content.
function setup({ replayMs = 60000, raiseMode, hold = true, ...opts } = {}) {
  const engine = new DelayEngine(opts);
  engine.replayMs = replayMs;
  if (raiseMode) engine.raiseMode = raiseMode;
  if (hold) { engine.holdSource = fakeHoldSource(); engine.keepAlive = true; }
  const out = [];
  engine.on('tag', (t) => out.push(t));
  let now = 0;
  let frame = 0;
  const feedHeaders = (ts = 0, v = 0) => {
    engine.push({ type: TAG_SCRIPT, ts, data: Buffer.from('meta'), isKey: false, isSeq: true }, now);
    engine.push({ type: TAG_VIDEO, ts, data: Buffer.from([0x17, 0, v]), isKey: true, isSeq: true }, now);
    engine.push({ type: TAG_AUDIO, ts, data: Buffer.from([0xaf, 0, v]), isKey: false, isSeq: true }, now);
  };
  const feed = (frames) => {
    for (let i = 0; i < frames; i++, frame++, now += FRAME) {
      const ts = frame * FRAME;
      const data = Buffer.alloc(5); data[0] = frame % GOP ? 0x27 : 0x17; data.writeUInt32BE(frame, 1);
      engine.push({ type: TAG_VIDEO, ts, data, isKey: frame % GOP === 0, isSeq: false }, now);
      engine.push({ type: TAG_AUDIO, ts, data: Buffer.from([0xaf, 1]), isKey: false, isSeq: false }, now);
    }
  };
  const idle = (ms, step = 10) => { for (let t = 0; t < ms; t += step) { now += step; engine.tick(now); } };
  const frames = (tags = out) => tags.filter((t) => t.type === TAG_VIDEO && !t.header && !t.hold).map((t) => t.data.readUInt32BE(1));
  return { engine, out, feed, feedHeaders, idle, frames, get now() { return now; }, holdTags: () => out.filter((t) => t.hold) };
}

function assertContinuous(tags, maxGap = 2 * FRAME) {
  for (const type of [TAG_AUDIO, TAG_VIDEO]) {
    const ts = tags.filter((t) => t.type === type && !t.header).map((t) => t.ts);
    for (let i = 1; i < ts.length; i++) {
      assert.ok(ts[i] >= ts[i - 1], `track ${type} went backwards at ${i}: ${ts[i - 1]} -> ${ts[i]}`);
      assert.ok(ts[i] - ts[i - 1] <= maxGap, `track ${type} jumped at ${i}: ${ts[i - 1]} -> ${ts[i]}`);
    }
  }
}

test('raising from live replays the last N seconds at once: no screen, no fill', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(300); // 10 s live, everything went out
  assert.strictEqual(s.frames().length, 300);
  s.engine.setDelay(5000, s.now);
  // Rewound content starts on the keyframe at or before now - 5 s and everything due goes out right away.
  const after = s.frames().slice(300);
  assert.ok(after.length > 0, 'content was re-sent immediately');
  assert.strictEqual(after[0] % GOP, 0, 'replay starts on a keyframe');
  assert.ok(after[0] * FRAME <= s.now - 5000 && after[0] * FRAME > s.now - 5000 - GOP * FRAME, `keyframe just before the 5 s mark (frame ${after[0]})`);
  const st = s.engine.status(s.now);
  assert.ok(!st.filling, 'not filling');
  assert.strictEqual(st.effectiveDelayMs, 5000, 'viewers are 5 s behind at once');
  assert.ok(st.rewinding && st.rewindMs > 4000 && st.rewindMs <= 5000, `replay has ~5 s to go (${st.rewindMs})`);
  assert.strictEqual(st.rewinds, 1);
  // Carry on: the replay runs out and live content follows without a seam or a screen.
  s.feed(30 * 7);
  const all = s.frames();
  const replayed = all.slice(300);
  for (let i = 1; i < replayed.length; i++) assert.strictEqual(replayed[i], replayed[i - 1] + 1, `no gap in the replay at ${i}`);
  assert.ok(replayed.at(-1) > 300, 'moved past the replayed part into content viewers had not seen');
  assert.strictEqual(s.holdTags().length, 0, 'no delay screen at any point');
  assert.strictEqual(s.engine.stats.holds, 0);
  assert.strictEqual(s.engine.stats.dropped, 0, 'nothing was dropped at the join');
  assertContinuous(s.out);
  assert.ok(!s.engine.status(s.now).rewinding, 'replay over');
  assert.ok(Math.abs(s.engine.status(s.now).bufferedMs - 5000) < 2 * FRAME, 'buffer holds the delay');
});

test('headers are re-sent before the rewound keyframe', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(300);
  const before = s.out.length;
  s.engine.setDelay(3000, s.now);
  const fresh = s.out.slice(before);
  assert.deepStrictEqual(fresh.slice(0, 3).map((t) => [t.type, t.header]), [[TAG_SCRIPT, true], [TAG_VIDEO, true], [TAG_AUDIO, true]]);
  assert.ok(fresh[3].type === TAG_VIDEO && fresh[3].isKey, 'then the keyframe');
  assert.ok(fresh[3].ts > s.out[before - 1].ts && fresh[3].ts - s.out[before - 1].ts <= 34, 'keyframe follows the last sent frame');
});

test('a codec change inside the window: the rewind starts with the older headers, then re-sends the new ones', () => {
  const s = setup();
  s.feedHeaders(0, 1);
  s.feed(100);
  s.feedHeaders(100 * FRAME, 2); // OBS changed encoder settings
  s.feed(200);
  const before = s.out.length;
  s.engine.setDelay(8000, s.now); // back to ~ frame 60, before the change
  const fresh = s.out.slice(before);
  assert.strictEqual(fresh[1].type, TAG_VIDEO);
  assert.strictEqual(fresh[1].data[2], 1, 'video header v1 first');
  s.feed(30 * 10);
  const v2 = s.out.slice(before + 4).find((t) => t.header && t.type === TAG_VIDEO && t.data[2] === 2);
  assert.ok(v2, 'the v2 header passes the output again inside the replay');
  assert.deepStrictEqual([...s.engine.headers.get(TAG_VIDEO)], [0x17, 0, 2], 'output headers end up current');
  assertContinuous(s.out);
});

test('a bigger raise than the replay window: screen for the difference, then the replay, then live', () => {
  const s = setup({ replayMs: 2000 });
  s.feedHeaders();
  s.feed(300);
  s.engine.setDelay(5000, s.now);
  const st = s.engine.status(s.now);
  assert.ok(st.filling, 'the part the window cannot cover still has to build');
  assert.strictEqual(st.rewinds, 1);
  s.feed(30 * 8);
  const hold = s.holdTags();
  assert.ok(hold.length > 0, 'the screen covered the rest');
  assert.strictEqual(s.engine.stats.holds, 1);
  const holdVideo = hold.filter((t) => t.type === TAG_VIDEO);
  assert.ok(holdVideo.length >= 25 && holdVideo.length <= 35, `~3 s of screen at 10 fps (${holdVideo.length})`);
  const replayed = s.frames().slice(300);
  assert.ok(replayed[0] < 300 && replayed[0] >= 300 - 2000 / FRAME - GOP, `replay reaches back about 2 s (frame ${replayed[0]})`);
  for (let i = 1; i < replayed.length; i++) assert.strictEqual(replayed[i], replayed[i - 1] + 1);
  assertContinuous(s.out, 100 + 34);
  assert.ok(!s.engine.status(s.now).holding && !s.engine.status(s.now).filling);
});

test('raiseMode "screen" keeps the old behaviour: hold while the buffer fills, nothing re-sent', () => {
  const s = setup({ raiseMode: 'screen' });
  s.feedHeaders();
  s.feed(300);
  s.engine.setDelay(5000, s.now);
  assert.strictEqual(s.frames().length, 300, 'nothing re-sent');
  s.feed(30 * 7);
  assert.strictEqual(s.engine.stats.holds, 1);
  assert.strictEqual(s.engine.stats.rewinds, 0);
  assert.ok(s.frames().every((f, i, a) => i === 0 || f > a[i - 1]), 'no frame shown twice');
  assert.ok(!s.engine.status(s.now).rewinding);
});

test('no replay window (clips off, screen mode) means no rewind', () => {
  const s = setup({ replayMs: 0 });
  s.feedHeaders();
  s.feed(300);
  s.engine.setDelay(5000, s.now);
  assert.strictEqual(s.engine.stats.rewinds, 0);
  assert.strictEqual(s.frames().length, 300);
});

test('raising again while already delayed rewinds from the viewers\' position, not from live', () => {
  const s = setup({ delayMs: 3000 });
  s.feedHeaders();
  s.feed(300); // viewers are 3 s behind: frames up to ~209 went out
  const seen = s.frames().length;
  s.engine.setDelay(6000, s.now);
  const replayed = s.frames().slice(seen);
  assert.ok(replayed.length > 0);
  assert.ok(replayed[0] * FRAME <= s.now - 6000 && replayed[0] * FRAME > s.now - 6000 - GOP * FRAME, `rewound to ~6 s before live (frame ${replayed[0]})`);
  s.feed(30 * 8);
  const all = s.frames().slice(seen);
  for (let i = 1; i < all.length; i++) assert.strictEqual(all[i], all[i - 1] + 1, 'replay joins what viewers had not seen yet without a gap');
  assert.strictEqual(s.engine.stats.holds, 0);
  assert.strictEqual(s.engine.stats.dropped, 0);
  assertContinuous(s.out);
});

test('lowering the delay during a replay skips forward on a keyframe as usual', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(300);
  s.engine.setDelay(5000, s.now);
  s.feed(30); // 1 s into the replay
  assert.ok(s.engine.status(s.now).rewinding);
  s.engine.setDelay(0, s.now);
  const st = s.engine.status(s.now);
  assert.ok(!st.rewinding, 'replay abandoned');
  assert.ok(st.bufferedMs < GOP * FRAME, 'back to live');
  s.feed(30);
  assertContinuous(s.out);
  const f = s.frames();
  assert.strictEqual(f.at(-1), 359, 'live content flows again');
});

test('clips still see one continuous timeline after a rewind', () => {
  const s = setup();
  s.feedHeaders();
  s.feed(300);
  s.engine.setDelay(5000, s.now);
  s.feed(60);
  const clip = s.engine.clip(8000, s.now);
  const frames = clip.tags.filter((t) => t.type === TAG_VIDEO && t.data.length === 5).map((t) => t.data.readUInt32BE(1));
  for (let i = 1; i < frames.length; i++) assert.strictEqual(frames[i], frames[i - 1] + 1, 'the clip has every frame once, in order');
  assert.strictEqual(frames.at(-1), 359);
});

test('the replay window is trimmed by age even after a rewind', () => {
  const s = setup({ replayMs: 4000 });
  s.feedHeaders();
  s.feed(300);
  s.engine.setDelay(3000, s.now);
  s.feed(30 * 10);
  const oldest = s.engine.replay.peek();
  assert.ok(oldest.recv >= s.now - 4000 - FRAME, `nothing older than the window is kept (${s.now - oldest.recv} ms)`);
  assert.strictEqual(s.engine.replayBytes, [...s.engine.replay].reduce((n, t) => n + t.data.length, 0), 'byte count matches');
  assert.strictEqual(s.engine.bufferedBytes, [...s.engine.buffer].reduce((n, t) => n + t.data.length, 0));
});
