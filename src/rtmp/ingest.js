'use strict';
// RTMP ingest server: what OBS streams to. Accepts one publisher at a time
// (a new publisher replaces the old one, which is what you want after an OBS
// crash) and turns audio/video/data messages into FLV tags.
const net = require('net');
const { EventEmitter } = require('events');
const amf = require('./amf0');
const { handshake } = require('./handshake');
const { ChunkReader, ChunkWriter, MSG, UC, CSID, setChunkSize, ack, windowAckSize, setPeerBandwidth, userControl } = require('./chunk');
const { describe, TAG_AUDIO, TAG_VIDEO, TAG_SCRIPT } = require('../flv');

const HANDSHAKE_TIMEOUT = 15000;
const IDLE_TIMEOUT = 10000; // publishing but no data: OBS is gone
const OUR_WINDOW = 5000000;
const STREAM_ID = 1;

class RtmpIngest extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 1935, key = '' } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.key = key; // '' = accept any stream key
    this.publisher = null;
    this.server = net.createServer((s) => this._accept(s));
    this.server.on('error', (e) => this.emit('error', e));
  }

  start() {
    this.server.listen(this.port, this.host, () => this.emit('listening'));
  }

  stop() {
    if (this.publisher) this.publisher.socket.destroy();
    this.server.close();
  }

  _accept(socket) {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    const conn = { socket, peer, app: '', publishing: false, writer: new ChunkWriter(), peerWindow: 2500000, acked: 0 };
    socket.setTimeout(HANDSHAKE_TIMEOUT, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.publisher === conn) {
        this.publisher = null;
        this.emit('unpublish', conn);
      }
    });
    const reader = new ChunkReader((m) => {
      try { this._message(conn, reader, m); } catch (e) { this.emit('warn', `${peer}: ${e.message}`); socket.destroy(); }
    });
    const feed = handshake(socket, 'server', (err, rest) => {
      if (err) { this.emit('warn', `${peer}: ${err.message}`); socket.destroy(); return; }
      socket.removeListener('data', feed);
      socket.on('data', (d) => {
        try { reader.push(d); } catch (e) { this.emit('warn', `${peer}: ${e.message}`); socket.destroy(); return; }
        if (reader.bytesIn - conn.acked >= conn.peerWindow) { conn.acked = reader.bytesIn; this._send(conn, CSID.CONTROL, 0, 0, ack(reader.bytesIn)); }
      });
      if (rest.length) socket.emit('data', rest);
    });
    socket.on('data', feed);
  }

  _send(conn, csid, msid, ts, { type, payload }) {
    conn.socket.write(conn.writer.encode(csid, type, msid, ts, payload));
  }

  _command(conn, csid, msid, ...values) {
    this._send(conn, csid, msid, 0, { type: MSG.COMMAND_AMF0, payload: amf.encode(...values) });
  }

  _message(conn, reader, m) {
    switch (m.type) {
      case MSG.AUDIO: case MSG.VIDEO: case MSG.DATA_AMF0:
        if (!conn.publishing) return;
        this._media(conn, m);
        return;
      case MSG.COMMAND_AMF0: {
        const [name, txn, obj, ...args] = amf.decodeAll(m.payload);
        this._invoke(conn, m, name, txn, obj, args);
        return;
      }
      case MSG.WINDOW_ACK_SIZE: if (m.payload.length >= 4) conn.peerWindow = Math.max(1024, m.payload.readUInt32BE(0)); return;
      case MSG.USER_CONTROL:
        if (m.payload.length >= 6 && m.payload.readUInt16BE(0) === UC.PING_REQUEST) {
          this._send(conn, CSID.CONTROL, 0, 0, userControl(UC.PING_RESPONSE, m.payload.readUInt32BE(2)));
        }
        return;
      case MSG.SET_CHUNK_SIZE: case MSG.ACK: case MSG.ABORT: case MSG.SET_PEER_BW:
        return;
      case MSG.DATA_AMF3: case MSG.COMMAND_AMF3:
        if (!conn.warnedAmf3) { conn.warnedAmf3 = true; this.emit('warn', `${conn.peer}: AMF3 messages are ignored`); }
        return;
      default:
        return;
    }
  }

  _invoke(conn, m, name, txn, obj, args) {
    switch (name) {
      case 'connect': {
        conn.app = obj && typeof obj.app === 'string' ? obj.app.replace(/\/+$/, '') : '';
        this._send(conn, CSID.CONTROL, 0, 0, windowAckSize(OUR_WINDOW));
        this._send(conn, CSID.CONTROL, 0, 0, setPeerBandwidth(OUR_WINDOW, 2));
        this._send(conn, CSID.CONTROL, 0, 0, userControl(UC.STREAM_BEGIN, 0));
        this._send(conn, CSID.CONTROL, 0, 0, setChunkSize(4096));
        conn.writer.chunkSize = 4096;
        this._command(conn, CSID.COMMAND, 0, '_result', txn,
          { fmsVer: 'FMS/3,5,7,7009', capabilities: 31, mode: 1 },
          { level: 'status', code: 'NetConnection.Connect.Success', description: 'Connection succeeded.', objectEncoding: 0 });
        return;
      }
      case 'createStream':
        this._command(conn, CSID.COMMAND, 0, '_result', txn, null, STREAM_ID);
        return;
      case 'releaseStream': case 'FCPublish':
        this._command(conn, CSID.COMMAND, 0, '_result', txn, null, undefined);
        return;
      case 'publish': {
        const name = String(args[0] ?? '').split('?')[0];
        if (this.key && name !== this.key) {
          this._status(conn, m.msid, 'error', 'NetStream.Publish.BadName', 'Wrong stream key.');
          this.emit('warn', `${conn.peer}: rejected publish with stream key "${name}"`);
          conn.socket.end();
          return;
        }
        if (this.publisher && this.publisher !== conn) {
          this.emit('warn', `${this.publisher.peer}: replaced by a new connection from ${conn.peer}`);
          this.publisher.socket.destroy();
        }
        this.publisher = conn;
        conn.publishing = true;
        conn.streamName = name;
        conn.socket.setTimeout(IDLE_TIMEOUT, () => { this.emit('warn', `${conn.peer}: no data for ${IDLE_TIMEOUT / 1000}s, dropping`); conn.socket.destroy(); });
        this._send(conn, CSID.CONTROL, 0, 0, userControl(UC.STREAM_BEGIN, STREAM_ID));
        this._status(conn, m.msid, 'status', 'NetStream.Publish.Start', `${name} is now published.`);
        this.emit('publish', conn);
        return;
      }
      case 'FCUnpublish': case 'deleteStream': case 'closeStream':
        if (conn.publishing) { conn.publishing = false; conn.socket.end(); }
        return;
      case 'play':
        this._status(conn, m.msid, 'error', 'NetStream.Play.Failed', 'This server only accepts publishers.');
        conn.socket.end();
        return;
      default:
        return; // getStreamLength, _checkbw, onBWDone ... nothing to do
    }
  }

  _status(conn, msid, level, code, description) {
    this._command(conn, CSID.STREAM, msid, 'onStatus', 0, null, { level, code, description });
  }

  _media(conn, m) {
    let type = m.type === MSG.AUDIO ? TAG_AUDIO : m.type === MSG.VIDEO ? TAG_VIDEO : TAG_SCRIPT;
    let data = m.payload;
    if (type === TAG_SCRIPT) data = amf.stripLeadingString(data, '@setDataFrame');
    if (!data.length) return;
    this.emit('tag', describe(type, m.ts, data));
  }
}

module.exports = { RtmpIngest };
