'use strict';
// First-run setup: asks for the Twitch stream key (hidden while typing) and writes config.json.
// Run: node src/setup.js   (start.bat runs it automatically when config.json is missing)

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const file = path.join(ROOT, 'config.json');

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
  console.log('Find your stream key at: https://dashboard.twitch.tv  ->  Settings  ->  Stream  ->  Primary Stream key (Copy)');
  console.log('Paste it below and press Enter (right-click pastes in most Windows terminals). It stays hidden.\n');
  let key = '';
  while (!key) {
    key = await ask('Twitch stream key: ', { hidden: true });
    if (/\s/.test(key)) { console.log('That has spaces in it; copy the key again.'); key = ''; }
  }
  // Accept a full rtmp(s) URL too (YouTube, Kick, a specific Twitch ingest...).
  const outputUrl = /^rtmps?:\/\//i.test(key) ? key : `rtmp://live.twitch.tv/app/${key}`;
  if (!/^rtmps?:\/\//i.test(key) && !key.startsWith('live_')) {
    console.log('Note: Twitch keys normally start with "live_". If streaming fails, run setup again.');
  }

  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...defaults, ...existing, outputUrl }, null, 2) + '\n');
  console.log(`\nSaved to ${file}`);
  console.log('To change it later, delete config.json and start InstantDelay again (or edit the file).\n');
})();
