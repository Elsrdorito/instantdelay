'use strict';
// RTMP chunk stream (Adobe RTMP spec §5.3): splits messages into chunks and
// reassembles them. Shared by the ingest server and the publish client.

const MSG = {
  SET_CHUNK_SIZE: 1, ABORT: 2, ACK: 3, USER_CONTROL: 4, WINDOW_ACK_SIZE: 5, SET_PEER_BW: 6,
  AUDIO: 8, VIDEO: 9, DATA_AMF3: 15, COMMAND_AMF3: 17, DATA_AMF0: 18, COMMAND_AMF0: 20,
};
// User control events (inside MSG.USER_CONTROL).
const UC = { STREAM_BEGIN: 0, STREAM_EOF: 1, SET_BUFFER_LENGTH: 3, PING_REQUEST: 6, PING_RESPONSE: 7 };
// Chunk stream ids we use for what we send (any id >= 3 is legal; these match ffmpeg).
const CSID = { CONTROL: 2, COMMAND: 3, AUDIO: 4, DATA: 5, VIDEO: 6, STREAM: 8 };

const DEFAULT_CHUNK_SIZE = 128;
const MAX_MESSAGE = 16 * 1024 * 1024;

class ChunkReader {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.chunkSize = DEFAULT_CHUNK_SIZE;
    this.streams = new Map(); // csid -> per-chunk-stream state
    this.pending = [];        // unparsed input chunks
    this.pendingBytes = 0;
    this.bytesIn = 0;
  }

  push(data) {
    this.bytesIn += data.length;
    this.pending.push(data);
    this.pendingBytes += data.length;
    let buf = this.pending.length === 1 ? data : Buffer.concat(this.pending, this.pendingBytes);
    let off = 0;
    for (;;) {
      const used = this._parseChunk(buf, off);
      if (used === 0) break; // need more data
      off += used;
    }
    if (off === buf.length) { this.pending = []; this.pendingBytes = 0; }
    else { this.pending = [buf.subarray(off)]; this.pendingBytes = buf.length - off; }
  }

  // Parses one chunk at `off`; returns bytes consumed (0 = incomplete).
  _parseChunk(buf, off) {
    const avail = buf.length - off;
    if (avail < 1) return 0;
    const b0 = buf[off];
    const fmt = b0 >> 6;
    let csid = b0 & 0x3f;
    let p = off + 1;
    if (csid === 0) { if (avail < 2) return 0; csid = 64 + buf[p++]; }
    else if (csid === 1) { if (avail < 3) return 0; csid = 64 + buf[p] + buf[p + 1] * 256; p += 2; }

    let st = this.streams.get(csid);
    if (!st) { st = { ts: 0, delta: 0, len: 0, type: 0, msid: 0, ext: false, buf: null, got: 0 }; this.streams.set(csid, st); }
    const hdrLen = [11, 7, 3, 0][fmt];
    if (buf.length - p < hdrLen) return 0;

    // Parse into locals first: a chunk that is not complete yet is parsed again later.
    let { ts, delta, len, type, msid, ext } = st;
    const starting = st.got === 0;
    if (fmt === 3) {
      // Extended timestamp is repeated on every chunk of a message that uses it (ffmpeg/librtmp behaviour).
      if (ext) { if (buf.length - p < 4) return 0; const e = buf.readUInt32BE(p); p += 4; if (starting) delta = e; }
      if (starting) ts = (ts + delta) >>> 0; // new message with the same header as the last one
    } else {
      let tsField = buf.readUIntBE(p, 3);
      if (fmt <= 1) { len = buf.readUIntBE(p + 3, 3); type = buf[p + 6]; }
      if (fmt === 0) msid = buf.readUInt32LE(p + 7);
      p += hdrLen;
      ext = tsField === 0xffffff;
      if (ext) { if (buf.length - p < 4) return 0; tsField = buf.readUInt32BE(p); p += 4; }
      if (fmt === 0) { ts = tsField; delta = tsField; } else { delta = tsField; ts = (ts + tsField) >>> 0; }
    }
    if (len > MAX_MESSAGE) throw new Error(`RTMP: message too large (${len})`);
    const want = Math.min(this.chunkSize, len - st.got);
    if (buf.length - p < want) return 0;

    // Commit.
    Object.assign(st, { ts, delta, len, type, msid, ext });
    if (starting) st.buf = Buffer.allocUnsafe(len);
    buf.copy(st.buf, st.got, p, p + want);
    st.got += want;
    p += want;
    if (st.got === st.len) {
      const msg = { csid, type: st.type, msid: st.msid, ts: st.ts, payload: st.buf };
      st.buf = null; st.got = 0;
      if (msg.type === MSG.SET_CHUNK_SIZE && msg.payload.length >= 4) this.chunkSize = msg.payload.readUInt32BE(0) & 0x7fffffff;
      this.onMessage(msg);
    }
    return p - off;
  }
}

