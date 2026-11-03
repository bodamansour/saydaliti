// The app must open with no connection: every module the dashboard, cashier and attendance pages
// import (directly or through other modules) has to be in the service worker's saved copy (sw.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const shell = new Set([...read('sw.js').matchAll(/'\.\/(src\/[\w-]+\.js)'/g)].map((m) => m[1]));

function imports(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const m of read(file).matchAll(/^\s*import\s[^'"]*['"]\.\/([\w-]+\.js)['"]/gm)) imports(`src/${m[1]}`, seen);
  return seen;
}

test('every module of the offline pages is in the service worker copy', () => {
  for (const entry of ['src/app.js', 'src/cashier.js', 'src/attendance-app.js']) {
    for (const f of imports(entry)) assert.ok(shell.has(f), `${f} (imported from ${entry}) is missing from sw.js SHELL`);
  }
});
