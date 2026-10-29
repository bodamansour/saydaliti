// Browser test of the dashboard against a stand-in database (e2e/supabase-stub.js).
// Run: npm run e2e   (needs `npx playwright install chromium` once)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Settings, backups, export and linking live in their own view («الإعدادات والأدوات»).
const openTools = async (p) => { if (await p.locator('#toolsView').isHidden()) await p.click('#toolsBtn'); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'test/fixtures/export.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let server, base, browser, ctx, page;
const errors = [];

before(async () => {
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(ROOT, path === '' ? 'index.html' : path);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body); } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}/`;
  const stub = await readFile(join(ROOT, 'e2e/supabase-stub.js'), 'utf8');
  browser = await chromium.launch();
  ctx = await browser.newContext({ locale: 'ar-EG', viewport: { width: 1200, height: 900 }, acceptDownloads: true });
  await ctx.route('**/api/config', (r) => r.fulfill({ json: { configured: true, url: 'https://stub.supabase.test', key: 'pk_test' } }));
  await ctx.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: stub }));
  // The Excel library comes from the local copy; fonts are skipped.
  const xlsx = await readFile(join(ROOT, 'node_modules/xlsx/dist/xlsx.full.min.js'), 'utf8');
  await ctx.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\//, (r) => r.fulfill({ contentType: 'text/javascript', body: xlsx }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  page = await ctx.newPage();
  page.on('pageerror', (e) => { errors.push(e.message); if (process.env.DEBUG) console.log('PAGEERROR', e.message, e.stack); });
  page.on('dialog', (d) => d.accept());
});
after(async () => { await browser?.close(); server?.close(); });

const text = (sel, p = page) => p.locator(sel).first().innerText();
const db = (k) => page.evaluate((k) => window.__DB?.[k] ?? [], k);
const goOffline = async () => { await ctx.setOffline(true); await page.evaluate(() => dispatchEvent(new Event('offline'))); };
const goOnline = async () => { await ctx.setOffline(false); await page.evaluate(() => dispatchEvent(new Event('online'))); };
// SHOTS=<folder> npm run e2e saves screenshots of the new screens for a visual check.
const shot = (name) => process.env.SHOTS && page.screenshot({ path: join(process.env.SHOTS, `${name}.png`), fullPage: true });
const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await page.waitForTimeout(100); } return false; };

test('sign-in comes first, and sign-up asks to confirm the password', async () => {
  await page.goto(base);
  await page.waitForSelector('#loginForm');
  assert.equal(await page.locator('#app').isHidden(), true);
  await page.click('#switchMode');
  await page.fill('#email', 'abdo@example.com');
  await page.fill('#password', 'pharmacy123');
  await page.fill('#password2', 'pharmacy124');
  await page.click('#loginForm button[type=submit]');
  assert.match(await text('#authMsg'), /مش زي بعض/);
  await page.click('#switchMode');
  await page.fill('#email', 'abdo@example.com');
  await page.fill('#password', 'pharmacy123');
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#app:not([hidden])');
});

test('dashboard opens with no example data, grouped in sections', async () => {
  assert.equal(await text('#phTitle'), 'صيدلية أحمد منصور');
  assert.deepEqual(await page.locator('#sections .sec').allInnerTexts(), ['المخزون', 'المشتريات', 'العملاء', 'الفلوس', 'البيع', 'المرضى']);
  assert.match(await text('#panel'), /لسه مفيش بيانات/);
  await page.click('[data-sec=money]');
  assert.deepEqual(await page.locator('#tabs .tab').allInnerTexts(), ['الأرباح', 'الفواتير والمبيعات', 'الورديات', 'المصروفات', 'المسحوبات', 'الحسابات', 'الشركاء', 'حاسبة المكسب', 'سجل التعديلات']);
  await page.click('[data-sec=patients]');
  assert.equal(await page.locator('#tabs').isHidden(), true, 'one-tab section has no tab row');
  await page.click('[data-sec=stock]');
});

test('upload needs a branch picked, then saves to that branch', async () => {
  await page.setInputFiles('#file', FIXTURE);
  assert.match(await text('#fileMsg'), /اختار الفرع/);
  await page.selectOption('#branchSel', 'b1');
  await page.setInputFiles('#file', FIXTURE);
  assert.ok(await until(async () => (await db('snapshots')).length === 1));
  assert.equal((await db('snapshots'))[0].branch_id, 'b1');
  assert.match(await text('#fileMsg'), /اتحفظت/);
});

test('a second upload shows which prices changed', async () => {
  const data = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const p = data.items.find((i) => i.code === '101');
  p.price = 56.1; p.cost = 44; // +10% price, higher cost
  const file = join(await mkdtemp(join(tmpdir(), 'sd-')), 'new-prices.json');
  await writeFile(file, JSON.stringify(data));
  await page.setInputFiles('#file', file);
  assert.ok(await until(async () => (await db('snapshots')).length === 2));
  await page.click('[data-sec=sell]');
  assert.match(await text('[data-tab=changes]'), /1/, 'tab shows one change');
  await page.click('[data-tab=changes]');
  const row = await text('#panel tbody tr');
  assert.match(row, /Panadol/);
  assert.match(row, /\+10%/);
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=morning]');
  assert.match(await page.inputValue('#morningMsg'), /سعره اتغير/);
});

test('suppliers: best discount, a manual pick, and the order message for WhatsApp', async () => {
  await page.click('[data-tab=reorder]');
  for (const [name, phone, all] of [['مخزن الأمل', '01011111111', '5'], ['مخزن النور', '', '8']]) {
    await page.fill('#supName', name);
    await page.fill('#supPhone', phone);
    await page.fill('#supAll', all);
    await page.click('#supForm button[type=submit]');
    await until(async () => (await page.locator('#supBox tbody tr').count()) > 0 && (await text('#supBox')).includes(name));
  }
  const settings = () => page.evaluate(() => window.__DB.members[0].pharmacies.settings);
  assert.ok(await until(async () => (await settings()).suppliers?.length === 2), 'suppliers saved for the pharmacy');
  const sel = page.locator('select[data-supfor="101"]');
  const ids = Object.fromEntries((await settings()).suppliers.map((x) => [x.name, x.id]));
  assert.equal(await sel.inputValue(), ids['مخزن النور'], 'biggest discount picked');
  assert.match(await text('.orders .card b'), /مخزن النور/);
  await sel.selectOption(ids['مخزن الأمل']);
  assert.ok(await until(async () => (await settings()).supplierFor?.['101'] === ids['مخزن الأمل']));
  assert.match(await text('.orders .card b'), /مخزن الأمل/);
  await page.evaluate(() => { window.open = (u) => { window.__opened = u; }; });
  await page.click('[data-wa="0"]');
  const url = await page.evaluate(() => window.__opened);
  assert.ok(url.startsWith('https://wa.me/201011111111?text='), url);
  const msg = decodeURIComponent(url.split('text=')[1]);
  assert.match(msg, /طلبية من صيدلية أحمد منصور \(الفرع الرئيسي\)/);
  assert.match(msg, /Panadol Extra 24 tab: \d+/);
});

test('expenses save online, and queue offline until the connection is back', async () => {
  await page.click('[data-sec=money]');
  await page.click('[data-tab=expenses]');
  await page.selectOption('#expKind', 'electricity');
  await page.fill('#expAmount', '1450');
  await page.click('#expForm button[type=submit]');
  assert.ok(await until(async () => (await db('expenses')).length === 1));
  await goOffline();
  // What the owner takes for himself is not a cost: it has its own tab.
  assert.equal(await page.locator('#expKind option[value=withdrawal]').count(), 0);
  await page.click('[data-tab=withdrawals]');
  await page.fill('#wdAmount', '3000');
  await page.click('#wdForm button[type=submit]');
  assert.ok(await until(async () => /مستني يترفع/.test(await text('#netChip'))), 'status shows the queued change');
  assert.equal((await db('expenses')).length, 1);
  await goOnline();
  assert.ok(await until(async () => (await db('expenses')).length === 2));
  assert.equal((await db('expenses')).find((e) => e.kind === 'withdrawal').person, 'صاحب الصيدلية');
  await page.click('[data-tab=books]');
  await page.selectOption('#periodSel', 'all');
  const books = await text('#panel .card .ledger');
  assert.match(books, /المصروفات المتسجلة/);
  assert.match(books, /مسحوبات/);
});

test('editing an expense, and adding last month\'s fixed costs in one tap', async () => {
  await page.click('[data-tab=expenses]');
  await page.locator('#panel tr', { hasText: 'كهربا' }).locator('[data-editexp]').click();
  assert.match(await text('#expForm h3'), /عدّل/);
  assert.equal(await page.inputValue('#expAmount'), '1450');
  await page.fill('#expAmount', '1500');
  await page.click('#expForm button[type=submit]');
  assert.ok(await until(async () => { const a = (await db('expenses')).map((e) => +e.amount); return a.includes(1500) && !a.includes(1450); }), 'edited, not duplicated');

  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const iso = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-01`;
  await page.selectOption('#expKind', 'rent');
  await page.fill('#expAmount', '5000');
  await page.fill('#expDate', iso);
  await page.click('#expForm button[type=submit]');
  await page.waitForSelector('#fixedCard');
  assert.match(await text('#fixedCard'), /إيجار/);
  await page.click('#addFixed');
  assert.ok(await until(async () => (await db('expenses')).filter((e) => e.kind === 'rent').length === 2));
  assert.equal(await page.locator('#fixedCard').count(), 0, 'nothing left to add');
});

