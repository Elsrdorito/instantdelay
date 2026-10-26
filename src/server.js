'use strict';
// InstaDelay v1 — local RTMP delay proxy.
//
//   OBS --RTMP--> ffmpeg (listen, remux to FLV) --stdout--> DelayEngine
//       --stdin--> ffmpeg (FLV -> RTMP) --RTMP--> Twitch / any ingest
//
// Plus an HTTP server for the OBS dock, the overlay, and a Stream Deck API.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { FlvParser, flvHeader, encodeTag } = require('./flv');
const { DelayEngine } = require('./delay');

const ROOT = path.join(__dirname, '..');
const IS_WIN = process.platform === 'win32';
// If ffmpeg can't push to the ingest this fast, reconnect instead of growing memory forever.
const MAX_OUTPUT_BACKLOG = 64 * 1024 * 1024;

const config = loadConfig();
const secrets = secretsOf(config.outputUrl);
const ffmpeg = resolveFfmpeg(config.ffmpegPath);
const engine = new DelayEngine({
  delayMs: config.initialDelaySec * 1000,
  maxDelayMs: config.maxDelaySec * 1000,
});

function fail(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Notepad may save a BOM
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`${file} is not valid JSON (${e.message}).\n` +
      '  Tip: write Windows paths with forward slashes, e.g. "C:/ffmpeg/bin/ffmpeg.exe".');
  }
}

function loadConfig() {
  const defaults = readJson(path.join(ROOT, 'config.example.json'));
  const file = process.env.INSTANTDELAY_CONFIG || path.join(ROOT, 'config.json');
  const exists = fs.existsSync(file);
  if (!exists && !process.env.OUTPUT_URL) {
    console.log(`No ${path.basename(file)} found; using defaults. Copy config.example.json to config.json and add your stream key.`);
  }
  const user = exists ? readJson(file) : {};
  const cfg = { ...defaults, ...user };
  if (process.env.OUTPUT_URL) cfg.outputUrl = process.env.OUTPUT_URL;
  if (process.env.RTMP_PORT) cfg.rtmpPort = Number(process.env.RTMP_PORT);
  if (process.env.HTTP_PORT) cfg.httpPort = Number(process.env.HTTP_PORT);
  if (process.env.END_AFTER_IDLE_SEC) cfg.endAfterIdleSec = Number(process.env.END_AFTER_IDLE_SEC);
  for (const k of ['rtmpPort', 'httpPort', 'maxDelaySec', 'initialDelaySec', 'endAfterIdleSec']) {
    if (!Number.isFinite(cfg[k]) || cfg[k] < 0) fail(`config "${k}" must be a number (got ${JSON.stringify(cfg[k])})`);
  }
  return cfg;
}

// Find a working ffmpeg. Right after `winget install ffmpeg`, PATH is only
// updated for newly opened windows, so also look where winget puts it.
function resolveFfmpeg(configured) {
  const exe = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [configured];
  if (configured === 'ffmpeg') {
    candidates.push(path.join(ROOT, 'ffmpeg', exe), path.join(ROOT, 'ffmpeg', 'bin', exe));
    if (IS_WIN && process.env.LOCALAPPDATA) {
      const winget = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet');
      candidates.push(path.join(winget, 'Links', exe), ...wingetPackages(path.join(winget, 'Packages')));
    }
    if (IS_WIN) candidates.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  }
  for (const c of candidates) {
    const r = spawnSync(c, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return c;
  }
  fail(`ffmpeg was not found (tried "${configured}").\n` +
    (IS_WIN
      ? '  Install it with:  winget install ffmpeg\n  then close this window and start InstantDelay again.\n'
      : '  Install it with:  brew install ffmpeg  (macOS)  or your package manager.\n') +
    '  Or set "ffmpegPath" in config.json to the full path of ffmpeg.');
}

// winget layout: Packages\Gyan.FFmpeg_<id>\ffmpeg-<version>-full_build\bin\ffmpeg.exe
function wingetPackages(dir) {
  try {
    return fs.readdirSync(dir).filter((d) => /ffmpeg/i.test(d)).flatMap((d) =>
      fs.readdirSync(path.join(dir, d)).map((sub) => path.join(dir, d, sub, 'bin', 'ffmpeg.exe')));
  } catch {
    return [];
  }
}

// The parts of the output URL that must never be printed (ffmpeg errors echo the full URL).
function secretsOf(url) {
  if (!/^rtmps?:\/\//i.test(url || '')) return [];
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return [parts.slice(1).join('/'), u.search.slice(1), u.password].filter((s) => s && s.length >= 4);
  } catch {
    return [];
  }
}

function redact(text) {
  for (const s of secrets) text = text.split(s).join('****');
  return text;
}

function log(...args) {
  console.log(new Date().toTimeString().slice(0, 8), ...args.map((a) => redact(String(a))));
}

// ------------------------------------------------------------------ lifecycle

const children = new Set();
let shuttingDown = false;

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  // Close the output cleanly so the ingest (or file) gets a proper end of stream.
  if (out) out.ff.stdin.end();
  for (const ff of children) if (!out || ff !== out.ff) ff.kill();
  const timer = setInterval(() => { if (!children.size) process.exit(0); }, 50);
  setTimeout(() => {
    clearInterval(timer);
    for (const ff of children) ff.kill('SIGKILL');
    process.exit(0);
  }, 3000);
}
// SIGHUP = console window closed on Windows, SIGBREAK = Ctrl+Break.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
// When started by another Node process (the tests), follow its lifetime.
process.on('message', (m) => { if (m === 'shutdown') shutdown('requested'); });
process.on('disconnect', () => shutdown('parent exited'));

