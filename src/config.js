'use strict';
// config.json loading, validation, saving and the public (secret-free) view of it.
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = readJson(path.join(ROOT, 'config.example.json'));
const FILE = process.env.INSTANTDELAY_CONFIG || path.join(ROOT, 'config.json');
const PLACEHOLDER = 'YOUR_TWITCH_STREAM_KEY';

// Keys that can be changed while running, and keys that need a restart.
const LIVE_KEYS = ['outputUrl', 'outputUrlBackup', 'bandwidthTest', 'presetsSec', 'maxDelaySec', 'initialDelaySec', 'endAfterIdleSec', 'maxBufferMB',
  'delayScreen', 'clipSec', 'clipDir', 'recordDir', 'webhookUrl', 'obsWsUrl', 'obsWsPassword', 'sceneDelays'];
const RESTART_KEYS = ['rtmpHost', 'rtmpPort', 'ingestKey', 'httpPort', 'transport'];
// Only editable in the file (it names a program to run).
const FILE_ONLY_KEYS = ['ffmpegPath'];

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
  const num = (k, lo, hi, integer = false) => {
    if (!(k in c)) return;
    if (!Number.isFinite(c[k]) || c[k] < lo || c[k] > hi || (integer && !Number.isInteger(c[k]))) {
      errs.push(`"${k}" must be ${integer ? 'a whole' : 'a'} number between ${lo} and ${hi} (got ${JSON.stringify(c[k])})`);
    }
  };
  num('rtmpPort', 1, 65535, true); num('httpPort', 1, 65535, true);
  num('maxDelaySec', 1, 3600); num('initialDelaySec', 0, 3600); num('endAfterIdleSec', 0, 86400); num('maxBufferMB', 16, 65536);
  if ('rtmpHost' in c && !(c.rtmpHost === 'localhost' || net.isIP(c.rtmpHost))) errs.push('"rtmpHost" must be an IP address such as 127.0.0.1 or 0.0.0.0');
  if ('presetsSec' in c && !(Array.isArray(c.presetsSec) && c.presetsSec.length <= 12 && c.presetsSec.every((p) => Number.isFinite(p) && p >= 0 && p <= 3600))) {
    errs.push('"presetsSec" must be a list of up to 12 numbers of seconds');
  }
  num('clipSec', 0, 600);
  if ('transport' in c && !['native', 'ffmpeg'].includes(c.transport)) errs.push('"transport" must be "native" or "ffmpeg"');
  for (const k of ['outputUrl', 'outputUrlBackup', 'rtmpHost', 'ingestKey', 'ffmpegPath', 'delayScreen', 'clipDir', 'recordDir', 'webhookUrl', 'obsWsUrl', 'obsWsPassword']) {
    if (k in c && typeof c[k] !== 'string') errs.push(`"${k}" must be a string`);
  }
  if ('bandwidthTest' in c && typeof c.bandwidthTest !== 'boolean') errs.push('"bandwidthTest" must be true or false');
  if ('outputUrlBackup' in c && c.outputUrlBackup && !/^rtmps?:\/\//i.test(c.outputUrlBackup)) errs.push('"outputUrlBackup" must be an rtmp:// or rtmps:// URL');
  if ('delayScreen' in c && typeof c.delayScreen === 'string' && !['default', 'freeze', 'off'].includes(c.delayScreen) && !/\.png$/i.test(c.delayScreen)) {
    errs.push('"delayScreen" must be "default", "freeze", "off" or the path of a .png file');
  }
  if ('webhookUrl' in c && c.webhookUrl && !/^https?:\/\//i.test(c.webhookUrl)) errs.push('"webhookUrl" must be an http(s):// URL');
  if ('obsWsUrl' in c && c.obsWsUrl && !/^wss?:\/\//i.test(c.obsWsUrl)) errs.push('"obsWsUrl" must be a ws:// URL such as ws://127.0.0.1:4455');
  if ('sceneDelays' in c && !(c.sceneDelays && typeof c.sceneDelays === 'object' && !Array.isArray(c.sceneDelays) &&
    Object.values(c.sceneDelays).every((v) => Number.isFinite(v) && v >= 0 && v <= 3600))) {
    errs.push('"sceneDelays" must map scene names to seconds, e.g. {"Gameplay": 30}');
  }
  for (const k of ['clipDir', 'recordDir']) if (c[k] && path.isAbsolute(c[k]) === false && c[k].split(/[\\/]/).includes('..')) errs.push(`"${k}" must not contain ".."`);
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
  for (const k of Object.keys(DEFAULTS)) if (!['outputUrl', 'outputUrlBackup', 'obsWsPassword'].includes(k)) v[k] = cfg[k];
  v.outputMasked = outputConfigured(cfg) ? maskUrl(cfg.outputUrl) : '';
  v.outputIsFile = !!cfg.outputUrl && !/^rtmps?:\/\//i.test(cfg.outputUrl);
  v.outputBackupMasked = cfg.outputUrlBackup ? maskUrl(cfg.outputUrlBackup) : '';
  v.obsWsPasswordSet = !!cfg.obsWsPassword;
  v.configFile = FILE;
  return v;
}

// Everything the log must redact.
function allSecrets(cfg) {
  return [...secretsOf(cfg.outputUrl), ...secretsOf(cfg.outputUrlBackup), cfg.obsWsPassword].filter((s) => s && s.length >= 4);
}

module.exports = { ROOT, FILE, DEFAULTS, LIVE_KEYS, RESTART_KEYS, FILE_ONLY_KEYS, ConfigError, load, validate, save, outputConfigured, outputUrlFrom, secretsOf, allSecrets, maskUrl, publicView, readJson };
