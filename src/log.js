'use strict';
// Console logger that redacts secrets and keeps the last lines for the dock.
const { EventEmitter } = require('events');

const KEEP = 300;

function createLogger() {
  const lines = [];
  let seq = 0;
  let secrets = [];
  const ev = new EventEmitter();

  function redact(text) {
    for (const s of secrets) text = text.split(s).join('****');
    return text;
  }
  function log(...args) {
    const time = new Date().toTimeString().slice(0, 8);
    const text = redact(args.map(String).join(' '));
    console.log(time, text);
    lines.push({ seq: ++seq, time, text });
    if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
    ev.emit('line', lines[lines.length - 1]);
  }
  log.setSecrets = (list) => { secrets = list.filter(Boolean); };
  log.redact = redact;
  log.lines = (since = 0) => lines.filter((l) => l.seq > since);
  Object.defineProperty(log, 'seq', { get: () => seq });
  log.on = ev.on.bind(ev);
  return log;
}

module.exports = { createLogger };
