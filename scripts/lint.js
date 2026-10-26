'use strict';
// Syntax-check every source and test file (works the same on Windows, macOS and Linux).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const dirs = ['src', 'src/rtmp', 'src/transports', 'test', 'scripts'];
let failed = 0;
for (const dir of dirs) {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    if (!f.endsWith('.js')) continue;
    const file = path.join(root, dir, f);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) { failed++; console.error(r.stderr || `${file}: syntax error`); }
  }
}
console.log(failed ? `lint: ${failed} file(s) failed` : 'lint: ok');
process.exit(failed ? 1 : 0);
