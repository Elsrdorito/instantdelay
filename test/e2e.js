'use strict';
// End-to-end test: fake "OBS" (ffmpeg test pattern) -> proxy -> out.flv.
// Changes the delay mid-stream, checks the API guards, then stops "OBS" and
// checks the output was ended cleanly, is continuous and decodes without errors.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const FF = process.env.FFMPEG || 'ffmpeg';
const FP = process.env.FFPROBE || 'ffprobe';
const TRANSPORT = process.env.TRANSPORT || 'native';
if (spawnSync(FF, ['-version']).status !== 0 || spawnSync(FP, ['-version']).status !== 0) {
  console.log('SKIP e2e: ffmpeg/ffprobe not on PATH (Windows: winget install ffmpeg)');
  process.exit(0);
}
// OUTPUT=rtmp: publish over RTMP to a fake ingest (ffmpeg -listen) instead of writing a file directly.
const OUTPUT_RTMP = process.env.OUTPUT === 'rtmp';
console.log(`e2e with transport=${TRANSPORT}${OUTPUT_RTMP ? ', output over RTMP' : ''}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instantdelay-'));
const outFile = path.join(tmp, 'out.flv');
const sink = OUTPUT_RTMP ? spawn(FF, ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', 'rtmp://127.0.0.1:19360/app/sekrit?x=1',
  '-c', 'copy', '-f', 'flv', '-y', outFile], { stdio: 'inherit' }) : null;
const env = { ...process.env, OUTPUT_URL: OUTPUT_RTMP ? 'rtmp://127.0.0.1:19360/app/sekrit?x=1' : outFile, RTMP_PORT: '19355', HTTP_PORT: '18787', END_AFTER_IDLE_SEC: '2', TRANSPORT, INSTANTDELAY_CONFIG: path.join(tmp, 'config.json') };
if (TRANSPORT === 'ffmpeg') env.FFMPEG_PATH = FF;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p, headers) => fetch(`http://127.0.0.1:18787${p}`, { headers });
const api = (p) => get(p).then((r) => r.json());

const failures = [];
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

// IPC channel: lets the server shut down cleanly on every OS (Windows has no real SIGTERM).
const server = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
let obs = null;

async function run() {
  await sleep(1000);
  obs = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-c:a', 'aac',
    '-f', 'flv', 'rtmp://127.0.0.1:19355/live/stream'], { stdio: 'inherit' });

  let s;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    s = await api('/api/status');
    if (s.inputActive && s.outputActive) break;
  }
  await sleep(1000);
  check(s.inputActive && s.outputActive && s.effectiveDelayMs === 0, 'live with no delay, input and output active');

  s = await api('/api/delay?sec=5');
  check(s.delayMs === 5000 && s.filling, 'raise to 5s starts filling');
  await sleep(7000);
  s = await api('/api/status');
  check(!s.filling && Math.abs(s.bufferedMs - 5000) < 300, `5s delay reached (buffered ${s.bufferedMs}ms)`);

  const bad = await get('/api/delay?sec=abc');
  s = await api('/api/status');
  check(bad.status === 400 && s.delayMs === 5000, 'invalid ?sec= is rejected and keeps the delay');
  const xsite = await get('/api/instant', { 'Sec-Fetch-Site': 'cross-site' });
  s = await api('/api/status');
  check(xsite.status === 403 && s.delayMs === 5000, 'cross-site request is blocked');
  // fetch() silently drops a custom Host header, so use http.request here.
  const rebind = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: 18787, path: '/api/instant', headers: { Host: 'evil.example:18787' } },
      (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve(0));
  });
  s = await api('/api/status');
  check(rebind === 403 && s.delayMs === 5000, 'foreign Host header (DNS rebinding) is blocked');

  s = await api('/api/cut?sec=2');
  check(s.removedMs > 1500 && s.removedMs < 2500 && s.delayMs === 5000, `cut removed ${s.removedMs}ms and kept the delay`);
  await sleep(2500);

  s = await api('/api/instant');
  check(s.delayMs === 0 && s.bufferedMs < 500 && s.dropped > 0, 'instant jumps back to live');
  await sleep(3000);
  s = await api('/api/delay?add=3');
  check(s.delayMs === 3000, 'add=3 nudges the delay');
  await sleep(5000);

  const cfg = await api('/api/config');
  check(!('outputUrl' in cfg) && (OUTPUT_RTMP ? /sekri\*\*\*\*/.test(cfg.outputMasked) && !JSON.stringify(cfg).includes('sekrit') : cfg.outputIsFile), 'config view hides the stream key');
  const post = (body, headers = {}) => fetch('http://127.0.0.1:18787/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  let r = await post({ presetsSec: [0, 10, 20], maxDelaySec: 120, endAfterIdleSec: 2 });
  let j = await r.json();
  check(r.status === 200 && j.config.presetsSec.join() === '0,10,20' && j.restartRequired.length === 0, 'settings can be changed live');
  r = await post({ maxDelaySec: 'nope' });
  check(r.status === 400, 'bad settings are rejected');
  r = await post({ presetsSec: [0, 5] }, { 'Sec-Fetch-Site': 'cross-site' });
  check(r.status === 403, 'cross-site settings change is blocked');
  r = await post({ rtmpPort: 19399 });
  j = await r.json();
  check(r.status === 200 && j.restartRequired.join() === 'rtmpPort', 'port change reports restartRequired');
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  check(saved.rtmpPort === 19399 && saved.presetsSec.join() === '0,10,20', 'settings are written to config.json');
  s = await api('/api/status');
  check(s.presetsSec.join() === '0,10,20' && s.maxDelaySec === 120 && s.inKbps > 100, `status reflects settings and bitrate (${s.inKbps} kbps)`);

  obs.kill();
  await sleep(3000 + 3000 + 2000 + 1000); // input timeout + drain 3s buffer + idle 2s + margin
  s = await api('/api/status');
  check(!s.inputActive && !s.outputActive, 'output ended after OBS stopped');
  if (sink) {
    for (let i = 0; i < 40 && sink.exitCode === null; i++) await sleep(250);
    check(sink.exitCode !== null, 'fake ingest saw the end of the broadcast');
  }
}

