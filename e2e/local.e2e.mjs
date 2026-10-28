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
  assert.ok(await until(async () => /محفوظ على الجهاز/.test(await text('#netChip'))));
  await page.fill('#q', 'شاش');
  assert.ok(await until(async () => /رصيد 14/.test(await text('#results'))));
});

test('a return comes back only against its receipt, and only once', async () => {
  // In return mode with no receipt, nothing is recorded.
  await page.click('#modeReturn');
  await page.fill('#q', '6220000000001');
  await page.press('#q', 'Enter');
  await page.keyboard.press('F2');
  assert.match(await text('#posMsg'), /رقم فاتورة البيع/);
  // From today's list: the receipt's item, at most what was sold.
  await page.click('#dayList [data-retid]');
  assert.ok(await until(async () => /فاتورة/.test(await text('#retInfo'))));
  assert.equal(await page.locator('#cart tr').count(), 1);
  await page.click('#cart [data-inc]');
  assert.equal(await page.inputValue('#cart [data-qty]'), '1', 'can\'t return more than was sold');
  await page.keyboard.press('F2');
  assert.ok(await until(async () => /المرتجع اتسجل/.test(await text('#posMsg'))));
  await page.fill('#q', 'شاش');
  assert.ok(await until(async () => /رصيد 15/.test(await text('#results'))));
  await page.fill('#q', '');
  await page.click('#dayList [data-retid]');
  assert.ok(await until(async () => /اترجع قبل كده/.test(await text('#retInfo'))));
  // With no receipt, a reason is required.
  await page.click('#retNoReceipt');
  await page.fill('#q', '6220000000001');
  await page.press('#q', 'Enter');
  await page.keyboard.press('F2');
  assert.match(await text('#posMsg'), /اكتب سبب/);
  await page.keyboard.press('Escape');
});

test('everything is still there after closing and opening again', async () => {
  const p2 = await ctx.newPage();
  await p2.goto(base);
  await p2.waitForSelector('#app:not([hidden])');
  await p2.click('[data-sec=stock]');
  await p2.click('[data-tab=items]');
  await p2.fill('#itemsQ', 'شاش');
  assert.ok(await until(async () => /15/.test(await p2.locator('#itemsBody tr').first().innerText())));
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
  assert.ok(dump.tables.pos_sales.length === 2 && dump.tables.purchases.length === 1);
  // Restore an older copy: the return made after it disappears.
  dump.tables.pos_sales = dump.tables.pos_sales.filter((x) => x.kind === 'sale');
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const file = join(await mkdtemp(join(tmpdir(), 'sd-')), 'old.json');
  // A broken copy (a row with no id, or a cut-off file) is refused and nothing changes.
  const broken = join(await mkdtemp(join(tmpdir(), 'sd-')), 'broken.json');
  await writeFile(broken, JSON.stringify({ ...dump, tables: { ...dump.tables, purchases: [{ lines: [] }] } }));
  await page.setInputFiles('#restoreFile', broken);
  assert.ok(await until(async () => /فيها مشكلة/.test(await text('#backupMsg'))));
  await writeFile(broken, JSON.stringify(dump).slice(0, 500));
  await page.setInputFiles('#restoreFile', broken);
  assert.ok(await until(async () => /ناقص أو بايظ/.test(await text('#backupMsg'))));
  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=items]');
  await page.fill('#itemsQ', 'شاش');
  assert.ok(await until(async () => /15/.test(await text('#itemsBody tr'))), 'the data on the computer is unchanged');
  await page.click('#localBox summary');
  await writeFile(file, JSON.stringify(dump));
  await page.setInputFiles('#restoreFile', file);
  await page.waitForSelector('#app:not([hidden])');
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=items]');
  await page.fill('#itemsQ', 'شاش');
  assert.ok(await until(async () => /14/.test(await text('#itemsBody tr'))));
});

