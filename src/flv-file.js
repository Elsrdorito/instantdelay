'use strict';
// Writes the output to a local .flv file (handy for testing, or to record the
// delayed stream). Same interface as RtmpPublisher.
const fs = require('fs');
const { EventEmitter } = require('events');
const { flvHeader, encodeTag } = require('./flv');

class FlvFileOutput extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.ready = false;
    this.closed = false;
  }
  get backlog() { return this.ws ? this.ws.writableLength : 0; }
  connect() {
    this.ws = fs.createWriteStream(this.file);
    this.ws.on('error', (e) => { if (!this.closed) { this.closed = true; this.emit('error', e); this.emit('close'); } });
    this.ws.on('open', () => { this.ws.write(flvHeader()); this.ready = true; this.emit('ready'); this.emit('connected'); });
    this.ws.on('close', () => { if (!this.closed) { this.closed = true; this.emit('close'); } });
  }
  send(tag) { return this.ready && !this.closed ? this.ws.write(encodeTag(tag.type, tag.ts, tag.data)) : false; }
  end() { if (this.ws) this.ws.end(); this.ready = false; }
  destroy() { this.ready = false; if (this.ws) this.ws.destroy(); }
}

module.exports = { FlvFileOutput };