test('market shortages, market prices and patient reminders', async () => {
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=shortages]');
  await page.fill('#shortName', 'Panadol Extra 24 tab');
  await page.click('#shortForm button[type=submit]');
  assert.ok(await until(async () => (await db('shortages')).length === 1));
  await page.click('[data-tab=reorder]');
  assert.equal(await page.locator('#panel .pill', { hasText: 'ناقص في السوق' }).count(), 1);

  await page.click('[data-sec=sell]');
  await page.click('[data-tab=prices]');
  await page.fill('#priceName', 'Sun cream SPF50');
  await page.fill('#priceVal', '250');
  await page.fill('#priceSrc', 'صيدلية تانية');
  await page.click('#priceForm button[type=submit]');
  assert.ok(await until(async () => (await db('market_prices')).length === 1));
  assert.match(await text('#panel > .tablebox tbody'), /أغلى/);

  await page.click('[data-sec=patients]');
  await page.fill('#remName', 'أم محمد');
  await page.fill('#remPhone', '01012345678');
  await page.fill('#remMed', 'جلوكوفاج 1000');
  await page.fill('#remTimes', '9 ص، 9 م');
  await page.click('#remForm button[type=submit]');
  assert.match(await text('#remMsg'), /يوافق/, 'consent is required');
  await page.check('#remConsent');
  await page.click('#remForm button[type=submit]');
  assert.ok(await until(async () => (await db('reminders')).length === 1));
  const [r] = await db('reminders');
  assert.deepEqual(r.dose_times, ['09:00', '21:00']);
  assert.equal((await db('patients'))[0].phone, '201012345678');
});