test('a United (Genius) backup file is read straight away', async () => {
  const { backup } = await import('../test/fixtures/genius-backup.js');
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const file = join(await mkdtemp(join(tmpdir(), 'sd-')), 'genius_db_202610241600.Gen');
  await writeFile(file, backup());
  await page.goto(base);
  await page.waitForSelector('#app:not([hidden])');
  await page.setInputFiles('#file', file);
  assert.ok(await until(async () => /باك اب المتحدة/.test(await text('#fileMsg'))), 'saved from the backup');
  assert.match(await text('#fileMsg'), /3 صنف/);
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=items]');
  await page.fill('#itemsQ', 'بانادول');
  assert.match(await text('#itemsBody tr'), /12/);
  await page.fill('#itemsQ', 'رصيده صفر');
  assert.match(await text('#itemsBody tr'), /خلصان/, 'items with no stock are in the list too');
});

test('each cashier signs in with a PIN, opens a shift with the drawer, and closes it with a count', async () => {
  await page.goto(`${base}cashier.html`);
  await page.waitForSelector('#pos:not([hidden])');
  await page.evaluate(() => { window.print = () => {}; });
  await page.click('#pos details.help summary');
  await page.check('#requirePin');
  await page.waitForSelector('#pinDlg[open]');
  await page.fill('#pinIn', '9999');
  await page.click('#pinOk');
  assert.ok(await until(async () => /غلط/.test(await text('#pinMsg'))));
  await page.fill('#pinIn', '1234');
  await page.click('#pinOk');
  await page.waitForSelector('#openCashWrap:not([hidden])');
  await page.fill('#openCash', '100');
  await page.click('#pinOk');
  assert.ok(await until(async () => /سارة/.test(await text('#cashierChip'))));
  await page.fill('#q', 'بانادول');
  await page.press('#q', 'Enter');
  await page.keyboard.press('F2');
  assert.ok(await until(async () => /الفاتورة اتسجلت/.test(await text('#posMsg'))));
  assert.match(await text('#dayList'), /سارة/, 'the receipt says who sold it');
  await page.click('#closeShift');
  await page.waitForSelector('#shiftDlg[open]');
  const expected = Number((await text('#shSum .tot .n')).replace(/,/g, ''));
  assert.ok(expected > 100, 'the drawer: 100 at the start plus the cash sale');
  await page.fill('#shCount', String(expected - 5));
  assert.match(await text('#shDiffLabel'), /ناقص/);
  await page.click('#shiftForm button[type=submit]');
  await page.waitForSelector('#pinDlg[open]');
  // The owner sees the shift, the shortfall, and the log of changes.
  await page.goto(base);
  await page.waitForSelector('#app:not([hidden])');
  await page.click('[data-sec=money]');
  await page.click('[data-tab=shifts]');
  assert.ok(await until(async () => /سارة/.test(await text('#panel')) && /ناقص/.test(await text('#panel'))));
  await page.click('[data-tab=log]');
  assert.ok(await until(async () => /وردية/.test(await text('#panel'))));
});

test('fixes made here become a correction file for United', async () => {
  await page.goto(base);
  await page.waitForSelector('#app:not([hidden])');
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=items]');
  await page.fill('#itemsQ', 'كريم شمس');
  await page.click('#itemsBody [data-edititem]');
  await page.fill('#itPrice', '450');
  await page.click('#itemForm button[type=submit]');
  await page.click('#exportBox summary');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#geniusFix')]);
  const fix = JSON.parse(await readFile(await dl.path(), 'utf8'));
  assert.equal(fix.kind, 'genius-corrections');
  const k = fix.items.find((x) => x.code === '5002');
  assert.deepEqual([k.price, k.oldPrice], [450, 420]);
  assert.ok(!fix.items.some((x) => x.code === '5004'), 'items not touched here are left as United has them');
});

test('no script errors', () => {
  assert.deepEqual(errors, []);
});
