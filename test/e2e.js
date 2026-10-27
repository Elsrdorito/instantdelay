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
// Clips and the recording go to the temp folder (absolute paths are allowed in the file, not over HTTP).
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ clipSec: 30, clipDir: path.join(tmp, 'clips'), recordDir: path.join(tmp, 'recordings') }));
if (TRANSPORT === 'ffmpeg') env.FFMPEG_PATH = FF;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// On Windows some ffmpeg installs (Chocolatey) are shims that start the real ffmpeg as a child; kill the whole tree.
const killTree = (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
};
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
  await sleep(1500);
  s = await api('/api/status');
  check(s.holding && s.holdKind === 'screen' && s.outputActive && s.holdTags > 0, `delay screen is sent while the delay builds (${s.holdKind}, ${s.holdTags} tags, ${s.outKbps} kb/s)`);
  check(s.screen && s.screen.mode === 'screen' && s.screen.width === 640 && s.screen.frameBytes > 1000, `screen encoded for the stream (${JSON.stringify(s.screen)})`);
  await sleep(7000); // fill (5 s from the raise) + up to one keyframe interval (2 s) for the stream to resume
  s = await api('/api/status');
  check(!s.filling && !s.holding && Math.abs(s.bufferedMs - 5000) < 300, `5s delay reached and stream resumed (buffered ${s.bufferedMs}ms)`);
  check(s.holds === 1 && s.holdTags > 100, `one hold with filler tags (${s.holdTags})`);

  const png = await get('/api/screen.png');
  check(png.status === 200 && png.headers.get('content-type') === 'image/png', 'screen preview is served');
  let up = await fetch('http://127.0.0.1:18787/api/screen', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: fs.readFileSync(path.join(__dirname, '../public/screen.png')) });
  let uj = await up.json();
  check(up.status === 200 && uj.config.delayScreen === 'screens/custom.png' && fs.existsSync(path.join(__dirname, '../screens/custom.png')), 'custom screen upload is saved and selected');
  up = await fetch('http://127.0.0.1:18787/api/screen', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('nope') });
  check(up.status === 400, 'a non-PNG upload is rejected');
  s = await api('/api/screen/preview?sec=2');
  check(s.holding, 'screen preview shows the screen to viewers');
  await sleep(4800); // 2 s preview + up to one keyframe interval to resume
  s = await api('/api/status');
  check(!s.holding && s.holds === 2, 'preview ended by itself');

  s = await api('/api/clip?sec=4');
  // Starts on the keyframe before the window, so 4 s requested = 4 s to 4 s + one GOP (2 s).
  check(s.file && s.ms >= 3900 && s.ms < 7000 && s.bytes > 50000, `clip of the last 4s saved (${s.file}, ${s.ms}ms, ${s.bytes} bytes)`);
  await sleep(500);
  const clipFile = path.join(tmp, 'clips', path.basename(s.file));
  check(fs.existsSync(clipFile), 'clip file exists in the configured folder');
  const clipProbe = spawnSync(FF, ['-v', 'error', '-i', clipFile, '-f', 'null', '-'], { encoding: 'utf8' });
  check(clipProbe.status === 0 && !clipProbe.stderr.trim(), `clip decodes cleanly${clipProbe.stderr ? ': ' + clipProbe.stderr.split('\n')[0] : ''}`);
  const scenes = await get('/api/scenes');
  check(scenes.status === 400, 'scenes endpoint reports OBS WebSocket as not configured');

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
  r = await post({ delayScreen: '../../etc/passwd.png' });
  check(r.status === 400, 'arbitrary screen paths are rejected over HTTP');
  r = await post({ webhookUrl: 'ftp://nope' });
  check(r.status === 400, 'bad webhook URL is rejected');
  r = await post({ sceneDelays: { Gameplay: 30, Chat: 0 }, obsWsUrl: '' });
  j = await r.json();
  check(r.status === 200 && j.config.sceneDelays.Gameplay === 30, 'scene rules are saved');
  r = await post({ delayScreen: 'default', bandwidthTest: false });
  j = await r.json();
  check(r.status === 200 && j.config.delayScreen === 'default', 'screen set back to the built-in one');
  check(!('obsWsPassword' in j.config) && !('outputUrlBackup' in j.config) && 'obsWsPasswordSet' in j.config, 'config view hides the OBS password and backup key');
  r = await post({ presetsSec: [0, 5] }, { 'Sec-Fetch-Site': 'cross-site' });
  check(r.status === 403, 'cross-site settings change is blocked');
  r = await post({ rtmpPort: 19399 });
  j = await r.json();
  check(r.status === 200 && j.restartRequired.join() === 'rtmpPort', 'port change reports restartRequired');
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  check(saved.rtmpPort === 19399 && saved.presetsSec.join() === '0,10,20', 'settings are written to config.json');
  s = await api('/api/status');
  check(s.presetsSec.join() === '0,10,20' && s.maxDelaySec === 120 && s.inKbps > 100, `status reflects settings and bitrate (${s.inKbps} kbps)`);

  killTree(obs);
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
  // -enc_time_base 1/1000: keep FLV's millisecond timebase for the null muxer's checks; otherwise ffmpeg guesses a
  // frame rate from the first packets (10 fps if the file opens with a delay screen) and reports false dts collisions.
  const decode = spawnSync(FF, ['-v', 'error', '-copyts', '-i', outFile, '-fps_mode', 'passthrough', '-enc_time_base', '1/1000', '-f', 'null', '-'], { encoding: 'utf8' });
  const errors = (probe.stderr + decode.stderr).trim();
  console.log(`RESULT video packets=${vids.length} duration=${(vids.at(-1) || 0).toFixed(2)}s maxDtsGap=${maxGap.toFixed(3)}s backwards=${backwards}`);
  check(vids.length > 300, 'output has enough video');
  // Delay screens run at 10 fps, so holds add few packets; the cut and the instant jump remove many.
  check(vids.length < 900, `output skipped the cut and the instant jump (${vids.length} packets)`);
  // A splice after B-frames sits (reorder depth + 34 ms) after the last decoded frame: up to ~0.24 s with bf=3.
  check(backwards === 0 && maxGap < 0.25, `output timeline is continuous (max gap ${maxGap.toFixed(3)}s, backwards ${backwards})`);
  check(!errors, `output (x264 + delay screens spliced in) decodes cleanly${errors ? `: ${errors.split('\n')[0]}` : ''}`);
  const recDir = path.join(tmp, 'recordings');
  const recs = fs.existsSync(recDir) ? fs.readdirSync(recDir).filter((f) => f.endsWith('.flv')) : [];
  check(recs.length >= 1 && fs.statSync(path.join(recDir, recs[0])).size > 100000, `recording of the broadcast was written (${recs.join(', ')})`);
}

run()
  .catch((e) => check(false, `test crashed: ${e.message}`))
  .then(async () => {
    killTree(obs);
    if (server.connected) server.send('shutdown');
    await new Promise((r) => { server.once('exit', r); setTimeout(() => { server.kill(); r(); }, 5000); });
    if (sink && sink.exitCode === null) await new Promise((r) => { sink.once('exit', r); setTimeout(() => { killTree(sink); r(); }, 5000); });
    if (fs.existsSync(outFile)) await verifyFile();
    else check(false, 'output file was written');
    console.log(failures.length ? `FAIL (${failures.length})` : 'PASS');
    process.exit(failures.length ? 1 : 0);
  });
