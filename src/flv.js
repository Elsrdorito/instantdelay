'use strict';
// Minimal incremental FLV demuxer / muxer. We only need tag boundaries,
// timestamps and a few flags (keyframe, codec sequence header).

const TAG_AUDIO = 8;
const TAG_VIDEO = 9;
const TAG_SCRIPT = 18;

class FlvParser {
  constructor(onTag) {
    this.onTag = onTag;
    this.buf = Buffer.alloc(0);
    this.gotHeader = false;
  }

  reset() {
    this.buf = Buffer.alloc(0);
    this.gotHeader = false;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let off = 0;
    if (!this.gotHeader) {
      if (this.buf.length < 13) return;
      if (this.buf.toString('latin1', 0, 3) !== 'FLV') throw new Error('not an FLV stream');
      off = this.buf.readUInt32BE(5) + 4; // header + PreviousTagSize0
      this.gotHeader = true;
    }
    while (this.buf.length - off >= 11) {
      const type = this.buf[off] & 0x1f;
      const size = this.buf.readUIntBE(off + 1, 3);
      const total = 11 + size + 4;
      if (this.buf.length - off < total) break;
      const ts = (this.buf.readUIntBE(off + 4, 3) | (this.buf[off + 7] << 24)) >>> 0;
      const data = Buffer.from(this.buf.subarray(off + 11, off + 11 + size));
      off += total;
      if (type === TAG_AUDIO || type === TAG_VIDEO || type === TAG_SCRIPT) {
        this.onTag(describe(type, ts, data));
      }
    }
    this.buf = this.buf.subarray(off);
  }
}

function describe(type, ts, data) {
  // cts = composition time offset (display time - decode time), non-zero with B-frames.
  const tag = { type, ts, data, isKey: false, isSeq: false, cts: 0 };
  if (type === TAG_VIDEO && data.length >= 2) {
    const b0 = data[0];
    if (b0 & 0x80) {
      // Enhanced RTMP (HEVC/AV1 from OBS 29+): ExHeader, PacketType in low nibble
      const packetType = b0 & 0x0f;
      tag.isKey = ((b0 >> 4) & 0x07) === 1;
      tag.isSeq = packetType === 0;
      if (packetType === 1 && data.length >= 8) tag.cts = data.readIntBE(5, 3); // CodedFrames
    } else {
      const codec = b0 & 0x0f;
      tag.isKey = (b0 >> 4) === 1;
      tag.isSeq = (codec === 7 || codec === 12) && data[1] === 0;
      if ((codec === 7 || codec === 12) && data[1] === 1 && data.length >= 5) tag.cts = data.readIntBE(2, 3);
    }
  } else if (type === TAG_AUDIO && data.length >= 2) {
    tag.isSeq = (data[0] >> 4) === 10 && data[1] === 0; // AAC sequence header
  } else if (type === TAG_SCRIPT) {
    // onMetaData is codec config (re-sent on output restart); other script data passes through.
    tag.isSeq = data.length > 13 && data[0] === 2 && data.readUInt16BE(1) === 10 && data.toString('latin1', 3, 13) === 'onMetaData';
  }
  return tag;
}

function flvHeader() {
  // FLV v1, audio+video, header size 9, PreviousTagSize0 = 0
  return Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0, 0, 0, 9, 0, 0, 0, 0]);
}

function encodeTag(type, ts, data) {
  const out = Buffer.alloc(11 + data.length + 4);
  out[0] = type;
  out.writeUIntBE(data.length, 1, 3);
  out.writeUIntBE(ts & 0xffffff, 4, 3);
  out[7] = (ts >>> 24) & 0xff;
  data.copy(out, 11);
  out.writeUInt32BE(11 + data.length, 11 + data.length);
  return out;
}

module.exports = { FlvParser, describe, flvHeader, encodeTag, TAG_AUDIO, TAG_VIDEO, TAG_SCRIPT };
