'use strict';
// config.json loading, validation, saving and the public (secret-free) view of it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = readJson(path.join(ROOT, 'config.example.json'));
const FILE = process.env.INSTANTDELAY_CONFIG || path.join(ROOT, 'config.json');
const PLACEHOLDER = 'YOUR_TWITCH_STREAM_KEY';

// Keys that can be changed while running, and keys that need a restart.
const LIVE_KEYS = ['outputUrl', 'presetsSec', 'maxDelaySec', 'initialDelaySec', 'endAfterIdleSec'];
const RESTART_KEYS = ['rtmpHost', 'rtmpPort', 'ingestKey', 'httpPort', 'transport', 'ffmpegPath'];

class ConfigError extends Error {}

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Notepad may save a BOM
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON (${e.message}).\n` +
      '  Tip: write Windows paths with forward slashes, e.g. "C:/ffmpeg/bin/ffmpeg.exe".');
  }
}

function load() {
  const exists = fs.existsSync(FILE);
  const user = exists ? readJson(FILE) : {};
  const cfg = { ...DEFAULTS, ...user };
  if (process.env.OUTPUT_URL) cfg.outputUrl = process.env.OUTPUT_URL;
  if (process.env.RTMP_PORT) cfg.rtmpPort = Number(process.env.RTMP_PORT);
  if (process.env.HTTP_PORT) cfg.httpPort = Number(process.env.HTTP_PORT);
  if (process.env.END_AFTER_IDLE_SEC) cfg.endAfterIdleSec = Number(process.env.END_AFTER_IDLE_SEC);
  if (process.env.TRANSPORT) cfg.transport = process.env.TRANSPORT;
  if (process.env.FFMPEG_PATH) cfg.ffmpegPath = process.env.FFMPEG_PATH;
  const errors = validate(cfg);
  if (errors.length) throw new ConfigError(errors.join('\n'));
  cfg._exists = exists;
  return cfg;
}

// Returns a list of problems with the given (partial) config.
function validate(c) {
  const errs = [];
  const num = (k, lo, hi) => {
    if (!(k in c)) return;
    if (!Number.isFinite(c[k]) || c[k] < lo || c[k] > hi) errs.push(`"${k}" must be a number between ${lo} and ${hi} (got ${JSON.stringify(c[k])})`);
  };
  num('rtmpPort', 1, 65535); num('httpPort', 1, 65535);
  num('maxDelaySec', 1, 3600); num('initialDelaySec', 0, 3600); num('endAfterIdleSec', 0, 86400);
  if ('presetsSec' in c && !(Array.isArray(c.presetsSec) && c.presetsSec.length <= 12 && c.presetsSec.every((p) => Number.isFinite(p) && p >= 0 && p <= 3600))) {
    errs.push('"presetsSec" must be a list of up to 12 numbers of seconds');
  }
  if ('outputUrl' in c && typeof c.outputUrl !== 'string') errs.push('"outputUrl" must be a string');
  if ('transport' in c && !['native', 'ffmpeg'].includes(c.transport)) errs.push('"transport" must be "native" or "ffmpeg"');
  for (const k of ['rtmpHost', 'ingestKey', 'ffmpegPath']) if (k in c && typeof c[k] !== 'string') errs.push(`"${k}" must be a string`);
  if (c.rtmpPort && c.httpPort && c.rtmpPort === c.httpPort) errs.push('"rtmpPort" and "httpPort" must differ');
  return errs;
}

function save(cfg) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = cfg[k];
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n');
}

function outputConfigured(cfg) {
  return !!cfg.outputUrl && !cfg.outputUrl.includes(PLACEHOLDER);
}

// A stream key or a full rtmp(s):// URL -> output URL.
function outputUrlFrom(keyOrUrl) {
  const s = String(keyOrUrl || '').trim();
  if (!s) return '';
  return /^rtmps?:\/\//i.test(s) ? s : `rtmp://live.twitch.tv/app/${s}`;
}

// The parts of the output URL that must never be printed.
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

function maskUrl(url) {
  if (!url) return '';
  let s = url;
  for (const secret of secretsOf(url)) s = s.split(secret).join(secret.slice(0, 5) + '****');
  return s;
}

// What the dock may see.
function publicView(cfg) {
  const v = {};
  for (const k of Object.keys(DEFAULTS)) if (k !== 'outputUrl') v[k] = cfg[k];
  v.outputMasked = outputConfigured(cfg) ? maskUrl(cfg.outputUrl) : '';
  v.outputIsFile = !!cfg.outputUrl && !/^rtmps?:\/\//i.test(cfg.outputUrl);
  v.configFile = FILE;
  return v;
}

module.exports = { ROOT, FILE, DEFAULTS, LIVE_KEYS, RESTART_KEYS, ConfigError, load, validate, save, outputConfigured, outputUrlFrom, secretsOf, maskUrl, publicView, readJson };
