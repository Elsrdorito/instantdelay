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
