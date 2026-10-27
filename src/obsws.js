'use strict';
// Minimal obs-websocket v5 client (OBS 28+): scene changes in, scene switches
// out. Uses Node's built-in WebSocket (22+); on older Node it emits
// 'unsupported' and stays idle so the rest of the app keeps working.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OP = { HELLO: 0, IDENTIFY: 1, IDENTIFIED: 2, EVENT: 5, REQUEST: 6, RESPONSE: 7 };
const SUB_SCENES = 1 << 2;
const CLOSE_AUTH_FAILED = 4010;
const REQUEST_TIMEOUT = 10000;
const BACKOFF_MAX = 30000;

// obs-websocket auth: base64(sha256(base64(sha256(password + salt)) + challenge))
function authString(password, { salt, challenge }) {
  const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
  return crypto.createHash('sha256').update(secret + challenge).digest('base64');
}

class ObsWebSocket extends EventEmitter {
  constructor({ url = 'ws://127.0.0.1:4455', password = '' } = {}) {
    super();
    this.url = url;
    this.password = password;
    this.ws = null;
    this.identified = false;
    this.stopped = true;
    this.attempt = 0;
    this.timer = null;
    this.seq = 0;
    this.pending = new Map();
    this.warnedUnsupported = false;
  }

  get connected() { return this.identified && !!this.ws && this.ws.readyState === 1; }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this._failPending(new Error('obs-websocket client stopped'));
    const ws = this.ws;
    this.ws = null;
    this.identified = false;
    if (ws) { try { ws.close(); } catch (e) { /* already closing */ } }
  }

  _connect() {
    if (this.stopped) return;
    if (typeof globalThis.WebSocket !== 'function') {
      // Only Node 22+ ships a WebSocket client; say so once and give up quietly.
      this.stopped = true;
      if (!this.warnedUnsupported) { this.warnedUnsupported = true; this.emit('unsupported'); }
      return;
    }
    let ws;
    try { ws = new globalThis.WebSocket(this.url); } catch (e) { this._error(e); this._schedule(); return; }
    this.ws = ws;
    ws.addEventListener('message', (ev) => { try { this._message(ev.data); } catch (e) { this._error(e); } });
    ws.addEventListener('error', () => { /* a close event always follows */ });
    ws.addEventListener('close', (ev) => { try { this._closed(ws, ev); } catch (e) { this._error(e); } });
  }

  _schedule() {
    if (this.stopped || this.timer) return;
    const wait = Math.min(BACKOFF_MAX, 1000 * 2 ** this.attempt++);
    this.timer = setTimeout(() => { this.timer = null; this._connect(); }, wait);
    this.timer.unref();
  }

  _closed(ws, ev) {
    if (ws !== this.ws) return; // superseded by stop()/reconnect
    this.ws = null;
    const was = this.identified;
    this.identified = false;
    this._failPending(new Error('obs-websocket disconnected'));
    if (ev && ev.code === CLOSE_AUTH_FAILED) {
      // Retrying a wrong password only spams the OBS log; wait for start() with a new one.
      this.stopped = true;
      this._error(new Error('OBS WebSocket rejected the password (Tools > WebSocket Server Settings)'));
    }
    if (was) this.emit('disconnected');
    this._schedule();
  }

  _send(op, d) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ op, d }));
    return true;
  }

  _message(raw) {
    if (typeof raw !== 'string') return;
    const { op, d } = JSON.parse(raw);
    switch (op) {
      case OP.HELLO: {
        const identify = { rpcVersion: 1, eventSubscriptions: SUB_SCENES };
        if (d && d.authentication) {
          if (!this.password) {
            this.stopped = true;
            this._error(new Error('OBS WebSocket requires a password; set it in InstantDelay (Tools > WebSocket Server Settings in OBS)'));
            if (this.ws) this.ws.close();
            return;
          }
          identify.authentication = authString(this.password, d.authentication);
        }
        this._send(OP.IDENTIFY, identify);
        return;
      }
      case OP.IDENTIFIED:
        this.identified = true;
        this.attempt = 0;
        this.emit('connected');
        // Listeners want the starting scene too, not just the next change.
        this.getScenes().then((s) => { if (s.current) this.emit('scene', s.current); }, () => {});
        return;
      case OP.EVENT:
        if (d && d.eventType === 'CurrentProgramSceneChanged' && d.eventData) this.emit('scene', d.eventData.sceneName);
        return;
      case OP.RESPONSE: {
        const p = d && this.pending.get(d.requestId);
        if (!p) return;
        this.pending.delete(d.requestId);
        clearTimeout(p.timer);
        const st = d.requestStatus || {};
        if (st.result === false) p.reject(new Error(st.comment || `${d.requestType} failed (${st.code})`));
        else p.resolve(d.responseData || {});
        return;
      }
      default: return;
    }
  }

  _failPending(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  // 'error' on an EventEmitter throws when nobody listens; a flaky OBS must not take the proxy down.
  _error(err) {
    if (this.listenerCount('error')) this.emit('error', err);
  }

  request(requestType, requestData) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('not connected to OBS'));
      const requestId = String(++this.seq);
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS did not answer ${requestType} within ${REQUEST_TIMEOUT / 1000}s`));
      }, REQUEST_TIMEOUT);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      const msg = { requestType, requestId };
      if (requestData !== undefined) msg.requestData = requestData;
      this._send(OP.REQUEST, msg);
    });
  }

  async getScenes() {
    const d = await this.request('GetSceneList');
    return { current: d.currentProgramSceneName, scenes: (d.scenes || []).map((s) => s.sceneName) };
  }

  setScene(sceneName) {
    return this.request('SetCurrentProgramScene', { sceneName });
  }
}

module.exports = { ObsWebSocket, authString };