test('partner invite codes from the dashboard', async () => {
  await openTools(page);
  await page.click('#branchBox summary');
  await page.click('[data-invite=partner]');
  assert.ok(await until(async () => !(await page.locator('#inviteOut').isHidden())));
  assert.match(await text('#inviteText'), /CODE1/);
  assert.equal((await db('invites'))[0].role, 'partner');
});

test('cashier: scan, search, teach a barcode, take payment and print', async () => {
  await page.goto(`${base}cashier.html`);
  await page.waitForSelector('#pos:not([hidden])');
  await page.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
  assert.ok(await until(async () => /صنف/.test(await text('#posMsg'))), 'items loaded');
  await page.fill('#q', 'panadol');
  await page.press('#q', 'Enter');
  await page.fill('#q', '101'); // the item code, like a scanner sends it
  await page.press('#q', 'Enter');
  assert.equal(await page.inputValue('#cart [data-qty="0"]'), '2');
  await page.fill('#q', '6223000123456'); // a barcode the app doesn't know yet
  await page.press('#q', 'Enter');
  await page.waitForSelector('#unknownDlg[open]');
  await page.fill('#linkQ', 'sun');
  await page.click('#linkResults [data-link="202"]');
  assert.ok(await until(async () => (await db('pos_barcodes')).length === 1), 'barcode remembered');
  assert.equal((await db('pos_barcodes'))[0].code, '202');
  const total = await text('#tTotal');
  assert.equal(total, '532.20'); // 2 × 56.10 + 420
  await page.fill('#paid', '600');
  assert.equal(await text('#tChange'), '67.80');
  await page.keyboard.press('F2');
  assert.ok(await until(async () => (await db('pos_sales')).length === 1));
  const [sale] = await db('pos_sales');
  assert.deepEqual([sale.kind, sale.total, sale.paid, sale.lines.length], ['sale', 532.2, 600, 2]);
  assert.equal(await page.evaluate(() => window.__printed), 1);
  assert.match(await page.locator('#receipt').innerHTML(), /532\.20/);
  assert.equal(await page.locator('#cart tr').count(), 0, 'new bill after payment');
  // The barcode now works straight away.
  await page.fill('#q', '6223000123456');
  await page.press('#q', 'Enter');
  assert.match(await text('#cart'), /Sun cream/);
  // Discounts as a percent: 10% off the item (420 → 378), then 5% off the receipt (378 → 359.10).
  await page.click('#lineUnit');
  await page.fill('#cart [data-disc="0"]', '10');
  await page.press('#cart [data-disc="0"]', 'Tab');
  assert.equal(await text('#tTotal'), '378.00');
  await page.click('#extraUnit');
  assert.equal(await text('#extraUnit'), '%');
  await page.fill('#extraDisc', '5');
  assert.equal(await text('#tTotal'), '359.10');
  assert.equal(await text('#tDisc'), '60.90');
  // Back to pounds: the same discount, shown in pounds.
  await page.click('#extraUnit');
  assert.equal(await page.inputValue('#extraDisc'), '18.9');
  assert.equal(await text('#tTotal'), '359.10');
  await page.click('#lineUnit');
  await page.keyboard.press('Escape');
});

