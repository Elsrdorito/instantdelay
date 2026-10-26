'use strict';
const test = require('node:test');
const assert = require('node:assert');
const amf = require('../src/rtmp/amf0');
const { ChunkReader, ChunkWriter, MSG } = require('../src/rtmp/chunk');

test('amf0 round trip', () => {
  const vals = ['connect', 1, { app: 'app', flashVer: 'FMLE/3.0', tcUrl: 'rtmp://x/app', nested: { a: true, b: null } }, null, undefined, [1, 'two', false], 'x'.repeat(70000)];
  const buf = amf.encode(...vals);
  const back = amf.decodeAll(buf);
  assert.deepStrictEqual(back, vals);
});

test('amf0 decodes ECMA arrays and typed objects', () => {
  // onMetaData as OBS sends it: string + ECMA array
  const body = Buffer.concat([
    amf.encode('onMetaData'),
    Buffer.from([0x08, 0, 0, 0, 2]),
    amf.encodeString('width', false), amf.encode(1920),
    amf.encodeString('encoder', false), amf.encode('obs'),
    Buffer.from([0, 0, 9]),
  ]);
  assert.deepStrictEqual(amf.decodeAll(body), ['onMetaData', { width: 1920, encoder: 'obs' }]);
  assert.strictEqual(amf.leadingString(body), 'onMetaData');
  const wrapped = Buffer.concat([amf.encode('@setDataFrame'), body]);
  assert.ok(amf.stripLeadingString(wrapped, '@setDataFrame').equals(body));
});

test('chunk stream round trip across chunk sizes, csids, timestamps and extended timestamps', () => {
  const w = new ChunkWriter();
  w.chunkSize = 100;
  const got = [];
  const r = new ChunkReader((m) => got.push(m));
  const feed = (b) => { for (let i = 0; i < b.length; i += 7) r.push(b.subarray(i, Math.min(b.length, i + 7))); }; // dribble
  const msgs = [
    [2, MSG.SET_CHUNK_SIZE, 0, 0, Buffer.from([0, 0, 0, 100])],
    [3, MSG.COMMAND_AMF0, 0, 0, Buffer.alloc(250, 1)],
    [6, MSG.VIDEO, 1, 1000, Buffer.alloc(1000, 2)],
    [6, MSG.VIDEO, 1, 1033, Buffer.alloc(10, 3)],
    [4, MSG.AUDIO, 1, 1010, Buffer.alloc(5, 4)],
    [6, MSG.VIDEO, 1, 1066, Buffer.alloc(333, 5)],
    [400, MSG.DATA_AMF0, 1, 500, Buffer.alloc(1, 6)],
    [6, MSG.VIDEO, 1, 0x1000000 + 5, Buffer.alloc(300, 7)], // extended timestamp
    [6, MSG.VIDEO, 1, 0x1000000 + 38, Buffer.alloc(300, 8)],
    [6, MSG.VIDEO, 1, 0x1000000 + 71, Buffer.alloc(3, 9)],
    [6, MSG.VIDEO, 1, 20, Buffer.alloc(3, 10)], // timestamp went backwards -> absolute header
  ];
  for (const [csid, type, msid, ts, payload] of msgs) feed(w.encode(csid, type, msid, ts, payload));
  assert.strictEqual(got.length, msgs.length);
  msgs.forEach(([csid, type, msid, ts, payload], i) => {
    assert.strictEqual(got[i].csid, csid, `csid ${i}`);
    assert.strictEqual(got[i].type, type, `type ${i}`);
    assert.strictEqual(got[i].msid, msid, `msid ${i}`);
    assert.strictEqual(got[i].ts, ts, `ts ${i}`);
    assert.ok(got[i].payload.equals(payload), `payload ${i}`);
  });
});

