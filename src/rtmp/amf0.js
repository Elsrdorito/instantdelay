'use strict';
// AMF0 encoder/decoder: just what RTMP command and data messages need.

const T = { NUMBER: 0, BOOLEAN: 1, STRING: 2, OBJECT: 3, NULL: 5, UNDEFINED: 6, REFERENCE: 7,
  ECMA_ARRAY: 8, OBJECT_END: 9, STRICT_ARRAY: 10, DATE: 11, LONG_STRING: 12, XML: 15, TYPED_OBJECT: 16 };

// Decode every value in `buf` (from `offset`) into an array.
function decodeAll(buf, offset = 0) {
  const out = [];
  const r = { buf, off: offset };
  while (r.off < buf.length) out.push(readValue(r));
  return out;
}

function readValue(r) {
  const b = r.buf;
  const t = b[r.off++];
  switch (t) {
    case T.NUMBER: { const v = b.readDoubleBE(r.off); r.off += 8; return v; }
    case T.BOOLEAN: return b[r.off++] !== 0;
    case T.STRING: return readString(r, 2);
    case T.LONG_STRING: case T.XML: return readString(r, 4);
    case T.OBJECT: return readObject(r);
    case T.TYPED_OBJECT: readString(r, 2); return readObject(r);
    case T.ECMA_ARRAY: r.off += 4; return readObject(r);
    case T.STRICT_ARRAY: {
      const n = b.readUInt32BE(r.off); r.off += 4;
      const arr = [];
      for (let i = 0; i < n; i++) arr.push(readValue(r));
      return arr;
    }
    case T.DATE: { const v = b.readDoubleBE(r.off); r.off += 10; return new Date(v); }
    case T.NULL: return null;
    case T.UNDEFINED: return undefined;
    case T.REFERENCE: r.off += 2; return null;
    default: throw new Error(`AMF0: unsupported type ${t} at ${r.off - 1}`);
  }
}

function readString(r, lenBytes) {
  const b = r.buf;
  const n = lenBytes === 2 ? b.readUInt16BE(r.off) : b.readUInt32BE(r.off);
  r.off += lenBytes;
  if (r.off + n > b.length) throw new Error('AMF0: string past end');
  const s = b.toString('utf8', r.off, r.off + n);
  r.off += n;
  return s;
}

function readObject(r) {
  const obj = {};
  const b = r.buf;
  for (;;) {
    if (r.off + 3 <= b.length && b[r.off] === 0 && b[r.off + 1] === 0 && b[r.off + 2] === T.OBJECT_END) { r.off += 3; return obj; }
    const key = readString(r, 2);
    if (r.off >= b.length) throw new Error('AMF0: object past end');
    obj[key] = readValue(r);
  }
}

// Encode a list of JS values. Objects become AMF0 objects, arrays strict arrays.
function encode(...values) {
  const parts = [];
  for (const v of values) writeValue(parts, v);
  return Buffer.concat(parts);
}

function writeValue(parts, v) {
  if (v === null) parts.push(Buffer.from([T.NULL]));
  else if (v === undefined) parts.push(Buffer.from([T.UNDEFINED]));
  else if (typeof v === 'number') { const b = Buffer.alloc(9); b[0] = T.NUMBER; b.writeDoubleBE(v, 1); parts.push(b); }
  else if (typeof v === 'boolean') parts.push(Buffer.from([T.BOOLEAN, v ? 1 : 0]));
  else if (typeof v === 'string') parts.push(encodeString(v, true));
  else if (Array.isArray(v)) {
    const h = Buffer.alloc(5); h[0] = T.STRICT_ARRAY; h.writeUInt32BE(v.length, 1); parts.push(h);
    for (const x of v) writeValue(parts, x);
  } else if (typeof v === 'object') {
    parts.push(Buffer.from([T.OBJECT]));
    for (const [k, x] of Object.entries(v)) { parts.push(encodeString(k, false)); writeValue(parts, x); }
    parts.push(Buffer.from([0, 0, T.OBJECT_END]));
  } else throw new Error(`AMF0: cannot encode ${typeof v}`);
}

function encodeString(s, typed) {
  const str = Buffer.from(s, 'utf8');
  const long = str.length > 0xffff;
  const h = Buffer.alloc((typed ? 1 : 0) + (long ? 4 : 2));
  let o = 0;
  if (typed) h[o++] = long ? T.LONG_STRING : T.STRING;
  if (long) h.writeUInt32BE(str.length, o); else h.writeUInt16BE(str.length, o);
  return Buffer.concat([h, str]);
}

// If an AMF0 data message starts with the string `name`, return the rest.
function stripLeadingString(buf, name) {
  if (buf[0] !== T.STRING || buf.length < 3) return buf;
  const n = buf.readUInt16BE(1);
  if (n !== name.length || buf.toString('latin1', 3, 3 + n) !== name) return buf;
  return buf.subarray(3 + n);
}

function leadingString(buf) {
  if (buf[0] !== T.STRING || buf.length < 3) return null;
  const n = buf.readUInt16BE(1);
  return buf.length >= 3 + n ? buf.toString('utf8', 3, 3 + n) : null;
}

module.exports = { decodeAll, encode, encodeString, stripLeadingString, leadingString };
