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
// A 4K keyframe at a high bitrate is ~1-2 MB; anything bigger is not a media message.
const MAX_MESSAGE = 8 * 1024 * 1024;
// Memory a peer can tie up with half-received messages, before any stream-key check.
const MAX_IN_FLIGHT_MESSAGES = 32;
const MAX_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
const HANDSHAKE_BYTES = 1 + 1536 + 1536;

class ChunkReader {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.chunkSize = DEFAULT_CHUNK_SIZE;
    this.streams = new Map(); // csid -> per-chunk-stream state
    this.rest = null;         // unparsed bytes (at most a chunk header)
    this.cur = null;          // chunk whose payload is still streaming in: { st, remaining }
    this.bytesIn = HANDSHAKE_BYTES; // acknowledgements count from the start of the connection
    this.inFlightBytes = 0;
  }

  push(data) {
    this.bytesIn += data.length;
    let buf = this.rest ? Buffer.concat([this.rest, data]) : data;
    this.rest = null;
    let off = 0;
    for (;;) {
      if (this.cur) {
        // Payload of the current chunk: copy straight into the message, no reassembly buffer.
        const n = Math.min(this.cur.remaining, buf.length - off);
        this._payload(this.cur.st, buf, off, n);
        off += n;
        this.cur.remaining -= n;
        if (this.cur.remaining) break;
        this.cur = null;
      }
      const used = this._parseHeader(buf, off);
      if (used === 0) break; // need more data for the header
      off += used;
    }
    if (off < buf.length) this.rest = Buffer.from(buf.subarray(off));
  }

  // Parses one chunk header at `off` and sets up this.cur for its payload.
  // Returns bytes consumed (0 = incomplete header; nothing is committed).
  _parseHeader(buf, off) {
    const avail = buf.length - off;
    if (avail < 1) return 0;
    const b0 = buf[off];
    const fmt = b0 >> 6;
    let csid = b0 & 0x3f;
    let p = off + 1;
    if (csid === 0) { if (avail < 2) return 0; csid = 64 + buf[p++]; }
    else if (csid === 1) { if (avail < 3) return 0; csid = 64 + buf[p] + buf[p + 1] * 256; p += 2; }

    let st = this.streams.get(csid);
    if (!st) {
      if (this.streams.size >= MAX_IN_FLIGHT_MESSAGES * 4) throw new Error('RTMP: too many chunk streams');
      st = { csid, ts: 0, delta: 0, len: 0, type: 0, msid: 0, ext: false, buf: null, got: 0 };
      this.streams.set(csid, st);
    }
    const hdrLen = [11, 7, 3, 0][fmt];
    if (buf.length - p < hdrLen) return 0;

    let { ts, delta, len, type, msid, ext } = st;
    if (fmt === 3) {
      if (ext) { if (buf.length - p < 4) return 0; const e = buf.readUInt32BE(p); p += 4; if (st.got === 0) delta = e; }
      if (st.got === 0) ts = (ts + delta) >>> 0; // new message with the same header as the last one
    } else {
      let tsField = buf.readUIntBE(p, 3);
      if (fmt <= 1) { len = buf.readUIntBE(p + 3, 3); type = buf[p + 6]; }
      if (fmt === 0) msid = buf.readUInt32LE(p + 7);
      p += hdrLen;
      ext = tsField === 0xffffff;
      if (ext) { if (buf.length - p < 4) return 0; tsField = buf.readUInt32BE(p); p += 4; }
      if (fmt === 0) { ts = tsField; delta = tsField; } else { delta = tsField; ts = (ts + tsField) >>> 0; }
      if (st.got) this._abandon(st); // a new header in the middle of a message: the old one is gone
    }
    if (len > MAX_MESSAGE) throw new Error(`RTMP: message too large (${len})`);

    // Commit.
    Object.assign(st, { ts, delta, len, type, msid, ext });
    if (st.got === 0) {
      if (this.inFlightBytes + len > MAX_IN_FLIGHT_BYTES) throw new Error('RTMP: too much data in flight');
      let inFlight = 0;
      for (const s of this.streams.values()) if (s.got) inFlight++;
      if (inFlight >= MAX_IN_FLIGHT_MESSAGES) throw new Error('RTMP: too many partial messages');
      st.buf = Buffer.allocUnsafe(len);
      this.inFlightBytes += len;
    }
    this.cur = { st, remaining: Math.min(this.chunkSize, st.len - st.got) };
    if (this.cur.remaining === 0) { this.cur = null; this._payload(st, buf, p, 0); }
    return p - off;
  }

  _abandon(st) {
    this.inFlightBytes -= st.len;
    st.buf = null;
    st.got = 0;
  }

  _payload(st, buf, p, n) {
    if (n) { buf.copy(st.buf, st.got, p, p + n); st.got += n; }
    if (st.got < st.len) return;
    const msg = { csid: st.csid, type: st.type, msid: st.msid, ts: st.ts, payload: st.buf };
    this.inFlightBytes -= st.len;
    st.buf = null; st.got = 0;
    if (msg.type === MSG.SET_CHUNK_SIZE && msg.payload.length >= 4) {
      const size = msg.payload.readUInt32BE(0) & 0x7fffffff;
      if (size < 1) throw new Error('RTMP: chunk size 0');
      this.chunkSize = size;
    } else if (msg.type === MSG.ABORT && msg.payload.length >= 4) {
      const s = this.streams.get(msg.payload.readUInt32BE(0));
      if (s && s.got) this._abandon(s);
    }
    this.onMessage(msg);
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
