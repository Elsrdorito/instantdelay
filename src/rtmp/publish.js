'use strict';
// RTMP publish client: pushes FLV tags to an ingest (Twitch, YouTube, Kick,
// nginx-rtmp, another InstantDelay...). rtmps:// uses TLS.
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
const amf = require('./amf0');
const { handshake } = require('./handshake');
const { ChunkReader, ChunkWriter, MSG, UC, CSID, setChunkSize, ack, userControl } = require('./chunk');
const { TAG_AUDIO, TAG_VIDEO, TAG_SCRIPT } = require('../flv');

const CHUNK_SIZE = 4096;
const CONNECT_TIMEOUT = 15000;

// rtmp://host[:port]/app[/more]/streamKey[?query]
function parseUrl(url) {
  const u = new URL(url);
  const secure = u.protocol === 'rtmps:';
  if (!secure && u.protocol !== 'rtmp:') throw new Error(`not an rtmp:// or rtmps:// URL`);
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segs.length < 2) throw new Error('URL needs an application and a stream key, e.g. rtmp://host/app/KEY');
  return {
    secure,
    host: u.hostname,
    port: Number(u.port) || (secure ? 443 : 1935),
    app: segs.slice(0, -1).join('/'),
    key: segs[segs.length - 1] + u.search,
    tcUrl: `${u.protocol}//${u.host}/${segs.slice(0, -1).join('/')}`,
  };
}

class RtmpPublisher extends EventEmitter {
  constructor(url) {
    super();
    this.target = parseUrl(url);
    this.socket = null;
    this.writer = new ChunkWriter();
    this.reader = new ChunkReader((m) => this._message(m));
    this.streamId = 0;
    this.ready = false;
    this.closed = false;
    this.peerWindow = 2500000;
    this.acked = 0;
    this.timer = null;
  }

  get backlog() { return this.socket ? this.socket.writableLength : 0; }

  connect() {
    const t = this.target;
    const onConnect = () => {
      const feed = handshake(this.socket, 'client', (err, rest) => {
        if (err) return this._fail(err);
        this.socket.removeListener('data', feed);
        this.socket.on('data', (d) => {
          try { this.reader.push(d); } catch (e) { this._fail(e); return; }
          if (this.reader.bytesIn - this.acked >= this.peerWindow) { this.acked = this.reader.bytesIn; this._send(CSID.CONTROL, 0, 0, ack(this.reader.bytesIn)); }
        });
        this._send(CSID.CONTROL, 0, 0, setChunkSize(CHUNK_SIZE));
        this.writer.chunkSize = CHUNK_SIZE;
        this._command(CSID.COMMAND, 0, 'connect', 1, {
          app: t.app, type: 'nonprivate', flashVer: 'FMLE/3.0 (compatible; InstantDelay)', tcUrl: t.tcUrl,
        });
        if (rest.length) this.socket.emit('data', rest);
      });
      this.socket.on('data', feed);
    };
    const opts = { host: t.host, port: t.port };
    this.socket = t.secure ? tls.connect({ ...opts, servername: t.host }, onConnect) : net.connect(opts, onConnect);
    this.socket.setNoDelay(true);
    this.socket.setKeepAlive(true, 10000);
    this.socket.on('error', (e) => this._fail(e));
    this.socket.on('close', () => { if (!this.closed) { this.closed = true; this.emit('close'); } });
    this.timer = setTimeout(() => this._fail(new Error(`no answer from ${t.host} within ${CONNECT_TIMEOUT / 1000}s`)), CONNECT_TIMEOUT);
  }

  _fail(err) {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.closed = true;
    this.emit('error', err);
    this.socket.destroy();
    this.emit('close');
  }

  _send(csid, msid, ts, { type, payload }) {
    return this.socket.write(this.writer.encode(csid, type, msid, ts, payload));
  }

  _command(csid, msid, ...values) {
    this._send(csid, msid, 0, { type: MSG.COMMAND_AMF0, payload: amf.encode(...values) });
  }

  _message(m) {
    switch (m.type) {
      case MSG.COMMAND_AMF0: {
        const [name, txn, obj, ...args] = amf.decodeAll(m.payload);
        this._invoke(name, txn, obj, args);
        return;
      }
      case MSG.WINDOW_ACK_SIZE: if (m.payload.length >= 4) this.peerWindow = Math.max(1024, m.payload.readUInt32BE(0)); return;
      case MSG.USER_CONTROL:
        if (m.payload.length >= 6 && m.payload.readUInt16BE(0) === UC.PING_REQUEST) {
          this._send(CSID.CONTROL, 0, 0, userControl(UC.PING_RESPONSE, m.payload.readUInt32BE(2)));
        }
        return;
      default: return;
    }
  }

  _invoke(name, txn, obj, args) {
    const info = args[0] && typeof args[0] === 'object' ? args[0] : obj && typeof obj === 'object' ? obj : {};
    if (name === '_result' && txn === 1) {
      const key = this.target.key;
      this._command(CSID.COMMAND, 0, 'releaseStream', 2, null, key);
      this._command(CSID.COMMAND, 0, 'FCPublish', 3, null, key);
      this._command(CSID.COMMAND, 0, 'createStream', 4, null);
    } else if (name === '_result' && txn === 4) {
      this.streamId = typeof args[0] === 'number' ? args[0] : 1;
      this._command(CSID.STREAM, this.streamId, 'publish', 5, null, this.target.key, 'live');
    } else if (name === 'onStatus') {
      const code = String(info.code || '');
      if (code === 'NetStream.Publish.Start') {
        if (!this.ready) { clearTimeout(this.timer); this.ready = true; this.emit('ready'); this.emit('connected'); }
      } else if (info.level === 'error' || /Failed|BadName|Rejected|Unpublish/.test(code)) {
        this._fail(new Error(`${code}: ${info.description || 'publish rejected'}`));
      }
    } else if (name === '_error') {
      // Some servers answer releaseStream / FCPublish with "Method not found"; ffmpeg ignores that too.
      if (txn === 2 || txn === 3) return;
      this._fail(new Error(`${info.code || 'error'}: ${info.description || 'connection rejected'}`));
    }
  }

  // Send one FLV tag ({type, ts, data}). Returns false when the socket is backed up.
  send(tag) {
    if (!this.ready || this.closed) return false;
    let type, csid, data = tag.data;
    if (tag.type === TAG_VIDEO) { type = MSG.VIDEO; csid = CSID.VIDEO; }
    else if (tag.type === TAG_AUDIO) { type = MSG.AUDIO; csid = CSID.AUDIO; }
    else {
      type = MSG.DATA_AMF0; csid = CSID.DATA;
      if (amf.leadingString(data) === 'onMetaData') data = Buffer.concat([amf.encode('@setDataFrame'), data]);
    }
    return this._send(csid, this.streamId, tag.ts, { type, payload: data });
  }

  // Tell the ingest the broadcast is over, then close.
  end() {
    if (this.closed) return;
    clearTimeout(this.timer);
    if (this.ready) {
      this._command(CSID.STREAM, this.streamId, 'FCUnpublish', 6, null, this.target.key);
      this._command(CSID.STREAM, this.streamId, 'deleteStream', 7, null, this.streamId);
    }
    this.ready = false;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 3000).unref();
  }

  destroy() {
    clearTimeout(this.timer);
    this.ready = false;
    if (this.socket) this.socket.destroy();
  }
}

module.exports = { RtmpPublisher, parseUrl };
