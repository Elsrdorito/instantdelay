'use strict';
// Delay engine: holds incoming FLV tags in a wall-clock buffer and releases
// them `delayMs` after they arrived. Timestamps are rewritten so the output is
// one continuous stream no matter how often the delay changes, OBS reconnects
// or a piece of the buffer is cut out.
//
//  - Lowering the delay -> jump forward to a keyframe (viewers see a clean cut).
//  - Raising the delay  -> output pauses while the buffer fills up.
//  - cut(ms)            -> throw away the newest `ms` of buffered content (the
//                          output pauses that long once it reaches the hole).
//
// Everything is driven by `now` so it can be unit-tested with a fake clock.
// Call start() to let the engine arm its own timers (one timeout for the next
// due tag; nothing runs while the buffer is empty).

const { EventEmitter } = require('events');
const { TAG_VIDEO, TAG_AUDIO, TAG_SCRIPT } = require('./flv');

const FRAME_GAP_MS = 33;

// Array-backed FIFO with O(1) shift. Up to 300s of audio+video is ~25k tags;
// Array.prototype.shift() would move all of them on every released tag.
class Deque {
  constructor() { this.a = []; this.h = 0; }
  get length() { return this.a.length - this.h; }
  push(x) { this.a.push(x); }
  peek() { return this.a[this.h]; }
  at(i) { return this.a[this.h + i]; }
  shift() {
    const x = this.a[this.h];
    this.a[this.h++] = undefined; // let the tag's data be collected
    if (this.h >= 1024 && this.h * 2 >= this.a.length) { this.a = this.a.slice(this.h); this.h = 0; }
    return x;
  }
  replace(arr) { this.a = arr; this.h = 0; }
  truncate(n) { this.a.length = this.h + n; }
  *[Symbol.iterator]() { for (let i = this.h; i < this.a.length; i++) yield this.a[i]; }
}

class DelayEngine extends EventEmitter {
  constructor({ delayMs = 0, maxDelayMs = 300000, maxBufferBytes = 1024 * 1024 * 1024 } = {}) {
    super();
    this.maxDelayMs = maxDelayMs;
    this.maxBufferBytes = maxBufferBytes; // never hold more than this, whatever the delay says
    this.delayMs = clamp(delayMs, 0, maxDelayMs);
    this.buffer = new Deque();
    this.bufferedBytes = 0;
    // Codec config (metadata / AVC / AAC sequence headers) of the content at the
    // *output* position; re-sent whenever the output (re)starts.
    this.headers = new Map();
    // Input timeline: normalizes timestamps across OBS reconnects.
    this.inOffset = 0;
    this.lastInTs = null;
    this.inputRestarted = false;
    // Generation: bumped at every hole in the content (cut). The output must
    // resync on a keyframe whenever it crosses a generation boundary.
    this.gen = 0;
    this.outGen = 0;
    // Output timeline.
    this.outOffset = 0;
    this.lastOutTs = { [TAG_AUDIO]: -1, [TAG_VIDEO]: -1, [TAG_SCRIPT]: -1 };
    this.lastOutAny = -1;
    this.lastVideoPts = -1; // display time of the latest-shown frame (B-frames display out of order)
    this.needKeyframe = true;
    this.headersSent = false;
    this.stats = { inTags: 0, outTags: 0, dropped: 0, inBytes: 0, outBytes: 0, lastInAt: 0, lastOutAt: 0 };
    this._rate = { at: 0, inBytes: 0, outBytes: 0, inKbps: 0, outKbps: 0 };
    this._timer = null;
    this._auto = false;
  }

  // Let the engine release due tags on its own (real clock).
  start() { this._auto = true; this._arm(); }
  stop() { this._auto = false; clearTimeout(this._timer); this._timer = null; }

  _arm() {
    if (!this._auto) return;
    clearTimeout(this._timer);
    this._timer = null;
    if (!this.buffer.length) return;
    const wait = this.buffer.peek().recv + this.delayMs - Date.now();
    this._timer = setTimeout(() => { this._timer = null; this.tick(); }, Math.max(0, wait));
  }

  inputRestart() {
    this.inputRestarted = true;
  }

