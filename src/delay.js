'use strict';
// Delay engine: holds incoming FLV tags in a wall-clock buffer and releases
// them `delayMs` after they arrived. Timestamps are rewritten so the output is
// one continuous stream no matter how often the delay changes or OBS reconnects.
//
//  - Lowering the delay  -> jump forward to a keyframe (viewers see a clean cut).
//  - Raising the delay   -> output pauses while the buffer fills up.

const { EventEmitter } = require('events');
const { TAG_VIDEO, TAG_AUDIO, TAG_SCRIPT } = require('./flv');

const FRAME_GAP_MS = 33;

class DelayEngine extends EventEmitter {
  constructor({ delayMs = 0, maxDelayMs = 300000 } = {}) {
    super();
    this.maxDelayMs = maxDelayMs;
    this.delayMs = clamp(delayMs, 0, maxDelayMs);
    this.buffer = [];
    // Latest codec config (metadata / AVC / AAC sequence headers); re-sent
    // whenever the output (re)starts.
    this.headers = new Map();
    // Input timeline: normalizes timestamps across OBS reconnects.
    this.inOffset = 0;
    this.lastInTs = null;
    this.inputRestarted = false;
    // Output timeline.
    this.outOffset = 0;
    this.lastOutTs = { [TAG_AUDIO]: -1, [TAG_VIDEO]: -1, [TAG_SCRIPT]: -1 };
    this.lastOutAny = -1;
    this.lastVideoPts = -1; // display time of the latest-shown frame (B-frames display out of order)
    this.needKeyframe = true;
    this.headersSent = false;
    this.stats = { inTags: 0, outTags: 0, dropped: 0, lastInAt: 0, lastOutAt: 0 };
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
    const headerKey = tag.isSeq ? `${tag.type}` : null;
    if (headerKey) this.headers.set(headerKey, tag.data);

    // Normalize the input timeline so it never runs backwards.
    if (this.lastInTs !== null && (this.inputRestarted || tag.ts + this.inOffset < this.lastInTs - 1000)) {
      this.inOffset = this.lastInTs + FRAME_GAP_MS - tag.ts;
    }
    this.inputRestarted = false;
    const ts = tag.ts + this.inOffset;
    if (!tag.isSeq) this.lastInTs = Math.max(this.lastInTs ?? ts, ts);

    this.buffer.push({ ...tag, ts, recv: now });
    this.stats.inTags++;
    this.stats.lastInAt = now;
    this.tick(now);
  }

  setDelay(ms, now = Date.now()) {
    const next = clamp(Math.round(ms), 0, this.maxDelayMs);
    if (next < this.delayMs) this._skipForward(next, now);
    const prev = this.delayMs;
    this.delayMs = next;
    this.emit('delay', { from: prev, to: next });
    this.tick(now);
  }

  // Drop buffered content so that what is due under the new (smaller) delay
  // starts on a keyframe.
  _skipForward(newDelay, now) {
    let k = -1;
    for (let i = 0; i < this.buffer.length; i++) {
      const t = this.buffer[i];
      if (t.recv + newDelay > now) break;
      if (t.type === TAG_VIDEO && t.isKey && !t.isSeq) k = i;
    }
    if (k === -1) k = this.buffer.findIndex((t) => t.type === TAG_VIDEO && t.isKey && !t.isSeq);
    if (k <= 0) return;

    const key = this.buffer[k];
    const keyTs = key.ts;
    const kept = [];
    for (let i = 0; i < this.buffer.length; i++) {
      const t = this.buffer[i];
      if (i >= k && !(t.type === TAG_AUDIO && t.ts < keyTs && !t.isSeq)) kept.push(t);
      else if (t.isSeq) kept.push(t); // never lose codec config changes
      else this.stats.dropped++;
    }
    this.buffer = kept;
    // Make the keyframe follow the last frame we sent, so the output stays continuous.
    if (this.lastOutAny >= 0) this.outOffset = this._offsetAfterSent(key);
  }

  tick(now = Date.now()) {
    while (this.buffer.length && this.buffer[0].recv + this.delayMs <= now) {
      this._emitTag(this.buffer.shift(), now);
    }
  }

  _emitTag(tag, now) {
    if (this.needKeyframe) {
      if (tag.isSeq) return; // headers are re-sent from this.headers below
      if (!(tag.type === TAG_VIDEO && tag.isKey)) { this.stats.dropped++; return; }
      if (this.lastOutAny >= 0) this.outOffset = this._offsetAfterSent(tag);
      else this.outOffset = -tag.ts; // first frame ever starts at 0
      this.needKeyframe = false;
    }
    if (!this.headersSent) {
      const base = Math.max(0, tag.ts + this.outOffset);
      for (const type of [TAG_SCRIPT, TAG_VIDEO, TAG_AUDIO]) {
        const data = this.headers.get(`${type}`);
        if (data) this.emit('tag', { type, ts: base, data, header: true });
      }
      this.headersSent = true;
      if (tag.isSeq) return;
    }

    let ts = Math.max(0, tag.ts + this.outOffset);
    // Keep each track monotonic (players and Twitch ingest dislike going backwards).
    if (ts < this.lastOutTs[tag.type]) ts = this.lastOutTs[tag.type];
    this.lastOutTs[tag.type] = ts;
    if (!tag.isSeq) this.lastOutAny = Math.max(this.lastOutAny, ts);
    if (tag.type === TAG_VIDEO && !tag.isSeq) this.lastVideoPts = Math.max(this.lastVideoPts, ts + (tag.cts || 0));

    this.stats.outTags++;
    this.stats.lastOutAt = now;
    this.emit('tag', { type: tag.type, ts, data: tag.data, header: tag.isSeq });
  }

  status(now = Date.now()) {
    const bufferedMs = this.buffer.length ? now - this.buffer[0].recv : 0;
    const live = now - this.stats.lastInAt < 3000;
    // While the delay is being raised the buffer holds less than the target.
    const filling = live && this.delayMs - bufferedMs > 300;
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
      ...this.stats,
    };
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));
}

module.exports = { DelayEngine };