class ChunkWriter {
  constructor() {
    this.chunkSize = DEFAULT_CHUNK_SIZE;
    this.last = new Map(); // csid -> { ts, len, type, msid }
  }

  // Returns a Buffer with `payload` split into chunks for (csid, type, msid, ts).
  encode(csid, type, msid, ts, payload) {
    ts >>>= 0;
    const prev = this.last.get(csid);
    let fmt = 0;
    let tsField = ts;
    if (prev && prev.msid === msid && ts >= prev.ts) {
      fmt = 1;
      tsField = ts - prev.ts;
    }
    const ext = tsField >= 0xffffff;
    this.last.set(csid, { ts, len: payload.length, type, msid });

    const csidLen = csid < 64 ? 1 : csid < 320 ? 2 : 3;
    const first = csidLen + (fmt === 0 ? 11 : 7) + (ext ? 4 : 0);
    const nChunks = Math.max(1, Math.ceil(payload.length / this.chunkSize));
    const cont = csidLen + (ext ? 4 : 0);
    const out = Buffer.allocUnsafe(first + payload.length + (nChunks - 1) * cont);
    let o = this._basicHeader(out, 0, fmt, csid);
    const f = ext ? 0xffffff : tsField;
    out.writeUIntBE(f, o, 3); o += 3;
    out.writeUIntBE(payload.length, o, 3); o += 3;
    out[o++] = type;
    if (fmt === 0) { out.writeUInt32LE(msid, o); o += 4; }
    if (ext) { out.writeUInt32BE(tsField, o); o += 4; }
    let p = 0;
    for (let i = 0; i < nChunks; i++) {
      if (i > 0) {
        o = this._basicHeader(out, o, 3, csid);
        if (ext) { out.writeUInt32BE(tsField, o); o += 4; }
      }
      const n = Math.min(this.chunkSize, payload.length - p);
      payload.copy(out, o, p, p + n);
      o += n; p += n;
    }
    return out;
  }

  _basicHeader(out, o, fmt, csid) {
    if (csid < 64) { out[o++] = (fmt << 6) | csid; }
    else if (csid < 320) { out[o++] = fmt << 6; out[o++] = csid - 64; }
    else { out[o++] = (fmt << 6) | 1; out[o++] = (csid - 64) & 0xff; out[o++] = (csid - 64) >> 8; }
    return o;
  }
}

// Protocol control message payloads.
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
function setChunkSize(n) { return { type: MSG.SET_CHUNK_SIZE, payload: u32(n) }; }
function ack(n) { return { type: MSG.ACK, payload: u32(n) }; }
function windowAckSize(n) { return { type: MSG.WINDOW_ACK_SIZE, payload: u32(n) }; }
function setPeerBandwidth(n, limitType = 2) { return { type: MSG.SET_PEER_BW, payload: Buffer.concat([u32(n), Buffer.from([limitType])]) }; }
function userControl(event, value) {
  const b = Buffer.alloc(6); b.writeUInt16BE(event, 0); b.writeUInt32BE(value >>> 0, 2);
  return { type: MSG.USER_CONTROL, payload: b };
}

module.exports = { ChunkReader, ChunkWriter, MSG, UC, CSID, setChunkSize, ack, windowAckSize, setPeerBandwidth, userControl };