  // `newSession`: the next output is a brand-new broadcast, so restart its clock at 0.
  outputRestart(newSession = false) {
    this.headersSent = false;
    this.needKeyframe = true;
    if (newSession) {
      this.lastOutTs = { [TAG_AUDIO]: -1, [TAG_VIDEO]: -1, [TAG_SCRIPT]: -1 };
      this.lastOutAny = -1;
      this.lastVideoPts = -1;
    }
  }

  // Output offset that places keyframe `tag` right after everything already sent,
  // in both decode order and display order.
  _offsetAfterSent(tag) {
    const next = Math.max(this.lastOutAny + FRAME_GAP_MS, this.lastVideoPts + FRAME_GAP_MS - (tag.cts || 0));
    return next - tag.ts;
  }

  push(tag, now = Date.now()) {
    // Normalize the input timeline so it never runs backwards.
    if (this.lastInTs !== null && (this.inputRestarted || tag.ts + this.inOffset < this.lastInTs - 1000)) {
      this.inOffset = this.lastInTs + FRAME_GAP_MS - tag.ts;
    }
    this.inputRestarted = false;
    const ts = tag.ts + this.inOffset;
    if (!tag.isSeq) this.lastInTs = Math.max(this.lastInTs ?? ts, ts);

    this.buffer.push({ ...tag, ts, recv: now, gen: this.gen });
    this.bufferedBytes += tag.data.length;
    this.stats.inTags++;
    this.stats.inBytes += tag.data.length;
    this.stats.lastInAt = now;
    this.tick(now);
  }

  setDelay(ms, now = Date.now()) {
    const next = clamp(Math.round(ms), 0, this.maxDelayMs);
    if (next < this.delayMs) this._skipForward(next, now);
    const prev = this.delayMs;
    this.delayMs = next;
    this.emit('delay', { from: prev, to: next });
    this.tick(now, true);
  }

  // Throw away the newest `ms` of buffered content (e.g. something that must not
  // reach viewers). The delay stays the same: when the output reaches the hole it
  // pauses until live content has filled it again. Returns the ms removed.
  cut(ms, now = Date.now()) {
    const from = now - Math.max(0, ms);
    let keep = this.buffer.length;
    while (keep > 0 && this.buffer.at(keep - 1).recv >= from) keep--;
    const removed = this.buffer.length - keep;
    if (!removed) return 0;
    const first = this.buffer.at(keep);
    const removedMs = now - first.recv;
    for (let i = keep; i < this.buffer.length; i++) {
      const t = this.buffer.at(i);
      this.bufferedBytes -= t.data.length;
      this.stats.dropped++;
    }
    this.buffer.truncate(keep);
    this.gen++;
    this.lastInTs = null; // next input tag starts a fresh (monotonic) input timeline
    this.emit('cut', { ms: removedMs, tags: removed });
    this.tick(now, true);
    return removedMs;
  }

