'use strict';
// What goes out while the real stream is paused (a "hold": the delay is being
// raised, a cut hole is being crossed, or OBS went away): the delay screen,
// encoded once for this very stream, repeated with ~10-byte skip frames, plus
// AAC silence. Ingests see a normal live stream instead of a dead connection.
//
// When the video can't be encoded for (HEVC/AV1, 10-bit, interlaced...) the
// last keyframe is repeated instead ("freeze").

const fs = require('fs');
const path = require('path');
const { ScreenEncoder, H264Error } = require('./h264');
const { prepareScreen } = require('./screen');
const { decodePng } = require('./png');
const { TAG_AUDIO, TAG_VIDEO } = require('./flv');

// Raw AAC-LC frames of digital silence (1024 samples), by channel count. Sample-rate independent.
const AAC_SILENCE = { 1: Buffer.from('01182007', 'hex'), 2: Buffer.from('211004608c1c', 'hex') };
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

const VIDEO_INTERVAL_MS = 100; // 10 fps of skip frames keeps players' clocks moving
const IDR_EVERY = 20; // a real keyframe every 2 s (Twitch's keyframe interval rule)
const FREEZE_INTERVAL_MS = 1000;
const DEFAULT_SCREEN = path.join(__dirname, '..', 'public', 'screen.png');
// Nominal 1080p x264 sequence header, used to size the screen before OBS has connected.
const NOMINAL_AVCC = Buffer.from('01640028ffe1001967640028acb403c0113f2e0220000003002000000781e3065401000468ef0fcbfdf8f800', 'hex');

// FLV audio tag body of an AAC sequence header -> { headerByte, sampleRate, channels } (or null).
function parseAudioHeader(data) {
  if (!data || data.length < 4 || (data[0] >> 4) !== 10) return null;
  const asc = data.subarray(2);
  const objectType = asc[0] >> 3;
  const rateIndex = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  const channels = (asc[1] >> 3) & 0x0f;
  if (objectType === 31 || rateIndex === 15) return null; // extended forms; OBS does not use them
  return { headerByte: data[0], sampleRate: AAC_RATES[rateIndex] || 48000, channels };
}

class HoldSource {
  constructor({ log = () => {}, qp = 22 } = {}) {
    this.log = log;
    this.qp = qp;
    this.mode = 'screen'; // 'screen' | 'freeze' | 'off'
    this.imagePath = null; // null = built-in screen
    this._rgba = null;
    this._cache = new Map(); // avcC hex -> { encoder, idr, error }
    this._warned = new Set();
  }

  // mode: 'screen' (built-in or custom picture), 'freeze', 'off'. imagePath: PNG file or null.
  setScreen(mode, imagePath = null) {
    this.mode = mode;
    this.imagePath = imagePath || null;
    this._rgba = null;
    this._cache.clear();
    this._warned.clear();
  }

  get enabled() { return this.mode !== 'off'; }

  _image() {
    if (this._rgba) return this._rgba;
    const file = this.imagePath || DEFAULT_SCREEN;
    try {
      this._rgba = decodePng(fs.readFileSync(file));
    } catch (e) {
      if (this.imagePath) {
        this.log(`delay screen "${this.imagePath}" cannot be used (${e.message}); using the built-in screen`);
        this._rgba = decodePng(fs.readFileSync(DEFAULT_SCREEN));
      } else throw e;
    }
    return this._rgba;
  }