test('chunk reader handles fmt 3 new messages (same size, same delta)', () => {
  // Hand-built: fmt0 csid 4 ts 0 len 2 type 8 msid 1 + payload; then fmt3 header + payload x2
  const first = Buffer.from([0x04, 0, 0, 0, 0, 0, 2, 8, 1, 0, 0, 0, 0xaa, 0xbb]);
  const next = Buffer.from([0xc4, 0xcc, 0xdd]);
  const got = [];
  const r = new ChunkReader((m) => got.push(m));
  r.push(Buffer.concat([first, next, next]));
  assert.deepStrictEqual(got.map((m) => m.ts), [0, 0, 0]);
  const first2 = Buffer.from([0x04, 0, 0, 40, 0, 0, 2, 8, 1, 0, 0, 0, 0xaa, 0xbb]);
  got.length = 0;
  r.push(Buffer.concat([first2, next, next]));
  assert.deepStrictEqual(got.map((m) => m.ts), [40, 80, 120], 'fmt0 timestamp acts as delta for following fmt3 messages');
});

test('chunk reader: bogus headers cannot tie up memory, chunk size 0 and giant messages are refused', () => {
  const r = new ChunkReader(() => {});
  // 7 MB declared on many chunk streams, one 128-byte chunk each.
  assert.throws(() => {
    for (let csid = 3; csid < 60; csid++) r.push(Buffer.concat([Buffer.from([csid, 0, 0, 0, 0x70, 0, 0, 9, 1, 0, 0, 0]), Buffer.alloc(128, 0xaa)]));
  }, /too (much data|many)/);
  assert.ok(r.inFlightBytes <= 32 * 1024 * 1024);
  assert.throws(() => new ChunkReader(() => {}).push(Buffer.from([3, 0, 0, 0, 0xff, 0xff, 0xff, 9, 1, 0, 0, 0, 0xaa])), /too large/);
  const r2 = new ChunkReader(() => {});
  assert.throws(() => r2.push(Buffer.from([0x02, 0, 0, 0, 0, 0, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0])), /chunk size 0/);
});

test('chunk reader: a new header in the middle of a message abandons the old one', () => {
  const got = [];
  const r = new ChunkReader((m) => got.push(m));
  r.chunkSize = 128;
  // message A: len 200, first 128 bytes
  r.push(Buffer.concat([Buffer.from([0x04, 0, 0, 0, 0, 0, 200, 8, 1, 0, 0, 0]), Buffer.alloc(128, 1)]));
  // then a fresh fmt0 header on the same csid: len 2
  r.push(Buffer.from([0x04, 0, 0, 10, 0, 0, 2, 8, 1, 0, 0, 0, 7, 7]));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].ts, 10);
  assert.ok(got[0].payload.equals(Buffer.from([7, 7])));
  assert.strictEqual(r.inFlightBytes, 0);
});

test('chunk reader: payload streams in without re-buffering (byte-at-a-time)', () => {
  const w = new ChunkWriter();
  w.chunkSize = 4096;
  const got = [];
  const r = new ChunkReader((m) => got.push(m));
  r.push(w.encode(2, MSG.SET_CHUNK_SIZE, 0, 0, Buffer.from([0, 0, 0x10, 0])));
  const payload = Buffer.alloc(10000);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  const enc = w.encode(6, MSG.VIDEO, 1, 5, payload);
  for (let i = 0; i < enc.length; i++) r.push(enc.subarray(i, i + 1));
  assert.strictEqual(got.length, 2);
  assert.ok(got[1].payload.equals(payload));
  assert.strictEqual(r.rest, null);
});

test('flv describe: composition time only for avc1/hvc1 enhanced packets', () => {
  const { describe } = require('../src/flv');
  const av1 = describe(9, 0, Buffer.from([0x91, 0x61, 0x76, 0x30, 0x31, 0x12, 0x00, 0x0a, 0x99, 0x99]));
  assert.strictEqual(av1.cts, 0);
  assert.ok(av1.isKey);
  const hevc = describe(9, 0, Buffer.from([0x91, 0x68, 0x76, 0x63, 0x31, 0x00, 0x00, 0x42, 0x01]));
  assert.strictEqual(hevc.cts, 0x42);
  const h264 = describe(9, 0, Buffer.from([0x17, 0x01, 0x00, 0x00, 0x21, 0x01]));
  assert.strictEqual(h264.cts, 0x21);
});
