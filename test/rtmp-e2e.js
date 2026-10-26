'use strict';
// Protocol test for the native RTMP code, without the delay engine:
//   ffmpeg (fake OBS) --rtmp--> RtmpIngest --tags--> RtmpPublisher --rtmp--> ffmpeg -listen (fake Twitch) --> out.flv
// Then: RtmpPublisher --> RtmpIngest (InstantDelay to InstantDelay) to check both sides against each other.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RtmpIngest } = require('../src/rtmp/ingest');
const { RtmpPublisher } = require('../src/rtmp/publish');

const FF = process.env.FFMPEG || 'ffmpeg';
const FP = process.env.FFPROBE || 'ffprobe';
if (spawnSync(FF, ['-version']).status !== 0) { console.log('SKIP rtmp e2e: ffmpeg not found'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instantdelay-rtmp-'));
const outFile = path.join(tmp, 'out.flv');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

async function main() {
  // Fake Twitch: ffmpeg listening for a publisher, writing what it gets to a file.
  const sink = spawn(FF, ['-hide_banner', '-loglevel', 'warning', '-listen', '1', '-i', 'rtmp://127.0.0.1:19356/app/secret',
    '-c', 'copy', '-f', 'flv', '-y', outFile], { stdio: 'inherit' });
  await sleep(700);

  const ingest = new RtmpIngest({ host: '127.0.0.1', port: 19357, key: 'stream' });
  const warns = [];
  ingest.on('warn', (w) => warns.push(w));
  let tags = 0, keyframes = 0, metadata = 0;
  const pub = new RtmpPublisher('rtmp://127.0.0.1:19356/app/secret');
  let pubReady = false;
  pub.on('ready', () => { pubReady = true; });
  pub.on('error', (e) => console.log('publisher error:', e.message));
  ingest.on('tag', (t) => {
    tags++;
    if (t.type === 9 && t.isKey && !t.isSeq) keyframes++;
    if (t.type === 18 && t.isSeq) metadata++;
    if (pubReady) pub.send(t);
  });
  let published = 0, unpublished = 0;
  ingest.on('publish', () => published++);
  ingest.on('unpublish', () => unpublished++);
  await new Promise((r) => { ingest.on('listening', r); ingest.start(); });
  pub.connect();
  for (let i = 0; i < 50 && !pubReady; i++) await sleep(100);
  check(pubReady, 'publisher got NetStream.Publish.Start from ffmpeg');

  // Wrong key is rejected.
  const bad = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'flv', 'rtmp://127.0.0.1:19357/live/wrongkey'], { stdio: 'ignore' });
  await new Promise((r) => bad.on('exit', r));
  check(published === 0 && warns.some((w) => /rejected publish/.test(w)), 'wrong stream key is rejected');

  const obs = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-c:a', 'aac', '-t', '6',
    '-f', 'flv', 'rtmp://127.0.0.1:19357/live/stream'], { stdio: 'inherit' });
  await new Promise((r) => obs.on('exit', r));
  await sleep(500);
  check(published === 1, 'publisher accepted');
  check(metadata === 1, `onMetaData received as a script tag (${metadata})`);
  check(keyframes >= 2 && tags > 300, `media tags received (${tags} tags, ${keyframes} keyframes)`);
  check(unpublished === 1, 'unpublish seen when ffmpeg finished');

  pub.end();
  await new Promise((r) => sink.on('exit', r));
  const probe = spawnSync(FP, ['-v', 'error', '-show_entries', 'packet=codec_type', '-of', 'csv=p=0', outFile], { encoding: 'utf8' });
  const lines = probe.stdout.trim().split('\n');
  const v = lines.filter((l) => l.startsWith('video')).length;
  const a = lines.filter((l) => l.startsWith('audio')).length;
  const decode = spawnSync(FF, ['-v', 'error', '-i', outFile, '-f', 'null', '-'], { encoding: 'utf8' });
  check(v > 150 && a > 150, `ffmpeg received video+audio over RTMP (${v} video, ${a} audio packets)`);
  check(!decode.stderr.trim(), `received file decodes cleanly${decode.stderr ? ': ' + decode.stderr.split('\n')[0] : ''}`);
  const meta = spawnSync(FP, ['-v', 'error', '-show_entries', 'format_tags=encoder', '-of', 'csv=p=0', outFile], { encoding: 'utf8' });
  check(/Lavf/.test(meta.stdout), `onMetaData forwarded (encoder tag: ${meta.stdout.trim()})`);

  // InstantDelay -> InstantDelay
  const in2 = new RtmpIngest({ host: '127.0.0.1', port: 19358, key: '' });
  let got = 0;
  in2.on('tag', () => got++);
  await new Promise((r) => { in2.on('listening', r); in2.start(); });
  const pub2 = new RtmpPublisher('rtmp://127.0.0.1:19358/live/anything?x=1');
  const ready2 = await new Promise((r) => { pub2.on('ready', () => r(true)); pub2.on('error', () => r(false)); pub2.connect(); });
  check(ready2, 'our publisher connects to our ingest');
  for (let i = 0; i < 100; i++) pub2.send({ type: 9, ts: i * 33, data: Buffer.from([0x17, 1, 0, 0, 0, i]) });
  await sleep(300);
  check(got === 100, `100 tags arrived (${got})`);
  pub2.end();
  await sleep(300);
  ingest.stop(); in2.stop();
  console.log(failures.length ? `FAIL (${failures.length})` : 'PASS');
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