  // Drop buffered content so that what is due under the new (smaller) delay
  // starts on a keyframe.
  _skipForward(newDelay, now) {
    let k = -1;
    for (let i = 0; i < this.buffer.length; i++) {
      const t = this.buffer.at(i);
      if (t.recv + newDelay > now) break;
      if (t.type === TAG_VIDEO && t.isKey && !t.isSeq) k = i;
    }
    if (k === -1) {
      for (let i = 0; i < this.buffer.length; i++) {
        const t = this.buffer.at(i);
        if (t.type === TAG_VIDEO && t.isKey && !t.isSeq) { k = i; break; }
      }
    }
    if (k <= 0) return;

    const key = this.buffer.at(k);
    const keyTs = key.ts;
    const kept = [];
    let bytes = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const t = this.buffer.at(i);
      if ((i >= k && !(t.type === TAG_AUDIO && t.ts < keyTs && !t.isSeq)) || t.isSeq) {
        kept.push(t); // never lose codec config changes
        bytes += t.data.length;
      } else {
        this.stats.dropped++;
      }
    }
    this.buffer.replace(kept);
    this.bufferedBytes = bytes;
    // Make the keyframe follow the last frame we sent, so the output stays continuous.
    if (this.lastOutAny >= 0 && key.gen === this.outGen) this.outOffset = this._offsetAfterSent(key);
  }

  tick(now = Date.now(), rearm = false) {
    let shifted = false;
    while (this.buffer.length && (this.buffer.peek().recv + this.delayMs <= now || this.bufferedBytes > this.maxBufferBytes)) {
      const tag = this.buffer.shift();
      this.bufferedBytes -= tag.data.length;
      this._emitTag(tag, now);
      shifted = true;
    }
    // Re-arm only when the head (or the delay) changed; a push behind a pending timer needs nothing.
    if (rearm || shifted || !this._timer) this._arm();
  }

  _emitTag(tag, now) {
    if (tag.gen !== this.outGen) { this.outGen = tag.gen; this.needKeyframe = true; }
    if (this.needKeyframe) {
      // Remember codec config seen while waiting; it is sent right before the keyframe.
      if (tag.isSeq) { this.headers.set(tag.type, tag.data); return; }
      if (!(tag.type === TAG_VIDEO && tag.isKey)) { this.stats.dropped++; return; }
      if (this.lastOutAny >= 0) this.outOffset = this._offsetAfterSent(tag);
      else this.outOffset = -tag.ts; // first frame ever starts at 0
      this.needKeyframe = false;
      this.headersSent = false;
    }
    if (!this.headersSent) {
      const base = Math.max(0, tag.ts + this.outOffset);
      for (const type of [TAG_SCRIPT, TAG_VIDEO, TAG_AUDIO]) {
        const data = this.headers.get(type);
        if (data) this._send({ type, ts: base, data, header: true }, now);
      }
      this.headersSent = true;
    }
    if (tag.isSeq) this.headers.set(tag.type, tag.data);

    let ts = Math.max(0, tag.ts + this.outOffset);
    // Keep each track monotonic (players and Twitch ingest dislike going backwards).
    if (ts < this.lastOutTs[tag.type]) ts = this.lastOutTs[tag.type];
    this.lastOutTs[tag.type] = ts;
    if (!tag.isSeq) this.lastOutAny = Math.max(this.lastOutAny, ts);
    if (tag.type === TAG_VIDEO && !tag.isSeq) this.lastVideoPts = Math.max(this.lastVideoPts, ts + (tag.cts || 0));

    this._send({ type: tag.type, ts, data: tag.data, header: tag.isSeq, isKey: tag.isKey }, now);
  }

  _send(out, now) {
    this.stats.outTags++;
    this.stats.outBytes += out.data.length;
    this.stats.lastOutAt = now;
    this.emit('tag', out);
  }

  // Time until the next buffered tag is due (Infinity when the buffer is empty).
  nextDueMs(now = Date.now()) {
    return this.buffer.length ? Math.max(0, this.buffer.peek().recv + this.delayMs - now) : Infinity;
  }

  status(now = Date.now()) {
    const bufferedMs = this.buffer.length ? now - this.buffer.peek().recv : 0;
    const live = now - this.stats.lastInAt < 3000;
    // While the delay is being raised the buffer holds less than the target.
    const filling = live && this.delayMs - bufferedMs > 300;
    const r = this._rate;
    if (now - r.at >= 1000) {
      const dt = (now - r.at) / 1000;
      if (r.at) {
        r.inKbps = Math.round((this.stats.inBytes - r.inBytes) * 8 / 1000 / dt);
        r.outKbps = Math.round((this.stats.outBytes - r.outBytes) * 8 / 1000 / dt);
      }
      r.at = now; r.inBytes = this.stats.inBytes; r.outBytes = this.stats.outBytes;
    }
    return {
      delayMs: this.delayMs,
      bufferedMs,
      // Delay viewers actually experience right now.
      effectiveDelayMs: filling ? bufferedMs : this.delayMs,
      filling,
      fillProgress: this.delayMs ? Math.min(1, bufferedMs / this.delayMs) : 1,
      inputActive: live,
      outputActive: now - this.stats.lastOutAt < 3000,
      bufferTags: this.buffer.length,
      bufferedBytes: this.bufferedBytes,
      inKbps: live ? r.inKbps : 0,
      outKbps: now - this.stats.lastOutAt < 3000 ? r.outKbps : 0,
      ...this.stats,
    };
  }
}

function clamp(v, lo, hi) {
  if (Number.isNaN(v)) return lo;
  return Math.min(hi, Math.max(lo, v)); // +Infinity -> hi (a huge value must not become "no delay")
}

module.exports = { DelayEngine, Deque };
