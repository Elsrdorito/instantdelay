'use strict';
// Fallback transport that uses ffmpeg for RTMP (the way v1 worked):
//   OBS --RTMP--> ffmpeg -listen (remux to FLV) --stdout--> FlvParser --> tags
//   tags --> FLV --stdin--> ffmpeg --RTMP--> ingest
// Select it with "transport": "ffmpeg" in config.json.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { FlvParser, flvHeader, encodeTag } = require('../flv');

const IS_WIN = process.platform === 'win32';

// Find a working ffmpeg. Right after `winget install ffmpeg`, PATH is only
// updated for newly opened windows, so also look where winget puts it.
function resolveFfmpeg(configured, root) {
  const exe = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [configured];
  if (configured === 'ffmpeg') {
    candidates.push(path.join(root, 'ffmpeg', exe), path.join(root, 'ffmpeg', 'bin', exe));
    if (IS_WIN && process.env.LOCALAPPDATA) {
      const winget = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet');
      candidates.push(path.join(winget, 'Links', exe), ...wingetPackages(path.join(winget, 'Packages')));
    }
    if (IS_WIN) candidates.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
    else candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg');
  }
  for (const c of candidates) {
    const r = spawnSync(c, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return c;
  }
  return null;
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

// Emits: 'publish', 'unpublish', 'tag', 'warn', 'error'
class FfmpegInput extends EventEmitter {
  constructor({ ffmpeg, host, port }) {
    super();
    this.ffmpeg = ffmpeg;
    this.url = `rtmp://${host}:${port}/live`;
    this.ff = null;
    this.stopped = false;
    this.fails = 0;
  }

  start() { this._spawn(); setImmediate(() => this.emit('listening')); }

  stop() { this.stopped = true; if (this.ff) this.ff.kill(); }

  _spawn() {
    if (this.stopped) return;
    const ff = spawn(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-listen', '1', '-i', this.url,
      '-c', 'copy', '-f', 'flv', '-flvflags', 'no_duration_filesize', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.ff = ff;
    const parser = new FlvParser((tag) => this.emit('tag', tag));
    let connected = false;
    let lastErr = '';
    ff.stdout.on('data', (chunk) => {
      if (!connected) { connected = true; this.fails = 0; this.emit('publish', { peer: 'ffmpeg' }); }
      try { parser.push(chunk); } catch (e) { this.emit('warn', `input parse error: ${e.message}`); ff.kill(); }
    });
    ff.stderr.on('data', (d) => { lastErr = d.toString().trim(); this.emit('warn', `[ffmpeg in] ${lastErr}`); });
    ff.on('error', (e) => this.emit('warn', `cannot start ffmpeg: ${e.message}`));
    ff.on('exit', () => {
      this.ff = null;
      if (this.stopped) return;
      if (connected) this.emit('unpublish', { peer: 'ffmpeg' });
      else this.fails++;
      if (/in use|10048|bind/i.test(lastErr)) { this.emit('error', Object.assign(new Error(lastErr), { code: 'EADDRINUSE' })); return; }
      setTimeout(() => this._spawn(), connected ? 300 : Math.min(10000, 500 * 2 ** Math.min(this.fails, 5)));
    });
  }
}

// Same interface as RtmpPublisher: connect(), send(tag), end(), destroy(), backlog,
// events 'ready' (accepts tags), 'connected' (ingest confirmed), 'error', 'close'.
// ffmpeg only opens the output after it has read the input headers from stdin, so
// 'ready' comes right after spawn and 'connected' once ffmpeg prints progress.
class FfmpegOutput extends EventEmitter {
  constructor({ ffmpeg, url }) {
    super();
    this.ffmpeg = ffmpeg;
    this.url = url;
    this.ready = false;
    this.closed = false;
  }

  get backlog() { return this.ff ? this.ff.stdin.writableLength : 0; }

  connect() {
    const isRtmp = /^rtmps?:\/\//i.test(this.url);
    const ff = spawn(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostats',
      // Progress lines only start once the output is open, so they double as a "connected" signal.
      '-progress', 'pipe:1', '-stats_period', '1',
      '-analyzeduration', '500000',
      '-f', 'flv', '-i', 'pipe:0',
      '-c', 'copy', '-f', 'flv', ...(isRtmp ? [] : ['-y']), this.url,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.ff = ff;
    ff.stdin.on('error', () => {});
    ff.stdout.on('data', () => { if (!this.connected) { this.connected = true; this.emit('connected'); } });
    ff.stderr.on('data', (d) => this.emit('warn', `[ffmpeg out] ${d.toString().trim()}`));
    ff.on('error', (e) => this.emit('error', e));
    ff.on('exit', (code) => {
      this.ready = false;
      if (this.closed) return;
      this.closed = true;
      if (code) this.emit('error', new Error(`ffmpeg exited with code ${code}`));
      this.emit('close');
    });
    ff.stdin.write(flvHeader());
    this.ready = true;
    setImmediate(() => this.emit('ready'));
  }

  send(tag) { return this.ready ? this.ff.stdin.write(encodeTag(tag.type, tag.ts, tag.data)) : false; }
  end() { this.ready = false; if (this.ff) { this.ff.stdin.end(); setTimeout(() => this.ff && this.ff.kill(), 5000).unref(); } }
  destroy() { this.ready = false; if (this.ff) this.ff.kill(); }
}

module.exports = { resolveFfmpeg, FfmpegInput, FfmpegOutput };
