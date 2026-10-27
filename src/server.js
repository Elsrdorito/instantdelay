'use strict';
// InstantDelay: local RTMP delay proxy.
//
//   OBS --RTMP--> RtmpIngest --tags--> DelayEngine --tags--> RtmpPublisher --RTMP--> Twitch / any ingest
//                                          ^    \
//                 OBS dock / overlay / Stream Deck / curl  --HTTP :8787--+     +--> recording .flv (optional)
//
// While the output would pause (delay being raised, cut hole, OBS gone) the engine
// sends the delay screen + silence instead (see filler.js), so the ingest never
// sees a dead connection.
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
const { HoldSource, DEFAULT_SCREEN } = require('./filler');
const { decodePng } = require('./png');
const { Notifier } = require('./notify');
const { ObsWebSocket } = require('./obsws');
const { flvHeader, encodeTag, TAG_VIDEO } = require('./flv');

const ROOT = cfgm.ROOT;
// If the ingest can't take data this fast, reconnect instead of growing memory forever.
const MAX_OUTPUT_BACKLOG = 64 * 1024 * 1024;
const CUSTOM_SCREEN = 'screens/custom.png';
const MAX_SCREEN_BYTES = 16 * 1024 * 1024;

const log = createLogger();

function fail(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

let config;
try { config = cfgm.load(); } catch (e) { fail(e.message); }
log.setSecrets(cfgm.allSecrets(config));

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
engine.replayMs = config.clipSec * 1000;
engine.start();

// ------------------------------------------------------------ delay screen

const hold = new HoldSource({ log });
engine.holdSource = hold;

function applyScreenConfig() {
  const v = config.delayScreen;
  if (v === 'off' || v === 'freeze') hold.setScreen(v);
  else if (v === 'default') hold.setScreen('screen', null);
  else {
    const file = path.resolve(ROOT, v);
    if (!fs.existsSync(file)) { log(`delay screen "${v}" not found; using the built-in screen`); hold.setScreen('screen', null); }
    else hold.setScreen('screen', file);
  }
}
applyScreenConfig();

// The PNG currently used as delay screen (for the dock preview).
function currentScreenFile() {
  return hold.imagePath && fs.existsSync(hold.imagePath) ? hold.imagePath : DEFAULT_SCREEN;
}

// ------------------------------------------------------------------ alerts

const notify = new Notifier({ log });
notify.setUrl(config.webhookUrl);

// ------------------------------------------------------- OBS scene rules

let obs = null;
let obsScene = null;
let obsUnsupported = false;

function applyObsConfig() {
  if (obs) { obs.stop(); obs = null; obsScene = null; }
  if (!config.obsWsUrl) return;
  obs = new ObsWebSocket({ url: config.obsWsUrl, password: config.obsWsPassword });
  obs.on('connected', () => { log(`OBS WebSocket connected (${config.obsWsUrl})`); broadcast(); });
  obs.on('disconnected', () => { obsScene = null; log('OBS WebSocket disconnected'); broadcast(); });
  obs.on('error', (e) => log(`OBS WebSocket: ${e.message}`));
  obs.on('unsupported', () => { obsUnsupported = true; log('OBS scene rules need Node.js 22 or newer (built-in WebSocket); they are off.'); });
  obs.on('scene', (name) => {
    const first = obsScene === null;
    obsScene = name;
    const sec = config.sceneDelays[name];
    if (sec !== undefined && engine.delayMs !== sec * 1000) {
      log(`OBS scene "${name}" -> delay ${sec}s`);
      engine.setDelay(sec * 1000);
    } else if (first) log(`OBS scene: "${name}"`);
    broadcast();
  });
  obs.start();
}
applyObsConfig();

// ------------------------------------------------------------------ lifecycle

let shuttingDown = false;

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  engine.stop();
  input.stop();
  if (obs) obs.stop();
  stopRecording();
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
let inputWasLost = false;

input.on('publish', (c) => {
  inputPeer = c.peer;
  log(`OBS connected (${c.peer})`);
  if (inputWasLost) notify.send('obs.up', 'OBS is back');
  inputWasLost = false;
  engine.inputRestart(); // also covers a reconnect that replaced a half-dead connection
  maybeStartOutput();
  broadcast();
});
input.on('unpublish', () => {
  inputPeer = null;
  inputWasLost = true;
  log('OBS disconnected');
  notify.send('obs.down', 'OBS disconnected from InstantDelay');
  engine.inputRestart();
  broadcast();
});
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

let out = null; // { sink, ready, connected, ending, target }
let outFails = 0;
let outRetryAt = 0;
let idleSince = 0;
let warnedNoOutput = false;
let outputWasUp = false;

// Twitch's bandwidth test mode: the ingest accepts the stream but the channel stays offline.
function withBandwidthTest(url) {
  if (!config.bandwidthTest || !/twitch\.tv|live-video\.net/i.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'bandwidthtest=true';
}

function createOutput(url) {
  if (config.transport === 'ffmpeg') return new ffm.FfmpegOutput({ ffmpeg, url });
  if (/^rtmps?:\/\//i.test(url)) return new RtmpPublisher(url);
  return new FlvFileOutput(path.resolve(ROOT, url));
}

// After two failed attempts on the primary ingest, alternate with the backup (if set).
function outputTarget() {
  return config.outputUrlBackup && outFails >= 2 && outFails % 2 === 0 ? 'backup' : 'primary';
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

  const target = outputTarget();
  const url = withBandwidthTest(target === 'backup' ? config.outputUrlBackup : config.outputUrl);
  let sink;
  try { sink = createOutput(url); } catch (e) {
    log(`cannot use outputUrl: ${e.message}`);
    outRetryAt = Date.now() + 30000;
    return;
  }
  const o = { sink, ready: false, connected: false, ending: false, target };
  out = o;
  sink.on('ready', () => {
    o.ready = true;
    engine.outputRestart(); // a fresh output must start with codec headers + a keyframe
    engine.keepAlive = true;
    startRecording();
  });
  sink.on('connected', () => {
    o.connected = true;
    outFails = 0;
    log(`output connected${target === 'backup' ? ' (backup ingest)' : ''}${config.bandwidthTest ? ' [bandwidth test: channel stays offline]' : ''}`);
    if (outputWasUp) notify.send('output.up', `Output reconnected${target === 'backup' ? ' (backup ingest)' : ''}`);
    outputWasUp = true;
    broadcast();
  });
  sink.on('warn', (w) => log(w));
  sink.on('error', (e) => log(`output error: ${e.message}`));
  sink.on('close', () => {
    if (out === o) { out = null; engine.outputRestart(); engine.keepAlive = false; stopRecording(); } // a replaced sink must not touch the live one
    if (shuttingDown || o.ending) return;
    if (!o.connected) outFails++;
    const wait = o.connected ? 1000 : Math.min(30000, 1000 * 2 ** Math.min(outFails, 5));
    outRetryAt = Date.now() + wait;
    log(`output stopped; retrying in ${wait / 1000}s${outputTarget() === 'backup' ? ' on the backup ingest' : ''}`);
    if (o.connected) notify.send('output.down', 'Output to the ingest dropped; reconnecting');
    broadcast();
  });
  log('output connecting ->', cfgm.maskUrl(url));
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
  engine.keepAlive = false;
  stopRecording();
  log(`output ended (${reason})`);
  broadcast();
}

// ------------------------------------------------------------- recording

let rec = null; // FlvFileOutput of the current output session (what viewers get, holds included)

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function startRecording() {
  if (rec || !config.recordDir) return;
  const dir = path.resolve(ROOT, config.recordDir);
  const file = path.join(dir, `${stamp()}.flv`);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { log(`cannot create recording folder: ${e.message}`); return; }
  const r = new FlvFileOutput(file);
  r.file = file;
  r.on('error', (e) => log(`recording error: ${e.message}`));
  r.on('ready', () => log(`recording -> ${path.relative(ROOT, file)}`));
  r.connect();
  rec = r;
}
function stopRecording() {
  if (!rec) return;
  rec.end();
  log(`recording saved: ${path.relative(ROOT, rec.file)}`);
  rec = null;
}

engine.on('tag', (tag) => {
  if (rec && rec.ready) rec.send(tag);
  if (!out || !out.ready) return;
  out.sink.send(tag);
  if (out.sink.backlog > MAX_OUTPUT_BACKLOG) {
    log('output is not keeping up (upload too slow?); reconnecting');
    out.ready = false;
    out.sink.destroy();
  }
});

// ------------------------------------------------------------------ clips

function saveClip(sec) {
  if (!config.clipSec) throw new HttpError(400, 'clips are off: set "clipSec" (seconds to keep) in Settings');
  const clip = engine.clip(Math.min(sec, config.clipSec + engine.delayMs / 1000) * 1000);
  if (!clip) throw new HttpError(400, 'nothing to clip yet');
  const dir = path.resolve(ROOT, config.clipDir || 'clips');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp()}.flv`);
  const buf = Buffer.concat([flvHeader(), ...clip.tags.map((t) => encodeTag(t.type, t.ts, t.data))]);
  fs.writeFile(file, buf, (e) => {
    if (e) log(`clip failed: ${e.message}`);
    else { log(`clip saved: ${path.relative(ROOT, file)} (${(clip.ms / 1000).toFixed(0)}s, ${(buf.length / 1048576).toFixed(1)} MB)`); notify.send('clip', `Clip saved: ${path.basename(file)} (${(clip.ms / 1000).toFixed(0)}s)`); }
  });
  return { file: path.relative(ROOT, file), ms: clip.ms, bytes: buf.length };
}

// ---------------------------------------------------- housekeeping / alerts

const bitrate = { samples: [], lowSince: 0, alerted: false };

function watchBitrate(st) {
  if (!st.inputActive) { bitrate.samples.length = 0; bitrate.lowSince = 0; bitrate.alerted = false; return; }
  bitrate.samples.push(st.inKbps);
  if (bitrate.samples.length > 240) bitrate.samples.shift(); // ~60 s
  if (bitrate.samples.length < 80) return;
  const avg = bitrate.samples.reduce((a, b) => a + b, 0) / bitrate.samples.length;
  const low = avg > 500 && st.inKbps < avg * 0.4;
  if (!low) { bitrate.lowSince = 0; if (bitrate.alerted) { bitrate.alerted = false; notify.send('bitrate.ok', `OBS bitrate is back to normal (${st.inKbps} kb/s)`); } return; }
  bitrate.lowSince = bitrate.lowSince || Date.now();
  if (!bitrate.alerted && Date.now() - bitrate.lowSince >= 10000) {
    bitrate.alerted = true;
    log(`warning: OBS bitrate dropped to ${st.inKbps} kb/s (average ${Math.round(avg)})`);
    notify.send('bitrate.low', `OBS bitrate dropped to ${st.inKbps} kb/s (usually ~${Math.round(avg)})`);
  }
}

// Housekeeping: start/retry the output, end it when OBS has been gone for a while, push status.
setInterval(() => {
  maybeStartOutput();
  const st = engine.status();
  if (out && config.endAfterIdleSec && !st.inputActive && !engine.buffer.length) {
    idleSince = idleSince || Date.now();
    if (Date.now() - idleSince >= config.endAfterIdleSec * 1000) {
      idleSince = 0;
      endOutput(`no stream from OBS for ${config.endAfterIdleSec}s`);
    }
  } else {
    idleSince = 0;
  }
  watchBitrate(st);
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
    outputTarget: out ? out.target : outputTarget(),
    outputRetryInSec: !out && outRetryAt > now ? Math.ceil((outRetryAt - now) / 1000) : 0,
    outputConfigured: cfgm.outputConfigured(config),
    bandwidthTest: config.bandwidthTest,
    presetsSec: config.presetsSec,
    maxDelaySec: config.maxDelaySec,
    clipSec: config.clipSec,
    clipAvailableMs: engine.replay.length ? now - engine.replay.peek().recv : (engine.buffer.length ? now - engine.buffer.peek().recv : 0),
    recording: rec ? path.relative(ROOT, rec.file) : null,
    screen: hold.info(engine.headers.get(TAG_VIDEO)),
    obs: { configured: !!config.obsWsUrl, connected: !!(obs && obs.connected), scene: obsScene, unsupported: obsUnsupported, rule: obsScene !== null ? config.sceneDelays[obsScene] : undefined },
    webhook: notify.enabled,
    logSeq: log.seq,
  };
}

engine.on('delay', ({ from, to }) => { log(`delay ${from / 1000}s -> ${to / 1000}s`); notify.send('delay', `Delay ${from / 1000}s -> ${to / 1000}s`); broadcast(); });
engine.on('cut', ({ ms }) => { log(`cut ${(ms / 1000).toFixed(1)}s out of the buffer`); broadcast(); });
engine.on('hold', ({ kind }) => { log(`output paused: sending ${kind === 'screen' ? 'the delay screen' : kind === 'freeze' ? 'the last frame' : 'silence'} meanwhile`); broadcast(); });
engine.on('holdEnd', ({ ms }) => { log(`stream resumed after ${(ms / 1000).toFixed(1)}s`); broadcast(); });
engine.on('warn', (w) => log(w));

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
  if (typeof patch.backupKey === 'string') {
    const url = cfgm.outputUrlFrom(patch.backupKey);
    if (/\s/.test(url)) throw new HttpError(400, 'the backup stream key has spaces in it; copy it again');
    clean.outputUrlBackup = url;
  }
  if (typeof clean.outputUrl === 'string' && clean.outputUrl) {
    if (/^rtmps?:\/\//i.test(clean.outputUrl)) {
      try { new URL(clean.outputUrl); } catch { throw new HttpError(400, 'outputUrl is not a valid URL'); }
    } else if (!/\.flv$/i.test(clean.outputUrl)) {
      // Over HTTP only allow an rtmp(s) URL or an .flv recording, never an arbitrary file to overwrite.
      throw new HttpError(400, 'outputUrl must be an rtmp:// or rtmps:// URL (or a .flv file path)');
    }
  }
  if (typeof clean.delayScreen === 'string' && !['default', 'freeze', 'off', CUSTOM_SCREEN].includes(clean.delayScreen)) {
    throw new HttpError(400, 'over HTTP the delay screen can be "default", "freeze", "off" or the uploaded picture');
  }
  for (const k of ['clipDir', 'recordDir']) {
    if (typeof clean[k] === 'string' && clean[k] && (path.isAbsolute(clean[k]) || clean[k].split(/[\\/]/).includes('..'))) {
      throw new HttpError(400, `"${k}" must be a folder name inside the InstantDelay folder`);
    }
  }
  const errors = cfgm.validate({ ...config, ...clean });
  if (errors.length) throw new HttpError(400, errors.join('; '));

  const changed = (k) => k in clean && JSON.stringify(clean[k]) !== JSON.stringify(config[k]);
  const restartRequired = cfgm.RESTART_KEYS.filter(changed);
  const outputChanged = changed('outputUrl') || changed('outputUrlBackup') || changed('bandwidthTest');
  const screenChanged = changed('delayScreen');
  const obsChanged = changed('obsWsUrl') || changed('obsWsPassword');
  Object.assign(config, clean);
  cfgm.save(config);
  log.setSecrets(cfgm.allSecrets(config));
  engine.maxDelayMs = config.maxDelaySec * 1000;
  engine.maxBufferBytes = config.maxBufferMB * 1048576;
  engine.replayMs = config.clipSec * 1000;
  notify.setUrl(config.webhookUrl);
  if (engine.delayMs > engine.maxDelayMs) engine.setDelay(engine.maxDelayMs);
  if (screenChanged) applyScreenConfig();
  if (obsChanged) applyObsConfig();
  log(`settings saved${restartRequired.length ? ` (restart needed for: ${restartRequired.join(', ')})` : ''}`);
  if (outputChanged) {
    warnedNoOutput = false;
    outRetryAt = 0;
    outFails = 0;
    if (out) endOutput('output settings changed; reconnecting');
  }
  broadcast();
  return { ok: true, restartRequired, config: cfgm.publicView(config) };
}

// Upload of a custom delay screen (raw PNG body).
function uploadScreen(body) {
  if (!body || !body.length) throw new HttpError(400, 'send the PNG file as the request body');
  let img;
  try { img = decodePng(body); } catch (e) { throw new HttpError(400, `not a usable PNG: ${e.message}`); }
  if (img.width > 4096 || img.height > 4096) throw new HttpError(400, 'picture is too large (max 4096x4096); 1920x1080 is ideal');
  const file = path.join(ROOT, CUSTOM_SCREEN);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  log(`delay screen uploaded: ${img.width}x${img.height}, ${(body.length / 1024).toFixed(0)} KB`);
  return applyConfig({ delayScreen: CUSTOM_SCREEN });
}

const routes = {
  'GET /': () => file('public/dock.html'),
  'GET /dock': () => file('public/dock.html'),
  'GET /overlay': () => file('public/overlay.html'),
  'GET /api/status': () => json(statusJson()),
  'GET /api/log': (q) => json({ seq: log.seq, lines: log.lines(Number(q.get('since')) || 0) }),
  'GET /api/config': () => json(cfgm.publicView(config)),
  'POST /api/config': (q, body) => json(applyConfig(body)),
  'GET /api/screen.png': () => ({ type: 'image/png', body: fs.readFileSync(currentScreenFile()) }),
  'POST /api/screen': (q, body) => json(uploadScreen(body)),
  'GET /api/scenes': async () => {
    if (!obs) throw new HttpError(400, 'OBS WebSocket is not configured');
    if (!obs.connected) throw new HttpError(503, 'not connected to OBS (is obs-websocket enabled in OBS > Tools > WebSocket Server Settings?)');
    return json(await obs.getScenes());
  },
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
  'GET /api/clip': (q) => json({ ...saveClip(q.has('sec') ? seconds(q, 'sec') : config.clipSec), ...statusJson() }),
  // Show viewers the delay screen for a few seconds (skips that much content): a dress rehearsal.
  'GET /api/screen/preview': (q) => {
    const sec = q.has('sec') ? seconds(q, 'sec') : 5;
    if (sec <= 0 || sec > 60) throw new HttpError(400, '"sec" must be between 1 and 60');
    if (!engine.previewHold(sec * 1000)) throw new HttpError(400, 'nothing is being sent right now (no stream, no output, or the screen is off)');
    return json(statusJson());
  },
};
const READ_ONLY = new Set(['/', '/dock', '/overlay', '/favicon.ico', '/api/status', '/api/events', '/api/log', '/api/config', '/api/screen.png', '/api/scenes']);
const RAW_BODY = new Set(['/api/screen']);

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

function readBody(req, { raw = false } = {}) {
  const limit = raw ? MAX_SCREEN_BYTES : 65536;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, raw ? 'file too large (max 16 MB)' : 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (raw) return resolve(Buffer.concat(chunks));
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
    const body = req.method === 'POST' ? await readBody(req, { raw: RAW_BODY.has(url.pathname) }) : undefined;
    const r = await route(url.searchParams, body);
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
  log(`  Output -> ${cfgm.outputConfigured(config) ? cfgm.maskUrl(config.outputUrl) : '(no stream key yet)'}${config.bandwidthTest ? ' [BANDWIDTH TEST: the channel stays offline]' : ''}`);
  log(`  Delay screen: ${config.delayScreen === 'off' ? 'off' : config.delayScreen === 'freeze' ? 'freeze last frame' : config.delayScreen === 'default' ? 'built-in' : config.delayScreen}${config.clipSec ? ` · clips: last ${config.clipSec}s` : ''}${config.recordDir ? ` · recording to ${config.recordDir}/` : ''}`);
  log('  Press Ctrl+C to stop.');
  input.start();
});
