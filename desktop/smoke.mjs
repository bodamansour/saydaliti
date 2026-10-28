// Starts the Windows program (on any OS) and clicks through it with no internet.
// Run: npm run app && node smoke.mjs   (Linux without a screen: xvfb-run node smoke.mjs)
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const data = await mkdtemp(join(tmpdir(), 'saydaliti-desktop-'));
const launch = () => electron.launch({ cwd: HERE, args: ['.', '--no-sandbox', `--user-data-dir=${data}`], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
const errors = [];
let app = await launch();
let win = await app.firstWindow();
win.on('pageerror', (e) => errors.push(e.message));
await win.route(/^https?:\/\//, (r) => { errors.push(`internet: ${r.request().url()}`); r.abort(); });
// First start: choose how to run. This part of the test is the computer-only version.
await win.waitForSelector('#local', { timeout: 20000 });
await win.click('#local');
await win.waitForSelector('#phNameNew', { timeout: 20000 });
await win.fill('#phNameNew', 'صيدلية أحمد منصور');
await win.click('#createForm button[type=submit]');
await win.waitForSelector('#app:not([hidden])');
assert.equal(await win.locator('#phTitle').innerText(), 'صيدلية أحمد منصور');
assert.ok(await win.evaluate(() => typeof XLSX !== 'undefined'), 'Excel reader bundled');
assert.ok(await win.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px "IBM Plex Sans Arabic"', 'صيدلية'); }), 'Arabic font bundled');
assert.ok(await win.evaluate(() => !!window.saydalitiDesktop?.saveBackup), 'desktop bridge');
await win.click('#localBox summary');
await win.click('#backupBtn');
await win.waitForFunction(() => /اتحفظت/.test(document.getElementById('backupMsg').textContent));
console.log('backup:', await win.locator('#backupMsg').innerText());
await win.goto('app://saydaliti/cashier.html');
await win.waitForSelector('#pos:not([hidden])');
await win.screenshot({ path: join(data, 'cashier.png') });
await app.close();
// Data survives closing the program.
app = await launch();
win = await app.firstWindow();
await win.waitForSelector('#app:not([hidden])', { timeout: 20000 });
assert.equal(await win.locator('#phTitle').innerText(), 'صيدلية أحمد منصور');
await win.screenshot({ path: join(data, 'dashboard.png') });
await app.close();

// Online: the program opens the website (here a copy served on this computer) and keeps its bridge.
const { createServer } = await import('node:http');
const { readFile } = await import('node:fs/promises');
const SITE_ROOT = join(HERE, 'app');
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/api/config') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ configured: true, local: true })); return; }
  try { const body = await readFile(join(SITE_ROOT, path === '/' ? 'index.html' : path)); res.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' }).end(body); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${server.address().port}`;
const data2 = await mkdtemp(join(tmpdir(), 'saydaliti-desktop-online-'));
app = await electron.launch({ cwd: HERE, args: ['.', '--no-sandbox', `--user-data-dir=${data2}`], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', SAYDALITI_SITE: site } });
win = await app.firstWindow();
win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('#online', { timeout: 20000 });
await win.click('#online');
await win.waitForURL(`${site}/index.html`, { timeout: 20000 });
await win.waitForSelector('#phNameNew, #app:not([hidden])', { timeout: 20000 });
assert.ok(await win.evaluate(() => !!window.saydalitiDesktop?.printSilent), 'silent printing works on the website too');
await app.close();
// Next time it opens online straight away.
app = await electron.launch({ cwd: HERE, args: ['.', '--no-sandbox', `--user-data-dir=${data2}`], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', SAYDALITI_SITE: site } });
win = await app.firstWindow();
await win.waitForURL(`${site}/index.html`, { timeout: 20000 });
await app.close();
server.close();
assert.deepEqual(errors, []);
console.log('desktop smoke test passed; screenshots in', data);
