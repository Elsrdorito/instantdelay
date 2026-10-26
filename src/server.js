'use strict';
// InstantDelay: local RTMP delay proxy.
//
//   OBS --RTMP--> RtmpIngest --tags--> DelayEngine --tags--> RtmpPublisher --RTMP--> Twitch / any ingest
//                                          ^
//                 OBS dock / overlay / Stream Deck / curl  --HTTP :8787--+
//
// With "transport": "ffmpeg" the two RTMP ends are ffmpeg processes instead (v1 behaviour).

const fs = require('fs');
const path = require('path');
const http = require('http');
const pkg = require('../package.json');
const cfgm = require('./config');
const { createLogger } = require('./log');
const { DelayEngine } = require('./delay');
const { RtmpIngest } = require('./rtmp/ingest');
const { RtmpPublisher } = require('./rtmp/publish');
const { FlvFileOutput } = require('./flv-file');
const ffm = require('./transports/ffmpeg');

const ROOT = cfgm.ROOT;
// If the ingest can't take data this fast, reconnect instead of growing memory forever.
const MAX_OUTPUT_BACKLOG = 64 * 1024 * 1024;

const log = createLogger();

function fail(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

let config;
try { config = cfgm.load(); } catch (e) { fail(e.message); }
log.setSecrets(cfgm.secretsOf(config.outputUrl));

let ffmpeg = null;
if (config.transport === 'ffmpeg') {
  ffmpeg = ffm.resolveFfmpeg(config.ffmpegPath, ROOT);
  if (!ffmpeg) {
    fail(`"transport" is "ffmpeg" but ffmpeg was not found (tried "${config.ffmpegPath}").\n` +
      '  Install it (Windows: winget install ffmpeg, macOS: brew install ffmpeg), set "ffmpegPath" in config.json,\n' +
      '  or switch back to "transport": "native" (no ffmpeg needed).');
  }
}

const engine = new DelayEngine({ delayMs: config.initialDelaySec * 1000, maxDelayMs: config.maxDelaySec * 1000, maxBufferBytes: config.maxBufferMB * 1048576 });
engine.start();

// ------------------------------------------------------------------ lifecycle

let shuttingDown = false;

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  engine.stop();
  input.stop();
  const exit = () => process.exit(0);
  if (out) {
    // Close the output cleanly so the ingest ends the broadcast.
    const o = out;
    o.ending = true;
    o.sink.on('close', exit);
    o.sink.end();
    setTimeout(() => { o.sink.destroy(); exit(); }, 3000).unref();
  } else {
    setTimeout(exit, 50);
  }
}
// SIGHUP = console window closed on Windows, SIGBREAK = Ctrl+Break.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
// When started by another Node process (the tests), follow its lifetime.
process.on('message', (m) => { if (m === 'shutdown') shutdown('requested'); });
process.on('disconnect', () => shutdown('parent exited'));
let running = false;
process.on('uncaughtException', (e) => {
  if (!running) fail(`startup failed: ${e.stack || e}`);
  log(`unexpected error: ${e.stack || e}`);
});

// ---------------------------------------------------------------- input side

const input = config.transport === 'ffmpeg'
  ? new ffm.FfmpegInput({ ffmpeg, host: config.rtmpHost, port: config.rtmpPort })
  : new RtmpIngest({ host: config.rtmpHost, port: config.rtmpPort, key: config.ingestKey });
let inputPeer = null;

input.on('publish', (c) => {
  inputPeer = c.peer;
  log(`OBS connected (${c.peer})`);
  engine.inputRestart(); // also covers a reconnect that replaced a half-dead connection
  maybeStartOutput();
  broadcast();
});
input.on('unpublish', () => { inputPeer = null; log('OBS disconnected'); engine.inputRestart(); broadcast(); });
input.on('tag', (tag) => engine.push(tag));
input.on('warn', (w) => log(w));
input.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    fail(`port ${config.rtmpPort} is already in use. Close the other program using it ` +
      '(or an older InstantDelay window), or change "rtmpPort" in config.json.');
  }
  fail(`cannot listen for OBS on ${config.rtmpHost}:${config.rtmpPort}: ${e.message}`);
});

