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
  ctx = await browser.newContext({ locale: 'ar-EG', viewport: { width: 1200, height: 900 } });
  await ctx.route('**/api/config', (r) => r.fulfill({ json: { configured: true, url: 'https://stub.supabase.test', key: 'pk_test' } }));
  await ctx.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: stub }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/, (r) => r.abort());
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
});
after(async () => { await browser?.close(); server?.close(); });

const text = (sel, p = page) => p.locator(sel).first().innerText();
const db = (k) => page.evaluate((k) => window.__DB?.[k] ?? [], k);
const goOffline = async () => { await ctx.setOffline(true); await page.evaluate(() => dispatchEvent(new Event('offline'))); };
const goOnline = async () => { await ctx.setOffline(false); await page.evaluate(() => dispatchEvent(new Event('online'))); };
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

test('dashboard opens with no example data, grouped in four sections', async () => {
  assert.equal(await text('#phTitle'), 'صيدلية أحمد منصور');
  assert.deepEqual(await page.locator('#sections .sec').allInnerTexts(), ['المخزون', 'الفلوس', 'البيع', 'المرضى']);
  assert.match(await text('#panel'), /لسه مفيش بيانات/);
  await page.click('[data-sec=money]');
  assert.deepEqual(await page.locator('#tabs .tab').allInnerTexts(), ['المصروفات', 'الحسابات', 'الشركاء', 'حاسبة المكسب']);
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
  await page.selectOption('#expKind', 'withdrawal');
  await page.fill('#expAmount', '3000');
  await page.click('#expForm button[type=submit]');
  assert.ok(await until(async () => /مستني يترفع/.test(await text('#netChip'))), 'status shows the queued change');
  assert.equal((await db('expenses')).length, 1);
  await goOnline();
  assert.ok(await until(async () => (await db('expenses')).length === 2));
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
  await page.click('#branchBox summary');
  await page.click('[data-invite=partner]');
  assert.ok(await until(async () => !(await page.locator('#inviteOut').isHidden())));
  assert.match(await text('#inviteText'), /CODE1/);
  assert.equal((await db('invites'))[0].role, 'partner');
});

test('opens offline with saved data even after the sign-in expired', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(800); // let the app files finish caching
  await page.addInitScript(() => { window.__sessionExpired = true; });
  await goOffline();
  await page.reload();
  await page.waitForSelector('#app:not([hidden])', { timeout: 8000 });
  assert.match(await text('#netChip'), /من غير نت/);
  assert.match(await text('#tiles'), /3 صنف/);
  await page.click('[data-sec=stock]');
  await page.click('[data-tab=reorder]');
  assert.match(await text('.orders .card b'), /مخزن الأمل/, 'suppliers available offline');
  await goOnline();
});

test('phone size: no sideways scrolling in any section', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const tabs = ['reorder', 'expiry', 'dead', 'shortages', 'movers', 'morning', 'expenses', 'books', 'partners', 'calc', 'offers', 'prices', 'changes', 'patients'];
  for (const tab of tabs) {
    const sec = await page.evaluate((t) => ({ reorder: 'stock', expiry: 'stock', dead: 'stock', shortages: 'stock', movers: 'stock', morning: 'stock', expenses: 'money', books: 'money', partners: 'money', calc: 'money', offers: 'sell', prices: 'sell', changes: 'sell', patients: 'patients' })[t], tab);
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

test('no script errors', () => {
  assert.deepEqual(errors, []);
});
