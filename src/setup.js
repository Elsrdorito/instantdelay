'use strict';
// First-run setup: asks for the stream key (hidden while typing) and writes config.json.
// Run: node src/setup.js   (start.bat / start.sh run it when config.json is missing)
// You can also skip this and set the key in the dock: http://127.0.0.1:8787/dock -> Settings.

const readline = require('readline');
const cfgm = require('./config');

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Print * instead of the typed characters, so the key never shows up on stream.
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : s.replace(/[^\r\n]/g, '*'));
  }
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); if (hidden) console.log(); resolve(a.trim()); }));
}

(async () => {
  console.log('\nInstantDelay setup\n');
  console.log('Twitch: https://dashboard.twitch.tv -> Settings -> Stream -> Primary Stream key (Copy)');
  console.log('YouTube / Kick / other: paste the full rtmp:// or rtmps:// URL including the key.');
  console.log('Paste it below and press Enter (right-click pastes in most Windows terminals). It stays hidden.\n');
  let key = '';
  while (!key) {
    key = await ask('Stream key or RTMP URL: ', { hidden: true });
    if (/\s/.test(key)) { console.log('That has spaces in it; copy the key again.'); key = ''; }
  }
  const outputUrl = cfgm.outputUrlFrom(key);
  if (!/^rtmps?:\/\//i.test(key) && !key.startsWith('live_')) {
    console.log('Note: Twitch keys normally start with "live_". If streaming fails, run setup again.');
  }
  let cfg;
  try { cfg = cfgm.load(); } catch (e) { console.log(`Warning: ${e.message}\nStarting from defaults.`); cfg = { ...cfgm.DEFAULTS }; }
  cfg.outputUrl = outputUrl;
  cfgm.save(cfg);
  console.log(`\nSaved to ${cfgm.FILE}`);
  console.log('To change it later: dock -> Settings, or run this setup again.\n');
})();
