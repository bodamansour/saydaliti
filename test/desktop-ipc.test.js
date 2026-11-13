// The Windows program's bridge (desktop/main.js): every IPC handler checks who is asking before doing anything,
// and the page runs isolated and sandboxed. Static checks of the source (Electron is not started here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');

test('every IPC handler checks the sender first', () => {
  const all = [...src.matchAll(/ipcMain\.handle\(/g)].map((m) => m.index);
  assert.ok(all.length >= 10, `found ${all.length} handlers`);
  for (const at of all) {
    // From this handler to its first statement (the next line for a block body).
    const head = src.slice(at, src.indexOf('\n', src.indexOf('\n', at) + 1));
    const m = /^ipcMain\.handle\('([^']+)',\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*(.*)$/s.exec(head);
    assert.ok(m, `unrecognised handler: ${head.split('\n')[0]}`);
    const [, name, params, body] = m;
    const first = body.startsWith('{\n') ? body.slice(2) : body.split('\n')[0];
    assert.match(params, /^e\b/, `${name}: the event is used`);
    // The check must decide the outcome: refuse (return/throw) when it fails, or choose the result (ternary / if-body).
    const sender = String.raw`(?:trusted\(e\)|e\.senderFrame\?\.url\?\.startsWith\('app:\/\/'\))`;
    const guards = new RegExp(String.raw`^\s*\{?\s*(?:if \([^\n]*!${sender}[^\n]*\) (?:return|throw)\b|\(${sender} \?|if \(${sender}\) )`);
    assert.match(first, guards, `${name}: refuses before anything else when the sender is not trusted`);
  }
});

test('the window is isolated and sandboxed', () => {
  const prefs = /webPreferences:\s*\{([^}]*)\}/.exec(src)?.[1] || '';
  assert.match(prefs, /contextIsolation: true/);
  assert.match(prefs, /nodeIntegration: false/);
  assert.match(prefs, /sandbox: true/);
});

test('an update finds the data of the version named Saydaliti, and the United sync keeps starting with Windows', () => {
  const pin = src.indexOf("app.setPath('userData', LEGACY_DATA)");
  assert.ok(pin > 0, 'the old data folder is used when it is there');
  assert.match(src, /LEGACY_DATA = join\(app\.getPath\('appData'\), 'Saydaliti'\)/);
  for (const use of ["app.requestSingleInstanceLock()", "app.getPath('userData')"]) {
    assert.ok(src.indexOf(use) > pin, `${use} comes after the data folder is chosen`);
  }
  assert.match(src, /if \(SYNC\?\.enabled\) \{ startWithWindows\(true\);/, 'the start-with-Windows entry is renewed at every start');
});
