// Browser test of the offline desktop version: the database lives on the computer (src/local-db.js),
// with no internet at all — every outside address is blocked.
// Run: npm run e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'test/fixtures/export.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let server, base, browser, ctx, page;
const errors = [];

before(async () => {
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (path === 'api/config') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ configured: true, local: true })); return; }
    const file = join(ROOT, path === '' ? 'index.html' : path);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body); } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}/`;
  browser = await chromium.launch();
  ctx = await browser.newContext({ locale: 'ar-EG', viewport: { width: 1200, height: 900 }, acceptDownloads: true });
  // No internet: only the app itself answers.
  await ctx.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
});
after(async () => { await browser?.close(); server?.close(); });

const text = (sel) => page.locator(sel).first().innerText();
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await page.waitForTimeout(100); } return false; };

test('first start: name the pharmacy, no account, no internet', async () => {
  await page.goto(base);
  await page.waitForSelector('#phNameNew');
  assert.match(await text('#auth'), /على الجهاز ده بس/);
  await page.fill('#phNameNew', 'صيدلية أحمد منصور');
  await page.click('#createForm button[type=submit]');
  await page.waitForSelector('#app:not([hidden])');
  assert.equal(await text('#phTitle'), 'صيدلية أحمد منصور');
  assert.equal(await page.locator('#logout').isHidden(), true, 'no sign-out in the desktop version');
  assert.match(await text('#netChip'), /على الجهاز/);
});

test('upload the item list, add an item, receive a delivery', async () => {
  await page.setInputFiles('#file', FIXTURE);
  assert.ok(await until(async () => /اتحفظت/.test(await text('#fileMsg'))));
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=items]');
  await page.click('#newItemBtn');
  await page.fill('#itName', 'شاش طبي');
  await page.fill('#itBarcode', '6220000000001');
  await page.fill('#itPrice', '15');
  await page.fill('#itQty', '10');
  await page.click('#itemForm button[type=submit]');
  await page.fill('#itemsQ', 'شاش');
  assert.ok(await until(async () => /10/.test(await text('#itemsBody tr'))));
  await page.click('[data-sec=buy]');
  await page.click('[data-tab=receive]');
  await page.selectOption('#rcvSup', '__new');
  await page.fill('#rcvSupName', 'مخزن الأمل');
  await page.fill('#rcvQ', '6220000000001');
  await page.press('#rcvQ', 'Enter');
  await page.fill('[data-l="0"][data-f="qty"]', '5');
  await page.fill('[data-l="0"][data-f="cost"]', '9');
  await page.click('#rcvForm button[type=submit]');
  assert.ok(await until(async () => /اتسجلت الطلبية/.test(await text('#rcvMsg'))));
});

test('the cashier sells with no internet, and stock goes down', async () => {
  await page.goto(`${base}cashier.html`);
  await page.waitForSelector('#pos:not([hidden])');
  await page.evaluate(() => { window.print = () => {}; });
  assert.ok(await until(async () => /صنف/.test(await text('#posMsg'))));
  await page.fill('#q', '6220000000001');
  await page.press('#q', 'Enter');
  await page.keyboard.press('F2');
  assert.ok(await until(async () => /الفاتورة اتسجلت/.test(await text('#posMsg'))));
  assert.match(await text('#netChip'), /محفوظ على الجهاز/);
  await page.fill('#q', 'شاش');
  assert.match(await text('#results'), /رصيد 14/);
});

test('everything is still there after closing and opening again', async () => {
  const p2 = await ctx.newPage();
  await p2.goto(base);
  await p2.waitForSelector('#app:not([hidden])');
  await p2.click('[data-sec=stock]');
  await p2.click('[data-tab=items]');
  await p2.fill('#itemsQ', 'شاش');
  assert.ok(await until(async () => /14/.test(await p2.locator('#itemsBody tr').first().innerText())));
  await p2.close();
});

test('attendance works on the same computer', async () => {
  await page.goto(`${base}attendance.html`);
  await page.waitForSelector('#app:not([hidden])');
  await page.click('[data-tab=staff]');
  await page.fill('#nName', 'سارة');
  await page.fill('#nPin', '1234');
  await page.click('#addForm button[type=submit]');
  assert.ok(await until(async () => /سارة/.test(await text('#staff'))));
  await page.click('[data-tab=kiosk]');
  for (const k of '1234') await page.click(`#pad [data-k="${k}"]`);
  await page.click('#pad [data-k="ok"]');
  assert.ok(await until(async () => /سارة/.test(await text('#result'))));
});

test('backup to a file and back', async () => {
  await page.goto(base);
  await page.waitForSelector('#app:not([hidden])');
  await page.click('#localBox summary');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const path = await dl.path();
  const dump = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(dump.app, 'saydaliti');
  assert.ok(dump.tables.pos_sales.length === 1 && dump.tables.purchases.length === 1);
  // Restore an older copy: the sale made after it disappears.
  dump.tables.pos_sales = [];
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const file = join(await mkdtemp(join(tmpdir(), 'sd-')), 'old.json');
  await writeFile(file, JSON.stringify(dump));
  await page.setInputFiles('#restoreFile', file);
  await page.waitForSelector('#app:not([hidden])');
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=items]');
  await page.fill('#itemsQ', 'شاش');
  assert.ok(await until(async () => /15/.test(await text('#itemsBody tr'))));
});

test('no script errors', () => {
  assert.deepEqual(errors, []);
});