test('cashier: a return, and a sale with no connection', async () => {
  await page.click('#modeReturn');
  await page.fill('#q', '303');
  await page.press('#q', 'Enter');
  await page.keyboard.press('F2');
  assert.match(await text('#posMsg'), /رقم فاتورة البيع/, 'a return needs its receipt');
  assert.equal((await db('pos_sales')).length, 1);
  await page.click('#retNoReceipt');
  await page.fill('#retReason', 'بيعة قبل البرنامج');
  await page.keyboard.press('F2');
  assert.ok(await until(async () => (await db('pos_sales')).some((x) => x.kind === 'return' && x.total === -140 && /بيعة قبل البرنامج/.test(x.note))));
  await goOffline();
  await page.fill('#q', '101');
  await page.press('#q', 'Enter');
  await page.click('[data-pay="card"]');
  await page.keyboard.press('F2');
  assert.ok(await until(async () => /مستني يترفع/.test(await text('#netChip'))));
  assert.equal((await db('pos_sales')).length, 2, 'not uploaded while offline');
  assert.match(await text('#dayList'), /مستني النت/);
  await goOnline();
  assert.ok(await until(async () => (await db('pos_sales')).length === 3));
  const sum = await text('#daySum');
  assert.match(sum, /فيزا/);
  assert.match(sum, /مرتجعات/);
});

test('cashier sales show up in the dashboard', async () => {
  await page.goto(base);
  await page.waitForSelector('#app:not([hidden])');
  await page.click('[data-sec=money]');
  await page.click('[data-tab=pos]');
  assert.ok(await until(async () => (await page.locator('#panel .sale-row').count()) === 3), 'today\'s receipts');
  assert.match(await text('#panel .card .ledger'), /الصافي/);
  assert.match(await text('#panel'), /اتباع إيه/);
  // Find one receipt by an item in it, open it, and see its lines.
  await page.fill('#posQ', 'sun');
  assert.ok(await until(async () => (await page.locator('#panel .sale-row').count()) === 1), 'found by the item');
  await page.click('#panel .sale-row');
  assert.match(await text('#panel .sale-lines'), /Sun cream/);
  assert.equal(await page.locator('#panel [data-printsale]').count(), 1);
  // Yesterday had none.
  await page.fill('#posQ', '');
  await page.click('[data-posday]:nth-of-type(2)');
  assert.ok(await until(async () => /مفيش فواتير في الفترة دي/.test(await text('#panel'))));
  await page.click('[data-posday]');
});

test('stock: add a new item, receive a delivery, pay the supplier', async () => {
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=items]');
  await page.click('#newItemBtn');
  await page.fill('#itName', 'شاش طبي');
  await page.fill('#itBarcode', '6220000000001');
  await page.press('#itBarcode', 'Enter'); // a scanner ends with Enter: the form must not be sent yet
  assert.equal((await db('catalog_items')).length, 0);
  await page.fill('#itPrice', '15');
  await page.fill('#itCost', '10');
  await page.fill('#itQty', '20');
  await page.click('#itemForm button[type=submit]');
  assert.ok(await until(async () => (await db('catalog_items')).length === 1 && (await db('stock_moves')).length === 1));
  await page.fill('#itemsQ', 'شاش');
  assert.match(await text('#itemsBody tr'), /20/);

  await page.click('[data-sec=buy]');
  await page.click('[data-tab=receive]');
  const ids = Object.fromEntries((await page.evaluate(() => window.__DB.members[0].pharmacies.settings.suppliers)).map((x) => [x.name, x.id]));
  await page.selectOption('#rcvSup', ids['مخزن الأمل']);
  await page.fill('#rcvQ', '6220000000001');
  await page.press('#rcvQ', 'Enter');
  await page.fill('[data-l="0"][data-f="qty"]', '10');
  await page.fill('[data-l="0"][data-f="bonus"]', '2');
  await page.fill('[data-l="0"][data-f="cost"]', '9');
  await page.fill('#rcvQ', 'panadol');
  await page.press('#rcvQ', 'Enter');
  assert.equal(await page.locator('#rcvLines tr').count(), 2);
  await page.fill('#rcvPaid', '50');
  await shot('receive');
  await page.setViewportSize({ width: 390, height: 844 }); await shot('receive-phone'); await page.setViewportSize({ width: 1200, height: 900 });
  await page.click('#rcvForm button[type=submit]');
  assert.ok(await until(async () => (await db('purchases')).length === 1));
  const [p] = await db('purchases');
  assert.deepEqual([p.supplier_name, p.lines.length, p.branch_id, p.paid], ['مخزن الأمل', 2, 'b1', 50]);
  assert.match(await text('#rcvMsg'), /اتسجلت الطلبية/);

  await page.click('[data-sec=stock]');
  await page.click('[data-tab=items]');
  await page.fill('#itemsQ', 'شاش');
  assert.match(await text('#itemsBody tr'), /32/, '20 + 10 + 2 free');
  await page.fill('#itemsQ', ''); await shot('items');

  await page.click('[data-sec=buy]');
  await page.click('[data-tab=supaccounts]');
  assert.match(await text('#panel tbody tr'), /مخزن الأمل/);
  await page.fill('#payAmount', '20');
  await page.click('#payForm button[type=submit]');
  assert.ok(await until(async () => (await db('supplier_payments')).length === 1));
  await shot('accounts');
  await page.click('[data-tab=invoices]');
  assert.match(await text('#panel details summary'), /مخزن الأمل/);
});