async function verifyFile() {
  const probe = spawnSync(FP, ['-v', 'error', '-show_entries', 'packet=codec_type,dts_time', '-of', 'json', outFile], { encoding: 'utf8' });
  const packets = JSON.parse(probe.stdout || '{"packets":[]}').packets;
  const vids = packets.filter((p) => p.codec_type === 'video').map((p) => Number(p.dts_time));
  let maxGap = 0, backwards = 0;
  for (let i = 1; i < vids.length; i++) { const g = vids[i] - vids[i - 1]; if (g < 0) backwards++; maxGap = Math.max(maxGap, g); }
  // -copyts + passthrough: keep the file's own timestamps, so any frame displayed out of order
  // (e.g. at a delay cut) is reported, without false alarms from frame-rate rounding.
  const decode = spawnSync(FF, ['-v', 'error', '-copyts', '-i', outFile, '-fps_mode', 'passthrough', '-f', 'null', '-'], { encoding: 'utf8' });
  const errors = (probe.stderr + decode.stderr).trim();
  console.log(`RESULT video packets=${vids.length} duration=${(vids.at(-1) || 0).toFixed(2)}s maxDtsGap=${maxGap.toFixed(3)}s backwards=${backwards}`);
  check(vids.length > 300, 'output has enough video');
  check(vids.length < 700, `output skipped the cut and the instant jump (${vids.length} packets)`);
  check(backwards === 0 && maxGap < 0.2, 'output timeline is continuous');
  check(!errors, `output decodes cleanly${errors ? `: ${errors.split('\n')[0]}` : ''}`);
}

run()
  .catch((e) => check(false, `test crashed: ${e.message}`))
  .then(async () => {
    if (obs) obs.kill();
    if (server.connected) server.send('shutdown');
    await new Promise((r) => { server.once('exit', r); setTimeout(() => { server.kill(); r(); }, 5000); });
    if (sink && sink.exitCode === null) await new Promise((r) => { sink.once('exit', r); setTimeout(() => { sink.kill(); r(); }, 5000); });
    if (fs.existsSync(outFile)) await verifyFile();
    else check(false, 'output file was written');
    console.log(failures.length ? `FAIL (${failures.length})` : 'PASS');
    process.exit(failures.length ? 1 : 0);
  });