// --------------------------------------------------------------- output side

let out = null; // { sink, ready, connected, ending }
let outFails = 0;
let outRetryAt = 0;
let idleSince = 0;
let warnedNoOutput = false;

function createOutput(url) {
  if (config.transport === 'ffmpeg') return new ffm.FfmpegOutput({ ffmpeg, url });
  if (/^rtmps?:\/\//i.test(url)) return new RtmpPublisher(url);
  return new FlvFileOutput(path.resolve(ROOT, url));
}

// Called from the housekeeping timer and on OBS connect (never from inside an engine 'tag' event).
function maybeStartOutput() {
  if (out || shuttingDown) return;
  if (!engine.status().inputActive && !engine.buffer.length) return;
  if (!cfgm.outputConfigured(config)) {
    if (!warnedNoOutput) log('No stream key set: the stream is buffered but not sent. Open the dock settings or run setup.');
    warnedNoOutput = true;
    return;
  }
  if (Date.now() < outRetryAt) return;

  let sink;
  try { sink = createOutput(config.outputUrl); } catch (e) {
    log(`cannot use outputUrl: ${e.message}`);
    outRetryAt = Date.now() + 30000;
    return;
  }
  const o = { sink, ready: false, connected: false, ending: false };
  out = o;
  sink.on('ready', () => {
    o.ready = true;
    engine.outputRestart(); // a fresh output must start with codec headers + a keyframe
  });
  sink.on('connected', () => {
    o.connected = true;
    outFails = 0;
    log('output connected');
    broadcast();
  });
  sink.on('warn', (w) => log(w));
  sink.on('error', (e) => log(`output error: ${e.message}`));
  sink.on('close', () => {
    if (out === o) { out = null; engine.outputRestart(); } // a replaced sink must not touch the live one
    if (shuttingDown || o.ending) return;
    if (!o.connected) outFails++;
    const wait = o.connected ? 1000 : Math.min(30000, 1000 * 2 ** Math.min(outFails, 5));
    outRetryAt = Date.now() + wait;
    log(`output stopped; retrying in ${wait / 1000}s`);
    broadcast();
  });
  log('output connecting ->', cfgm.maskUrl(config.outputUrl));
  sink.connect();
}

// End the output (so the ingest ends the broadcast). The next output starts a new session.
function endOutput(reason) {
  const o = out;
  if (!o) return;
  o.ending = true;
  out = null;
  o.sink.end();
  engine.outputRestart(true);
  log(`output ended (${reason})`);
  broadcast();
}

engine.on('tag', (tag) => {
  if (!out || !out.ready) return;
  out.sink.send(tag);
  if (out.sink.backlog > MAX_OUTPUT_BACKLOG) {
    log('output is not keeping up (upload too slow?); reconnecting');
    out.ready = false;
    out.sink.destroy();
  }
});

// Housekeeping: start/retry the output, end it when OBS has been gone for a while, push status.
setInterval(() => {
  maybeStartOutput();
  if (out && config.endAfterIdleSec && !engine.status().inputActive && !engine.buffer.length) {
    idleSince = idleSince || Date.now();
    if (Date.now() - idleSince >= config.endAfterIdleSec * 1000) {
      idleSince = 0;
      endOutput(`no stream from OBS for ${config.endAfterIdleSec}s`);
    }
  } else {
    idleSince = 0;
  }
  broadcast();
}, 250);

// ------------------------------------------------------------- control / UI

const clients = new Set();

function broadcast() {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(statusJson())}\n\n`;
  for (const res of clients) res.write(payload);
}

function statusJson() {
  const now = Date.now();
  return {
    ...engine.status(now),
    version: pkg.version,
    inputConnected: !!inputPeer,
    outputActive: !!(out && out.connected),
    outputConnecting: !!(out && !out.connected),
    outputRetryInSec: !out && outRetryAt > now ? Math.ceil((outRetryAt - now) / 1000) : 0,
    outputConfigured: cfgm.outputConfigured(config),
    presetsSec: config.presetsSec,
    maxDelaySec: config.maxDelaySec,
    logSeq: log.seq,
  };
}

engine.on('delay', ({ from, to }) => { log(`delay ${from / 1000}s -> ${to / 1000}s`); broadcast(); });
engine.on('cut', ({ ms }) => { log(`cut ${(ms / 1000).toFixed(1)}s out of the buffer`); broadcast(); });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// A typo like ?sec=3o must not silently drop the delay to 0.
function seconds(q, key, { allowNegative = false } = {}) {
  const raw = q.get(key);
  const v = Number(raw);
  if (raw === null || raw.trim() === '' || !Number.isFinite(v)) throw new HttpError(400, `"${key}" must be a number of seconds`);
  if (v < 0 && !allowNegative) throw new HttpError(400, `"${key}" must not be negative`);
  return v;
}

function applyConfig(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'expected a JSON object');
  const clean = {};
  for (const k of [...cfgm.LIVE_KEYS, ...cfgm.RESTART_KEYS]) if (k in patch) clean[k] = patch[k];
  if (typeof patch.streamKey === 'string') {
    const url = cfgm.outputUrlFrom(patch.streamKey);
    if (/\s/.test(url)) throw new HttpError(400, 'the stream key has spaces in it; copy it again');
    clean.outputUrl = url;
  }
  if (typeof clean.outputUrl === 'string' && clean.outputUrl) {
    if (/^rtmps?:\/\//i.test(clean.outputUrl)) {
      try { new URL(clean.outputUrl); } catch { throw new HttpError(400, 'outputUrl is not a valid URL'); }
    } else if (!/\.flv$/i.test(clean.outputUrl)) {
      // Over HTTP only allow an rtmp(s) URL or an .flv recording, never an arbitrary file to overwrite.
      throw new HttpError(400, 'outputUrl must be an rtmp:// or rtmps:// URL (or a .flv file path)');
    }
  }
  const errors = cfgm.validate({ ...config, ...clean });
  if (errors.length) throw new HttpError(400, errors.join('; '));

  const restartRequired = cfgm.RESTART_KEYS.filter((k) => k in clean && JSON.stringify(clean[k]) !== JSON.stringify(config[k]));
  const outputChanged = 'outputUrl' in clean && clean.outputUrl !== config.outputUrl;
  Object.assign(config, clean);
  cfgm.save(config);
  log.setSecrets(cfgm.secretsOf(config.outputUrl));
  engine.maxDelayMs = config.maxDelaySec * 1000;
  engine.maxBufferBytes = config.maxBufferMB * 1048576;
  if (engine.delayMs > engine.maxDelayMs) engine.setDelay(engine.maxDelayMs);
  log(`settings saved${restartRequired.length ? ` (restart needed for: ${restartRequired.join(', ')})` : ''}`);
  if (outputChanged) {
    warnedNoOutput = false;
    outRetryAt = 0;
    if (out) endOutput('output changed; reconnecting');
  }
  broadcast();
  return { ok: true, restartRequired, config: cfgm.publicView(config) };
}

const routes = {
  'GET /': () => file('public/dock.html'),
  'GET /dock': () => file('public/dock.html'),
  'GET /overlay': () => file('public/overlay.html'),
  'GET /api/status': () => json(statusJson()),
  'GET /api/log': (q) => json({ seq: log.seq, lines: log.lines(Number(q.get('since')) || 0) }),
  'GET /api/config': () => json(cfgm.publicView(config)),
  'POST /api/config': (q, body) => json(applyConfig(body)),
  // The ones below work with Stream Deck's built-in "Website" action (GET in background).
  'GET /api/delay': (q) => {
    if (q.has('sec')) engine.setDelay(seconds(q, 'sec') * 1000);
    else if (q.has('add')) engine.setDelay(engine.delayMs + seconds(q, 'add', { allowNegative: true }) * 1000);
    else throw new HttpError(400, 'use ?sec=<seconds> or ?add=<seconds>');
    return json(statusJson());
  },
  'GET /api/instant': () => { engine.setDelay(0); return json(statusJson()); },
  'GET /api/toggle': (q) => {
    const sec = q.has('sec') ? seconds(q, 'sec') : 30;
    engine.setDelay(engine.delayMs > 0 ? 0 : sec * 1000);
    return json(statusJson());
  },
  'GET /api/cut': (q) => {
    const sec = seconds(q, 'sec');
    if (sec <= 0) throw new HttpError(400, '"sec" must be more than 0');
    const removedMs = engine.cut(sec * 1000);
    return json({ removedMs, ...statusJson() });
  },
};
const READ_ONLY = new Set(['/', '/dock', '/overlay', '/favicon.ico', '/api/status', '/api/events', '/api/log', '/api/config']);

function file(rel) {
  return { type: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(ROOT, rel)) };
}
function json(obj) {
  return { type: 'application/json', body: JSON.stringify(obj) };
}

const allowedHosts = new Set([`127.0.0.1:${config.httpPort}`, `localhost:${config.httpPort}`, `[::1]:${config.httpPort}`]);

// The API has no password, so make sure a random web page can't change the delay:
// reject foreign Host headers (DNS rebinding) and cross-site browser requests.
// Stream Deck and curl send no Sec-Fetch-Site header; the dock is same-origin.
function forbidden(req, pathname) {
  if (!allowedHosts.has(req.headers.host)) return true;
  const mutating = req.method !== 'GET' || !READ_ONLY.has(pathname);
  if (!mutating) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return true;
  // Older browsers send no Sec-Fetch-Site; they do send Origin / Referer for cross-site requests.
  for (const h of ['origin', 'referer']) {
    const v = req.headers[h];
    if (!v) continue;
    try { if (!allowedHosts.has(new URL(v).host)) return true; } catch { return true; }
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 65536) { reject(new HttpError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (forbidden(req, url.pathname)) { res.writeHead(403); res.end('forbidden'); return; }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`retry: 1000\ndata: ${JSON.stringify(statusJson())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) { res.writeHead(routes[`GET ${url.pathname}`] || routes[`POST ${url.pathname}`] ? 405 : 404); res.end('not found'); return; }
  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const r = route(url.searchParams, body);
    const headers = { 'Content-Type': r.type, 'Cache-Control': 'no-store' };
    if (url.pathname === '/api/status') headers['Access-Control-Allow-Origin'] = '*';
    res.writeHead(200, headers);
    res.end(r.body);
  } catch (e) {
    if (!(e instanceof HttpError)) log(`request failed: ${e.stack || e}`);
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') fail(`port ${config.httpPort} is already in use. Is InstantDelay already running in another window?`);
  fail(e.message);
});

server.listen(config.httpPort, '127.0.0.1', () => {
  running = true;
  const obsHost = config.rtmpHost === '0.0.0.0' ? '<this PC\'s IP>' : config.rtmpHost;
  log(`InstantDelay ${pkg.version} (${config.transport === 'ffmpeg' ? `ffmpeg transport: ${ffmpeg}` : 'native RTMP'})`);
  if (!config._exists) log(`No ${path.basename(cfgm.FILE)} yet; using defaults. Set your stream key in the dock settings.`);
  log(`  OBS  -> Settings > Stream > Custom: rtmp://${obsHost}:${config.rtmpPort}/live  key: ${config.ingestKey || 'stream'}`);
  log(`  Dock -> http://127.0.0.1:${config.httpPort}/dock`);
  log(`  Overlay (browser source) -> http://127.0.0.1:${config.httpPort}/overlay`);
  log(`  Output -> ${cfgm.outputConfigured(config) ? cfgm.maskUrl(config.outputUrl) : '(no stream key yet)'}`);
  log('  Press Ctrl+C to stop.');
  input.start();
});