test('cashier: sells from the stock entered here, and adds a brand-new item on the spot', async () => {
  await page.goto(`${base}cashier.html`);
  await page.waitForSelector('#pos:not([hidden])');
  await page.evaluate(() => { window.print = () => {}; });
  assert.ok(await until(async () => /صنف/.test(await text('#posMsg'))));
  await page.fill('#q', 'شاش');
  assert.match(await text('#results'), /رصيد 32/, 'stock = 20 entered + 12 received');
  await page.fill('#q', '6220000000001');
  await page.press('#q', 'Enter');
  assert.match(await text('#cart'), /شاش طبي/);
  await page.fill('#q', '6220000000099'); // not in the list at all
  await page.press('#q', 'Enter');
  await page.waitForSelector('#unknownDlg[open]');
  await page.fill('#niName', 'قطن 100 جم');
  await page.fill('#niPrice', '12');
  await page.press('#niPrice', 'Enter');
  assert.ok(await until(async () => (await db('catalog_items')).some((c) => c.barcode === '6220000000099' && c.name === 'قطن 100 جم')));
  assert.match(await text('#cart'), /قطن 100 جم/);
  await page.keyboard.press('F2');
  assert.ok(await until(async () => (await db('pos_sales')).length === 4));
  await page.fill('#q', 'شاش');
  assert.match(await text('#results'), /رصيد 31/, 'the sale took one off');
  await page.goto(base);
  await page.waitForSelector('#app:not([hidden])');
});

test('stock count, damaged boxes, and a return to the supplier', async () => {
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=adjust]');
  // Damaged: 2 boxes of gauze (31 on the shelf after the cashier sale).
  await page.click('[data-adjkind=damaged]');
  await page.fill('#adjQ', 'شاش');
  await page.press('#adjQ', 'Enter');
  assert.match(await text('#adjForm'), /الرصيد دلوقتي 31/);
  await page.fill('#adjQty', '2');
  await page.click('#adjForm button[type=submit]');
  assert.ok(await until(async () => (await db('stock_moves')).some((m) => m.kind === 'damaged' && m.qty === -2)));
  assert.match(await text('#adjMsg'), /اتسجل/);
  // Return 3 to the supplier: off the shelf and off what we owe him.
  await page.click('[data-adjkind=supplier_return]');
  await page.fill('#adjQ', '6220000000001');
  await page.press('#adjQ', 'Enter');
  await page.fill('#adjQty', '3');
  await page.fill('#adjCost', '9');
  await page.click('#adjForm button[type=submit]');
  assert.ok(await until(async () => (await db('supplier_payments')).some((p) => p.amount === 27)));
  // Shelf count: 20 found.
  await page.click('#countBox summary');
  await page.fill('#countQ', 'شاش');
  await page.fill('[data-count="6220000000001"]', '20');
  assert.match(await text('[data-diff="6220000000001"]'), /-6/);
  await shot('adjust'); await page.setViewportSize({ width: 390, height: 844 }); await shot('adjust-phone'); await page.setViewportSize({ width: 1200, height: 900 });
  await page.click('#countSave');
  assert.ok(await until(async () => (await db('stock_moves')).some((m) => m.kind === 'count' && m.qty === -6)));
  await page.click('[data-tab=items]');
  await page.fill('#itemsQ', 'شاش');
  assert.match(await text('#itemsBody tr'), /20/);
  await page.click('[data-sec=buy]');
  await page.click('[data-tab=supaccounts]');
  assert.match(await text('#panel tbody tr'), /37/, '64 owed − 27 returned');
  await page.click('[data-sec=money]');
  await page.click('[data-tab=books]');
  assert.match(await text('#panel'), /الهالك والمنتهي/);
});