// ---------------------------------------------------------------- input side

let inputFails = 0;

function startInput() {
  const url = `rtmp://${config.rtmpHost}:${config.rtmpPort}/live`;
  const ff = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-listen', '1', '-i', url,
    '-c', 'copy', '-f', 'flv', '-flvflags', 'no_duration_filesize', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  children.add(ff);
  const parser = new FlvParser((tag) => engine.push(tag));
  let connected = false;
  let lastErr = '';
  ff.stdout.on('data', (chunk) => {
    if (!connected) { connected = true; inputFails = 0; log('OBS connected'); broadcast(); }
    try { parser.push(chunk); } catch (e) { log('input parse error:', e.message); ff.kill(); }
  });
  ff.stderr.on('data', (d) => { lastErr = d.toString().trim(); log('[ffmpeg in]', lastErr); });
  ff.on('error', (e) => log('cannot start ffmpeg:', e.message));
  ff.on('exit', () => {
    children.delete(ff);
    if (shuttingDown) return;
    if (connected) log('OBS disconnected');
    else inputFails++;
    if (/in use|10048|bind/i.test(lastErr)) {
      log(`port ${config.rtmpPort} is already in use. Close the other program using it ` +
        '(or an older InstantDelay window), or change "rtmpPort" in config.json.');
    }
    engine.inputRestart();
    broadcast();
    setTimeout(startInput, connected ? 300 : Math.min(10000, 500 * 2 ** Math.min(inputFails, 5)));
  });
}

// --------------------------------------------------------------- output side

let out = null; // { ff, connected, ending }
let outFails = 0;
let outRetryAt = 0;
let idleSince = 0;

function outputConfigured() {
  return !!config.outputUrl && !config.outputUrl.includes('YOUR_TWITCH_STREAM_KEY');
}

// Called from the timer (never from inside an engine 'tag' event) whenever there is
// something to send and no output running.
function maybeStartOutput() {
  if (out || shuttingDown) return;
  if (!engine.status().inputActive && !engine.buffer.length) return;
  if (!outputConfigured()) {
    if (!maybeStartOutput.warned) log('outputUrl not configured; set it in config.json (stream is buffered but not sent)');
    maybeStartOutput.warned = true;
    return;
  }
  if (Date.now() < outRetryAt) return;

  const isRtmp = /^rtmps?:\/\//i.test(config.outputUrl);
  const ff = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    // Progress lines only start once the output is open, so they double as a "connected" signal.
    '-progress', 'pipe:1', '-stats_period', '1',
    // Codec info is in the FLV sequence headers, so a short probe is enough and goes live faster.
    '-analyzeduration', '500000',
    '-f', 'flv', '-i', 'pipe:0',
    '-c', 'copy', '-f', 'flv', ...(isRtmp ? [] : ['-y']), config.outputUrl,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const o = { ff, connected: false, ending: false };
  out = o;
  children.add(ff);
  ff.stdin.on('error', () => {});
  ff.stdout.on('data', () => {
    if (o.connected) return;
    o.connected = true;
    outFails = 0;
    log('output connected');
    broadcast();
  });
  ff.stderr.on('data', (d) => log('[ffmpeg out]', d.toString().trim()));
  ff.on('error', (e) => log('cannot start ffmpeg:', e.message));
  ff.on('exit', (code) => {
    children.delete(ff);
    if (out === o) out = null;
    engine.outputRestart();
    if (shuttingDown || o.ending) return;
    if (!o.connected) outFails++;
    const wait = o.connected ? 1000 : Math.min(30000, 1000 * 2 ** Math.min(outFails, 5));
    outRetryAt = Date.now() + wait;
    log(`output stopped (exit ${code}); retrying in ${wait / 1000}s`);
    broadcast();
  });
  ff.stdin.write(flvHeader());
  log('output started ->', config.outputUrl);
  // A fresh output must start with codec headers + a keyframe.
  engine.outputRestart();
}

// End the output (so the ingest ends the broadcast) once OBS has stopped and the buffer is empty.
function endOutput() {
  const o = out;
  o.ending = true;
  out = null;
  o.ff.stdin.end();
  setTimeout(() => o.ff.kill(), 5000).unref();
  engine.outputRestart(true);
  log(`no stream from OBS for ${config.endAfterIdleSec}s; ended the output`);
  broadcast();
}

