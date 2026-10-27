'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { once } = require('events');
const { ObsWebSocket, authString } = require('../src/obsws');

const skip = typeof globalThis.WebSocket === 'function' ? false : 'needs Node 22+ (global WebSocket client)';
const PASSWORD = 'hunter2';

// Just enough WebSocket to talk to one obs-websocket v5 client: text frames,
// 7/16/64-bit lengths, client->server frames unmasked, close handshake.
function encodeFrame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([head, payload]);
}

function decodeFrames(buf, onFrame) {
  for (;;) {
    if (buf.length < 2) return buf;
    const opcode = buf[0] & 0x0f;
    const masked = !!(buf[1] & 0x80);
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) return buf; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return buf; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const total = off + (masked ? 4 : 0) + len;
    if (buf.length < total) return buf;
    let payload = buf.subarray(off + (masked ? 4 : 0), total);
    if (masked) {
      const key = buf.subarray(off, off + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    }
    onFrame(opcode, payload);
    buf = buf.subarray(total);
  }
}

class FakeObs {
  constructor({ password = PASSWORD } = {}) {
    this.password = password;
    this.current = 'Scene A';
    this.scenes = ['Scene A', 'Scene B', 'Scene C'];
    this.clients = new Set();
    this.connections = 0;
    this.requests = [];
    this.identifies = [];
    this.mute = false; // swallow requests, to leave one in flight deterministically
    this.server = http.createServer((req, res) => { res.writeHead(426); res.end(); });
    this.server.on('upgrade', (req, socket) => this._upgrade(req, socket));
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      this.url = `ws://127.0.0.1:${this.server.address().port}`;
      resolve(this.url);
    }));
  }

  _upgrade(req, socket) {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    // No Sec-WebSocket-Protocol echo: the client offers none, and a browser-grade client must fail on an unrequested one.
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client = { socket, identified: false, auth: { challenge: crypto.randomBytes(12).toString('base64'), salt: crypto.randomBytes(12).toString('base64') } };
    this.clients.add(client);
    this.connections++;
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = decodeFrames(Buffer.concat([buf, d]), (opcode, payload) => {
        if (opcode === 0x8) { socket.end(encodeFrame(0x8, payload.subarray(0, 2))); return; }
        if (opcode === 0x9) { socket.write(encodeFrame(0xa, payload)); return; }
        if (opcode === 0x1) this._message(client, JSON.parse(payload.toString()));
      });
    });
    socket.on('error', () => {});
    socket.on('close', () => this.clients.delete(client));
    this.send(client, { op: 0, d: { obsWebSocketVersion: '5.4.2', rpcVersion: 1, authentication: client.auth } });
  }

  send(client, obj) {
    if (!client.socket.destroyed) client.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj))));
  }

  close(client, code, reason) {
    const body = Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason)]);
    client.socket.end(encodeFrame(0x8, body));
  }

  _message(client, { op, d }) {
    if (op === 1) {
      this.identifies.push(d);
      if (d.authentication !== authString(this.password, client.auth)) return this.close(client, 4010, 'Authentication failed.');
      client.identified = true;
      return this.send(client, { op: 2, d: { negotiatedRpcVersion: 1 } });
    }
    if (op !== 6 || !client.identified || this.mute) return;
    this.requests.push(d);
    const reply = (status, responseData) => this.send(client, { op: 7, d: { requestType: d.requestType, requestId: d.requestId, requestStatus: status, ...(responseData ? { responseData } : {}) } });
    if (d.requestType === 'GetSceneList') {
      return reply({ result: true, code: 100 }, {
        currentProgramSceneName: this.current, currentPreviewSceneName: null,
        scenes: this.scenes.map((sceneName, i) => ({ sceneName, sceneIndex: this.scenes.length - 1 - i })).reverse(),
      });
    }
    if (d.requestType === 'SetCurrentProgramScene') {
      const name = d.requestData && d.requestData.sceneName;
      if (!this.scenes.includes(name)) return reply({ result: false, code: 600, comment: `No source was found by the name of \`${name}\`.` });
      reply({ result: true, code: 100 });
      return this.pushScene(name);
    }
    reply({ result: false, code: 204, comment: 'Your request type is not valid.' });
  }

  pushScene(sceneName) {
    this.current = sceneName;
    for (const c of this.clients) if (c.identified) this.send(c, { op: 5, d: { eventType: 'CurrentProgramSceneChanged', eventIntent: 4, eventData: { sceneName } } });
  }

  dropClients() { for (const c of this.clients) c.socket.destroy(); }

  stop() {
    this.dropClients();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timed out waiting for ${what}`); })]);

test('authenticates, emits connected then scene with the starting scene', { skip }, async () => {
  const obs = new FakeObs();
  const client = new ObsWebSocket({ url: await obs.listen(), password: PASSWORD });
  const order = [];
  client.on('connected', () => order.push('connected'));
  client.on('scene', (s) => order.push(`scene:${s}`));
  client.start();
  try {
    await withTimeout(once(client, 'scene'), 3000, 'scene');
    assert.deepStrictEqual(order, ['connected', 'scene:Scene A']);
    assert.strictEqual(client.connected, true);
    assert.strictEqual(obs.identifies.length, 1);
    assert.strictEqual(obs.identifies[0].rpcVersion, 1);
    assert.strictEqual(obs.identifies[0].eventSubscriptions, 1 << 2);
    assert.deepStrictEqual(obs.requests.map((r) => r.requestType), ['GetSceneList']);
    const list = await client.getScenes();
    assert.deepStrictEqual(list, { current: 'Scene A', scenes: ['Scene C', 'Scene B', 'Scene A'] });
  } finally {
    client.stop();
    await obs.stop();
  }
  assert.strictEqual(client.connected, false);
});

test('wrong or missing password emits error and stops reconnecting', { skip }, async () => {
  const obs = new FakeObs();
  const url = await obs.listen();
  try {
    const wrong = new ObsWebSocket({ url, password: 'nope' });
    let connected = false;
    wrong.on('connected', () => { connected = true; });
    wrong.start();
    const [err] = await withTimeout(once(wrong, 'error'), 3000, 'error');
    assert.match(err.message, /password/i);
    assert.strictEqual(connected, false);
    await sleep(1300); // past the first 1s backoff: no second connection should appear
    assert.strictEqual(obs.connections, 1);
    assert.strictEqual(wrong.connected, false);
    wrong.stop();

    const missing = new ObsWebSocket({ url });
    missing.start();
    const [err2] = await withTimeout(once(missing, 'error'), 3000, 'error');
    assert.match(err2.message, /requires a password/i);
    assert.strictEqual(obs.identifies.length, 1, 'no Identify sent without a password');
    missing.stop();
  } finally {
    await obs.stop();
  }
});

test('setScene round-trips and pushed events emit scene', { skip }, async () => {
  const obs = new FakeObs();
  const client = new ObsWebSocket({ url: await obs.listen(), password: PASSWORD });
  client.start();
  try {
    await withTimeout(once(client, 'scene'), 3000, 'starting scene');
    const changed = once(client, 'scene');
    await client.setScene('Scene B');
    assert.strictEqual(obs.current, 'Scene B');
    assert.deepStrictEqual(obs.requests[obs.requests.length - 1], { requestType: 'SetCurrentProgramScene', requestId: '2', requestData: { sceneName: 'Scene B' } });
    assert.deepStrictEqual(await withTimeout(changed, 3000, 'scene event'), ['Scene B']);

    const pushed = once(client, 'scene');
    obs.pushScene('Scene C');
    assert.deepStrictEqual(await withTimeout(pushed, 3000, 'pushed scene event'), ['Scene C']);
    assert.strictEqual((await client.getScenes()).current, 'Scene C');

    await assert.rejects(client.setScene('Nope'), /No source was found/);
    await assert.rejects(client.request('Bogus'), /not valid/);
  } finally {
    client.stop();
    await obs.stop();
  }
  await assert.rejects(client.request('GetSceneList'), /not connected/);
});

test('server closing emits disconnected, then the client reconnects', { skip }, async () => {
  const obs = new FakeObs();
  const client = new ObsWebSocket({ url: await obs.listen(), password: PASSWORD });
  client.start();
  try {
    await withTimeout(once(client, 'scene'), 3000, 'starting scene');
    const disconnected = once(client, 'disconnected');
    obs.mute = true;
    const inflight = client.request('GetSceneList');
    obs.dropClients();
    await withTimeout(disconnected, 3000, 'disconnected');
    await assert.rejects(inflight, /disconnected/);
    assert.strictEqual(client.connected, false);

    obs.mute = false;
    obs.current = 'Scene B';
    const back = once(client, 'connected');
    const scene = once(client, 'scene');
    await withTimeout(back, 5000, 'reconnect (1s backoff)');
    assert.deepStrictEqual(await withTimeout(scene, 3000, 'scene after reconnect'), ['Scene B']);
    assert.strictEqual(obs.connections, 2);
    assert.strictEqual(client.connected, true);
  } finally {
    client.stop();
    await obs.stop();
  }
});