test('customers: credit and insurance at the cashier, balances, collecting, claims', async () => {
  await page.click('[data-sec=customers]');
  await page.click('#cuNew');
  await page.fill('#cuName', 'شركة مصر للتأمين');
  await page.selectOption('#cuKind', 'insurance');
  await page.fill('#cuCov', '80');
  await page.click('#custForm button[type=submit]');
  assert.ok(await until(async () => (await db('customers')).length === 1));

  await page.goto(`${base}cashier.html`);
  await page.waitForSelector('#pos:not([hidden])');
  await page.evaluate(() => { window.print = () => {}; });
  assert.ok(await until(async () => /صنف/.test(await text('#posMsg'))));
  // A regular customer buying on credit, added at the counter.
  await page.fill('#q', '303'); await page.press('#q', 'Enter');   // 140
  await page.fill('#custQ', 'أستاذ سامي');
  await page.click('[data-newcust]');
  await page.fill('#ncPhone', '01012345678');
  await page.click('#custForm button[type=submit]');
  assert.ok(await until(async () => /أستاذ سامي/.test(await text('#custName'))), 'customer added and chosen');
  assert.equal(await text('#tCredit'), '140.00');
  await page.keyboard.press('F2');
  assert.ok(await until(async () => (await db('pos_sales')).some((x) => x.credit === 140 && x.payment === 'credit')));
  // Insurance: the company pays 80%, the patient pays the rest in cash.
  await page.fill('#q', '303'); await page.press('#q', 'Enter');
  await page.fill('#custQ', 'مصر');
  await page.press('#custQ', 'Enter');
  await page.fill('#claimNo', 'APP-1');
  assert.equal(await text('#tCredit'), '112.00');
  assert.equal(await text('#tNow'), '28.00');
  await page.fill('#paid', '50');
  assert.equal(await text('#tChange'), '22.00');
  await shot('cashier-insurance');
  await page.keyboard.press('F2');
  assert.ok(await until(async () => (await db('pos_sales')).some((x) => x.credit === 112 && x.claim_no === 'APP-1' && x.paid === 50)));
  assert.match(await text('#daySum'), /آجل/);

  await page.goto(base);
  await page.waitForSelector('#app:not([hidden])');
  await page.click('[data-sec=customers]');
  await page.click('[data-tab=customers]');
  assert.ok(await until(async () => /140/.test(await text('#panel tbody'))));
  await page.selectOption('#cpCust', { label: 'أستاذ سامي (عليه 140.00)' });
  await page.fill('#cpAmount', '40');
  await page.click('#cpayForm button[type=submit]');
  assert.ok(await until(async () => (await db('customer_payments')).length === 1));
  await page.locator('#panel tbody tr', { hasText: 'أستاذ سامي' }).locator('[data-stmt]').click();
  assert.match(await text('#panel .card'), /كشف حساب/);
  assert.match(await text('#panel'), /100\.00/, 'balance after paying 40');
  await shot('customers');
  await page.click('[data-tab=claims]');
  assert.match(await text('#panel .card'), /شركة مصر للتأمين/);
  assert.match(await page.inputValue('#claimMsg0'), /APP-1/);
  await page.click('[data-sec=money]');
  await page.click('[data-tab=profit]');
  assert.match(await text('#panel'), /كل شهر/);
  await shot('profit');
});

test('moving stock from one branch to another', async () => {
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=adjust]');
  await page.click('[data-adjkind=transfer]');
  await page.fill('#adjQ', 'شاش');
  await page.press('#adjQ', 'Enter');
  await page.selectOption('#adjTo', 'b2');
  await page.fill('#adjQty', '5');
  await page.click('#adjForm button[type=submit]');
  assert.ok(await until(async () => (await db('stock_moves')).filter((m) => m.kind === 'transfer').length === 2));
  const [out, inn] = (await db('stock_moves')).filter((m) => m.kind === 'transfer').sort((a, b) => a.qty - b.qty);
  assert.deepEqual([out.branch_id, out.qty, inn.branch_id, inn.qty, out.ref === inn.ref], ['b1', -5, 'b2', 5, true]);
  await page.selectOption('#branchSel', 'b2');
  await page.click('[data-tab=items]');
  await page.fill('#itemsQ', 'شاش');
  assert.match(await text('#itemsBody tr'), /\b5\b/);
  await page.selectOption('#branchSel', 'b1');
});

test('editing an item: quantity and expiry per batch; editing a purchase invoice', async () => {
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=items]');
  await page.fill('#itemsQ', 'شاش');
  const before = await text('#itemsBody tr');
  assert.match(before, /\b15\b/);
  await page.click('#itemsBody [data-edititem]');
  assert.equal(await page.inputValue('[data-bq="0"]'), '15');
  await page.fill('[data-bq="0"]', '12');
  await page.fill('[data-be="0"]', '2027-03-01');
  await page.fill('#itPrice', '16');
  await page.click('#itemForm button[type=submit]');
  assert.ok(await until(async () => (await db('stock_moves')).filter((m) => m.note === 'تعديل يدوي').length === 2));
  await page.fill('#itemsQ', 'شاش');
  const row = await text('#itemsBody tr');
  assert.match(row, /\b12\b/); assert.match(row, /16\.00/); assert.match(row, /2027|٢٠٢٧/);

  await page.click('[data-sec=buy]');
  await page.click('[data-tab=invoices]');
  await page.click('#panel details summary');
  await page.click('[data-editpurchase]');
  assert.equal(await page.inputValue('[data-l="0"][data-f="qty"]'), '10');
  await page.fill('[data-l="0"][data-f="qty"]', '8');
  await page.click('#rcvForm button[type=submit]');
  assert.ok(await until(async () => { const p = await db('purchases'); return p.length === 1 && p[0].lines[0].qty === 8; }), 'the same invoice, edited');
  assert.match(await text('#rcvMsg'), /اتعدلت الفاتورة/);
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=items]');
  await page.fill('#itemsQ', 'شاش');
  assert.match(await text('#itemsBody tr'), /\b10\b/, 'two fewer received');
});