engine.on('tag', (tag) => {
  if (!out) return;
  const stdin = out.ff.stdin;
  stdin.write(encodeTag(tag.type, tag.ts, tag.data));
  if (stdin.writableLength > MAX_OUTPUT_BACKLOG) {
    log('output is not keeping up (upload too slow?); reconnecting');
    out.ff.kill();
  }
});

// Release due tags even when nothing new arrives.
setInterval(() => { maybeStartOutput(); engine.tick(); }, 5);

setInterval(() => {
  if (!out || !config.endAfterIdleSec) { idleSince = 0; return; }
  if (engine.status().inputActive || engine.buffer.length) { idleSince = 0; return; }
  idleSince = idleSince || Date.now();
  if (Date.now() - idleSince >= config.endAfterIdleSec * 1000) { idleSince = 0; endOutput(); }
}, 500);

// ------------------------------------------------------------- control / UI

const clients = new Set();

function broadcast() {
  const payload = `data: ${JSON.stringify(statusJson())}\n\n`;
  for (const res of clients) res.write(payload);
}
setInterval(broadcast, 250);

function statusJson() {
  return {
    ...engine.status(),
    outputActive: !!(out && out.connected),
    outputConfigured: outputConfigured(),
    presetsSec: config.presetsSec,
    maxDelaySec: config.maxDelaySec,
  };
}

engine.on('delay', ({ from, to }) => {
  log(`delay ${from / 1000}s -> ${to / 1000}s`);
  broadcast();
});

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

const routes = {
  '/': () => file('public/dock.html'),
  '/dock': () => file('public/dock.html'),
  '/overlay': () => file('public/overlay.html'),
  '/api/status': () => json(statusJson()),
  // Works with Stream Deck's built-in "Website" action (GET in background).
  '/api/delay': (q) => {
    if (q.has('sec')) engine.setDelay(seconds(q, 'sec') * 1000);
    else if (q.has('add')) engine.setDelay(engine.delayMs + seconds(q, 'add', { allowNegative: true }) * 1000);
    else throw new HttpError(400, 'use ?sec=<seconds> or ?add=<seconds>');
    return json(statusJson());
  },
  '/api/instant': () => { engine.setDelay(0); return json(statusJson()); },
  '/api/toggle': (q) => {
    const sec = q.has('sec') ? seconds(q, 'sec') : 30;
    engine.setDelay(engine.delayMs > 0 ? 0 : sec * 1000);
    return json(statusJson());
  },
};
const READ_ONLY = new Set(['/', '/dock', '/overlay', '/api/status', '/api/events']);

function file(rel) {
  return { type: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(ROOT, rel)) };
}
function json(obj) {
  return { type: 'application/json', body: JSON.stringify(obj) };
}

const allowedHosts = new Set([`127.0.0.1:${config.httpPort}`, `localhost:${config.httpPort}`]);

// The API has no password, so make sure a random web page can't change the delay:
// reject foreign Host headers (DNS rebinding) and cross-site browser requests.
// Stream Deck and curl send no Sec-Fetch-Site header; the dock is same-origin.
function forbidden(req, pathname) {
  if (!allowedHosts.has(req.headers.host)) return true;
  const site = req.headers['sec-fetch-site'];
  return !READ_ONLY.has(pathname) && site && site !== 'same-origin' && site !== 'none';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (forbidden(req, url.pathname)) { res.writeHead(403); res.end('forbidden'); return; }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(statusJson())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const route = routes[url.pathname];
  if (!route) { res.writeHead(404); res.end('not found'); return; }
  try {
    const r = route(url.searchParams);
    const headers = { 'Content-Type': r.type, 'Cache-Control': 'no-store' };
    if (url.pathname === '/api/status') headers['Access-Control-Allow-Origin'] = '*';
    res.writeHead(200, headers);
    res.end(r.body);
  } catch (e) {
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') fail(`port ${config.httpPort} is already in use. Is InstantDelay already running in another window?`);
  fail(e.message);
});

server.listen(config.httpPort, '127.0.0.1', () => {
  const obsHost = config.rtmpHost === '0.0.0.0' ? '<this PC\'s IP>' : config.rtmpHost;
  log('InstaDelay v1');
  log(`  OBS  -> Settings > Stream > Custom: rtmp://${obsHost}:${config.rtmpPort}/live  key: stream`);
  log(`  Dock -> http://127.0.0.1:${config.httpPort}/dock`);
  log(`  Overlay (browser source) -> http://127.0.0.1:${config.httpPort}/overlay`);
  log(`  Output -> ${config.outputUrl}`);
  log(`  ffmpeg -> ${ffmpeg}`);
  log('  Press Ctrl+C to stop.');
  startInput();
});