  // Encoded screen for a stream (cached per sequence header). Returns { encoder, idr } or { error }.
  _prepared(avcC) {
    const key = avcC.toString('hex');
    let p = this._cache.get(key);
    if (p) return p;
    try {
      const encoder = new ScreenEncoder(avcC, { qp: this.qp });
      const planes = prepareScreen(this._image(), encoder);
      const t0 = Date.now();
      const { nal } = encoder.encodeIdr(planes);
      const idr = Buffer.concat([Buffer.from([0x17, 1, 0, 0, 0]), encoder.packNals([encoder.pps, nal])]);
      p = { encoder, idr, header: Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), encoder.avcC]), ms: Date.now() - t0 };
      this.log(`delay screen ready: ${encoder.width}x${encoder.height}, ${(idr.length / 1024).toFixed(0)} KB per keyframe (encoded in ${p.ms} ms)`);
    } catch (e) {
      p = { error: e instanceof H264Error || /PNG|picture/.test(e.message) ? e.message : (e.stack || String(e)) };
    }
    this._cache.set(key, p);
    return p;
  }

  // For the dock: what the screen costs on this stream (or a nominal 1080p one).
  info(videoHeader) {
    const avcC = videoHeader && videoHeader.length > 5 && (videoHeader[0] & 0x0f) === 7 ? videoHeader.subarray(5) : NOMINAL_AVCC;
    if (this.mode !== 'screen') return { mode: this.mode };
    const p = this._prepared(avcC);
    if (p.error) return { mode: 'freeze', reason: p.error };
    const kbps = Math.round(p.idr.length * 8 / 1000 / (IDR_EVERY * VIDEO_INTERVAL_MS / 1000));
    return { mode: 'screen', width: p.encoder.width, height: p.encoder.height, frameBytes: p.idr.length, kbps, nominal: avcC === NOMINAL_AVCC };
  }

  // headers: Map(type -> sequence header data) as kept by the delay engine; lastKeyframe: last video keyframe data sent.
  session({ headers, lastKeyframe }) {
    if (this.mode === 'off') return null;
    const videoHeader = headers.get(TAG_VIDEO);
    const audio = parseAudioHeader(headers.get(TAG_AUDIO));
    let video = null;
    const isAvc = videoHeader && (videoHeader[0] & 0x0f) === 7 && !(videoHeader[0] & 0x80);
    if (this.mode === 'screen' && isAvc) {
      const p = this._prepared(videoHeader.subarray(5));
      if (p.error) {
        if (!this._warned.has(p.error)) { this._warned.add(p.error); this.log(`delay screen unavailable for this stream (${p.error}); freezing the last frame instead`); }
      } else video = { kind: 'screen', header: p.header, idr: p.idr, encoder: p.encoder };
    }
    if (!video && lastKeyframe) video = { kind: 'freeze', keyframe: lastKeyframe };
    if (!video && !audio) return null;
    return new HoldSession(video, audio);
  }
}

class HoldSession {
  constructor(video, audio) {
    this.video = video;
    this.audio = audio && AAC_SILENCE[audio.channels] ? audio : null;
    this.kind = video ? video.kind : 'audio';
    this.videoIntervalMs = video && video.kind === 'screen' ? VIDEO_INTERVAL_MS : FREEZE_INTERVAL_MS;
    this.audioIntervalMs = this.audio ? 1024000 / this.audio.sampleRate : 0;
  }

  // Tags for the k-th video tick (k = 0 at the start of the hold).
  videoTags(k) {
    const v = this.video;
    if (!v) return [];
    if (v.kind === 'freeze') return [{ type: TAG_VIDEO, data: v.keyframe, isKey: true }];
    const n = k % IDR_EVERY;
    if (n === 0) {
      const tags = [{ type: TAG_VIDEO, data: v.idr, isKey: true }];
      if (k === 0) tags.unshift({ type: TAG_VIDEO, data: v.header, header: true });
      return tags;
    }
    return [{ type: TAG_VIDEO, data: Buffer.concat([Buffer.from([0x27, 1, 0, 0, 0]), v.encoder.packNals([v.encoder.encodeSkip(n)])]), isKey: false }];
  }

  audioTag() {
    if (!this.audio) return null;
    return { type: TAG_AUDIO, data: Buffer.concat([Buffer.from([this.audio.headerByte, 1]), AAC_SILENCE[this.audio.channels]]) };
  }
}

module.exports = { HoldSource, HoldSession, parseAudioHeader, AAC_SILENCE, DEFAULT_SCREEN, VIDEO_INTERVAL_MS, IDR_EVERY };