test('export: Excel with every table, CSV, and the Saydaliti file', async () => {
  await openTools(page);
  await page.click('#exportBox summary');
  const [x] = await Promise.all([page.waitForEvent('download'), page.click('[data-export=xlsx]')]);
  assert.match(x.suggestedFilename(), /^saydaliti-.*\.xlsx$/);
  const xbytes = await readFile(await x.path());
  assert.equal(xbytes.subarray(0, 2).toString(), 'PK', 'a real Excel file');
  await page.selectOption('#exportWhich', 'الأصناف');
  const [c] = await Promise.all([page.waitForEvent('download'), page.click('[data-export=csv]')]);
  const csv = (await readFile(await c.path(), 'utf8')).replace(/^﻿/, '');
  assert.match(csv.split('\r\n')[0], /^الكود,الصنف,النوع,الباركود,سعر الشراء,سعر البيع,الرصيد/);
  assert.match(csv, /شاش طبي/);
  const [j] = await Promise.all([page.waitForEvent('download'), page.click('[data-export=json]')]);
  const json = JSON.parse(await readFile(await j.path(), 'utf8'));
  assert.ok(json.items.some((i) => i.name === 'شاش طبي'));
});

test('opens offline with saved data even after the sign-in expired', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(800); // let the app files finish caching
  await page.addInitScript(() => { window.__sessionExpired = true; });
  await goOffline();
  await page.reload();
  await page.waitForSelector('#app:not([hidden])', { timeout: 8000 });
  assert.match(await text('#netChip'), /من غير نت/);
  assert.ok(await until(async () => /5 صنف/.test(await text('#tiles'))), 'saved stock (3 uploaded + 2 added here) shows offline');
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=reorder]');
  assert.match(await text('.orders .card b'), /مخزن الأمل/, 'suppliers available offline');
  await goOnline();
});

test('phone size: no sideways scrolling in any section', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const tabs = ['customers', 'claims', 'profit', 'items', 'adjust', 'receive', 'invoices', 'supaccounts', 'reorder', 'expiry', 'dead', 'shortages', 'movers', 'morning', 'pos', 'expenses', 'withdrawals', 'books', 'partners', 'calc', 'offers', 'prices', 'changes', 'patients'];
  for (const tab of tabs) {
    const sec = await page.evaluate((t) => ({ customers: 'customers', claims: 'customers', profit: 'money', items: 'stock', adjust: 'stock', receive: 'buy', invoices: 'buy', supaccounts: 'buy', reorder: 'stock', expiry: 'stock', dead: 'stock', shortages: 'stock', movers: 'stock', morning: 'stock', pos: 'money', expenses: 'money', withdrawals: 'money', books: 'money', partners: 'money', calc: 'money', offers: 'sell', prices: 'sell', changes: 'sell', patients: 'patients' })[t], tab);
    await page.click(`[data-sec=${sec}]`);
    if (await page.locator(`#tabs [data-tab=${tab}]`).isVisible()) await page.click(`#tabs [data-tab=${tab}]`);
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; })); // open boxes are the widest
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.equal(over, 0, `${tab} scrolls sideways by ${over}px`);
  }
  await page.setViewportSize({ width: 1200, height: 900 });
});

test('sign-out works offline and leaves nothing on the device', async () => {
  await goOffline();
  await page.click('#logout');
  await page.waitForSelector('#loginForm', { timeout: 8000 });
  const left = await page.evaluate(async () => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('saydaliti-') && k !== 'saydaliti-config-v1');
    const idb = await new Promise((res) => {
      const r = indexedDB.open('saydaliti', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').count(); q.onsuccess = () => res(q.result); };
      r.onerror = () => res(-1);
    });
    return { keys, idb, signedIn: !!localStorage.getItem('sb-stub-auth-token') };
  });
  assert.deepEqual(left, { keys: [], idb: 0, signedIn: false });
  await goOnline();
});

test('a database without the latest updates still works', async () => {
  const p2 = await ctx.newPage();
  await p2.addInitScript(() => { window.__noBranches = true; window.__no008 = true; });
  await p2.goto(base);
  await p2.waitForSelector('#loginForm');
  await p2.fill('#email', 'abdo@example.com');
  await p2.fill('#password', 'pharmacy123');
  await p2.click('#loginForm button[type=submit]');
  await p2.waitForSelector('#app:not([hidden])');
  assert.equal(await p2.locator('#branchWrap').isHidden(), true, 'no branch picker');
  await p2.click('[data-sec=stock]');
  await p2.click('[data-tab=shortages]');
  assert.match(await text('#panel', p2), /محتاج تحديث قاعدة البيانات/);
  await p2.close();
});

test('a sale is never lost when the database update for the cashier is missing', async () => {
  const p3 = await ctx.newPage();
  await p3.addInitScript(() => { window.__no009 = true; window.print = () => {}; });
  await p3.goto(`${base}cashier.html`);
  await p3.waitForSelector('#pos:not([hidden])');
  const before = await p3.evaluate(() => window.__DB.pos_sales.length);
  assert.ok(await until(async () => /صنف/.test(await text('#posMsg', p3))), 'items loaded');
  await p3.fill('#q', '101');
  await p3.press('#q', 'Enter');
  await p3.keyboard.press('F2');
  await p3.waitForTimeout(1500); // a few sync attempts
  assert.equal(await p3.evaluate(() => window.__DB.pos_sales.length), before, 'not uploaded');
  assert.match(await text('#netChip', p3), /بيرفع 1/, 'still waiting in the queue');
  assert.match(await text('#dayList', p3), /مستني النت/);
  await p3.close();
});

test('two tabs queuing changes at the same moment lose none of them', async () => {
  const a = await ctx.newPage(), b = await ctx.newPage();
  await Promise.all([a.goto(`${base}cashier.html`), b.goto(base)]);
  const run = (p, tag) => p.evaluate(async (tag) => {
    const { enqueue } = await import('./src/offline.js');
    await Promise.all(Array.from({ length: 40 }, (_, i) => enqueue('test-only', { tag, i })));
  }, tag);
  await Promise.all([run(a, 'a'), run(b, 'b')]);
  const queued = await a.evaluate(async () => (await (await import('./src/offline.js')).pending()).filter((e) => e.type === 'test-only').length);
  assert.equal(queued, 80);
  await a.evaluate(async () => { const { kvUpdate } = await import('./src/offline.js'); await kvUpdate('outbox', (q) => q.filter((e) => e.type !== 'test-only'), []); });
  await a.close(); await b.close();
});

test('subscription: a note while it runs, the dashboard locks after the grace days, the cashier never', async () => {
  const setSub = (sub) => page.evaluate((sub) => {
    window.__DB.subscriptions = sub ? [{ pharmacy_id: 'ph1', ...sub }] : [];
    window.__DB.app_config = [{ grace_days: 7, price_month: 500, price_branch: 250, pay_note: 'إنستاباي: test@instapay', support_phone: '01000000000' }];
    localStorage.setItem('__stubdb', JSON.stringify(window.__DB));
  }, sub);
  await page.goto(base);
  await page.waitForSelector('#app:not([hidden])');
  const soon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  await setSub({ status: 'trial', trial_ends: soon });
  await page.reload(); await page.waitForSelector('#app:not([hidden])');
  assert.ok(await until(async () => /فاضل 2 يوم/.test(await text('#subBanner'))));
  await setSub({ status: 'active', paid_until: '2020-01-01' });
  await page.reload(); await page.waitForSelector('#app:not([hidden])');
  assert.ok(await until(async () => /جدّد/.test(await text('#panel'))));
  assert.match(await text('#panel'), /test@instapay/);
  assert.match(await text('#panel'), /750/, '500 + 250 for the second branch');
  await page.goto(`${base}cashier.html`);
  await page.waitForSelector('#pos:not([hidden])');
  await setSub(null);
});

test('admin page: see each pharmacy and turn on a paid month', async () => {
  await page.goto(`${base}admin.html`);
  await page.waitForSelector('#app:not([hidden])');
  assert.match(await text('#list'), /صيدلية أحمد منصور/);
  await page.click('#list [data-edit]');
  await page.selectOption('#eStatus', 'active');
  await page.click('#eAdd [data-add="1"]');
  assert.match(await page.inputValue('#ePaid'), /^\d{4}-\d{2}-\d{2}$/);
  await page.fill('#eNote', 'دفع إنستاباي');
  await page.click('#editForm button[type=submit]');
  assert.ok(await until(async () => (await db('subscriptions'))[0]?.status === 'active'));
  assert.equal((await db('subscriptions'))[0].note, 'دفع إنستاباي');
  await page.evaluate(() => { window.__DB.subscriptions = []; localStorage.setItem('__stubdb', JSON.stringify(window.__DB)); });
});

test('public pages open', async () => {
  for (const f of ['about.html', 'privacy.html', 'terms.html']) {
    await page.goto(base + f);
    assert.match(await text('h1'), /صيدليتي|الخصوصية|الشروط|شروط/);
  }
});

test('no script errors', () => {
  assert.deepEqual(errors, []);
});
