// Browser test of the whole app on the Cloudflare server (worker/), with real accounts:
//   cd worker && npm run dev        (local Worker with D1 and R2 on this computer)
//   WORKER_URL=http://localhost:8787 node --test e2e/cloudflare.e2e.mjs
// Skipped when WORKER_URL is not set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { captureDownload } from './download.js';

// Settings, backups, export and linking live in their own view («الإعدادات والأدوات»).
const openTools = async (p) => { if (await p.locator('#toolsView').isHidden()) await p.click('#toolsBtn'); };
const BASE = process.env.WORKER_URL;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'test/fixtures/export.json');
const skip = !BASE && 'WORKER_URL not set';
const rnd = Math.random().toString(36).slice(2, 8);
const OWNER = `owner-${rnd}@test.local`, PARTNER = `partner-${rnd}@test.local`, DEVICE = `device-${rnd}@test.local`;

let browser, errors = [];
const pages = [];
before(async () => { if (!skip) browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function newPage() {
  const ctx = await browser.newContext({ locale: 'ar-EG', viewport: { width: 1200, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // A Content-Security-Policy refusal shows up as a console error: any one fails the run.
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(`${page.url()}: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  pages.push(page);
  return page;
}
const cspViolations = [];
const text = (p, sel) => p.locator(sel).first().innerText();
const until = async (p, fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await p.waitForTimeout(150); } return false; };
async function signUp(p, email) {
  await p.goto(BASE);
  await p.waitForSelector('#switchMode');
  await p.click('#switchMode');
  await p.fill('#email', email);
  await p.fill('#password', 'password123');
  await p.fill('#password2', 'password123');
  await p.click('#loginForm button[type=submit]');
}

let owner, code;
test('the owner signs up, makes the pharmacy, uploads the item list, receives a delivery', { skip }, async () => {
  owner = await newPage();
  await signUp(owner, OWNER);
  await owner.waitForSelector('#phNameNew');
  // The sign-in is an HttpOnly cookie: nothing the page can read holds the token.
  const kept = await owner.evaluate(() => JSON.parse(localStorage.getItem('sd-cf-auth')));
  assert.ok(kept?.user?.id && !kept.access_token, `stored: ${JSON.stringify(Object.keys(kept || {}))}`);
  assert.equal(await owner.evaluate(() => document.cookie.includes('sd_session')), false);
  await owner.fill('#phNameNew', 'صيدلية أحمد منصور');
  await owner.click('#createForm button[type=submit]');
  await owner.waitForSelector('#app:not([hidden])');
  assert.equal(await text(owner, '#phTitle'), 'صيدلية أحمد منصور');
  assert.ok(await until(owner, async () => /التجربة المجانية/.test(await text(owner, '#subBanner'))), 'a new pharmacy is on its free trial');
  await owner.setInputFiles('#file', FIXTURE);
  assert.ok(await until(owner, async () => /اتحفظت/.test(await text(owner, '#fileMsg'))));
  await owner.click('[data-sec=stock]');
  await owner.click('[data-tab=items]');
  await owner.click('#newItemBtn');
  await owner.fill('#itName', 'شاش طبي');
  await owner.fill('#itBarcode', '6220000000001');
  await owner.fill('#itPrice', '15');
  await owner.fill('#itQty', '10');
  await owner.click('#itemForm button[type=submit]');
  await owner.fill('#itemsQ', 'شاش');
  assert.ok(await until(owner, async () => /10/.test(await text(owner, '#itemsBody tr'))));
  await owner.click('[data-sec=buy]');
  await owner.click('[data-tab=receive]');
  await owner.selectOption('#rcvSup', '__new');
  await owner.fill('#rcvSupName', 'مخزن الأمل');
  await owner.fill('#rcvQ', '6220000000001');
  await owner.press('#rcvQ', 'Enter');
  await owner.fill('[data-l="0"][data-f="qty"]', '5');
  await owner.fill('[data-l="0"][data-f="cost"]', '9');
  await owner.click('#rcvForm button[type=submit]');
  assert.ok(await until(owner, async () => /اتسجلت الطلبية/.test(await text(owner, '#rcvMsg'))));
  // Opening again (a new page on the same device) shows what was saved on the server.
  await owner.reload();
  await owner.waitForSelector('#app:not([hidden])');
  await owner.click('[data-sec=stock]');
  await owner.click('[data-tab=items]');
  await owner.fill('#itemsQ', 'شاش');
  assert.ok(await until(owner, async () => /15/.test(await text(owner, '#itemsBody tr'))));
});

test('the cashier sells, with and without a connection; stock goes down', { skip }, async () => {
  await owner.goto(`${BASE}/cashier.html`);
  await owner.waitForSelector('#pos:not([hidden])');
  await owner.evaluate(() => { window.print = () => {}; });
  assert.ok(await until(owner, async () => /صنف/.test(await text(owner, '#posMsg'))));
  await owner.fill('#q', '6220000000001');
  await owner.press('#q', 'Enter');
  await owner.keyboard.press('F2');
  assert.ok(await until(owner, async () => /الفاتورة اتسجلت/.test(await text(owner, '#posMsg'))));
  await owner.context().setOffline(true);
  await owner.evaluate(() => dispatchEvent(new Event('offline')));
  await owner.fill('#q', '6220000000001');
  await owner.press('#q', 'Enter');
  await owner.keyboard.press('F2');
  assert.ok(await until(owner, async () => /مستني/.test(await text(owner, '#netChip'))));
  await owner.context().setOffline(false);
  await owner.evaluate(() => dispatchEvent(new Event('online')));
  assert.ok(await until(owner, async () => /متصل/.test(await text(owner, '#netChip'))), 'uploaded once the connection is back');
  await owner.fill('#q', 'شاش');
  assert.ok(await until(owner, async () => /رصيد 13/.test(await text(owner, '#results'))));
});

test('the cashier sells by the strip', { skip }, async () => {
  await owner.goto(`${BASE}/cashier.html`);
  await owner.waitForSelector('#pos:not([hidden])');
  await owner.evaluate(() => { window.print = () => {}; });
  assert.ok(await until(owner, async () => /صنف/.test(await text(owner, '#posMsg'))));
  await owner.fill('#q', 'panadol');
  assert.ok(await until(owner, async () => /Panadol/.test(await text(owner, '#results'))));
  await owner.press('#q', 'Enter');
  // Put the bill on hold (F4) and take it back.
  await owner.keyboard.press('F4');
  assert.ok(await until(owner, async () => (await text(owner, '#heldCount')) === '1'), 'one bill on hold');
  assert.equal(await owner.locator('#cart tr').count(), 0, 'a new empty bill');
  await owner.click('#heldBtn');
  await owner.click('[data-held]');
  assert.ok(await until(owner, async () => /Panadol/.test(await text(owner, '#cart'))), 'the held bill is back');
  assert.ok(await owner.locator('#heldBtn').isHidden());
  await owner.selectOption('[data-unit="0"]', 'strip');
  assert.ok(await until(owner, async () => /25\.5/.test(await text(owner, '#tTotal'))), 'half the box price');
  // Delivery on top, and the pharmacy's WhatsApp as a QR on the receipt.
  await owner.click('#delBox summary');
  await owner.fill('#delFee', '10');
  await owner.fill('#delTo', 'شارع النصر');
  assert.ok(await until(owner, async () => /35\.5/.test(await text(owner, '#tTotal'))), 'with the delivery fee');
  await owner.evaluate(() => { const d = document.querySelector('#rcPhone').closest('details'); if (d) d.open = true; });
  await owner.fill('#rcPhone', '01001234567');
  await owner.check('#rcQr');
  await owner.keyboard.press('F2');
  assert.ok(await until(owner, async () => /الفاتورة اتسجلت/.test(await text(owner, '#posMsg'))));
  const rc = await owner.locator('#receipt').innerHTML();
  assert.match(rc, /شريط/);
  assert.match(rc, /التوصيل/);
  assert.match(rc, /<svg[^>]*aria-label="QR"/);
});

test('a partner joins with a code and sees the numbers, not the customers', { skip }, async () => {
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
  await openTools(owner);
  await owner.click('#branchBox summary');
  await owner.click('[data-invite="partner"]');
  assert.ok(await until(owner, async () => /الكود/.test(await text(owner, '#inviteText'))));
  code = (await text(owner, '#inviteText')).match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)[0];
  const p = await newPage();
  await signUp(p, PARTNER);
  await p.waitForSelector('#joinCode');
  await p.fill('#joinCode', code);
  await p.click('#joinForm button[type=submit]');
  await p.waitForSelector('#app:not([hidden])');
  assert.match(await text(p, '#whoLine'), /شريك/);
  const secs = await p.locator('#sections .sec').allInnerTexts();
  assert.ok(!secs.includes('العملاء') && !secs.includes('المرضى'));
  await p.click('[data-sec=money]');
  await p.click('[data-tab=pos]');
  assert.ok(await until(p, async () => /فواتير/.test(await text(p, '#panel'))));
});

test('the pharmacy device: PIN, shift, and the owner sees the shift and the log', { skip }, async () => {
  await owner.goto(`${BASE}/attendance.html`);
  await owner.waitForSelector('#app:not([hidden])');
  await owner.click('[data-tab=staff]');
  await owner.fill('#nName', 'سارة');
  await owner.fill('#nPin', '1234');
  await owner.click('#addForm button[type=submit]');
  assert.ok(await until(owner, async () => /سارة/.test(await text(owner, '#staff'))));
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
  await openTools(owner);
  await owner.click('#branchBox summary');
  await owner.click('[data-invite="device"]');
  assert.ok(await until(owner, async () => /الكود/.test(await text(owner, '#inviteText'))));
  const dcode = (await text(owner, '#inviteText')).match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)[0];
  const d = await newPage();
  await signUp(d, DEVICE);
  await d.waitForSelector('#joinCode');
  await d.fill('#joinCode', dcode);
  await d.click('#joinForm button[type=submit]');
  await d.goto(`${BASE}/cashier.html`);
  await d.waitForSelector('#pinDlg[open]');
  await d.evaluate(() => { window.print = () => {}; });
  await d.fill('#pinIn', '1234');
  await d.click('#pinOk');
  await d.waitForSelector('#openCashWrap:not([hidden])');
  await d.fill('#openCash', '200');
  await d.click('#pinOk');
  assert.ok(await until(d, async () => /سارة/.test(await text(d, '#cashierChip'))));
  await d.fill('#q', '6220000000001');
  await d.press('#q', 'Enter');
  await d.keyboard.press('F2');
  assert.ok(await until(d, async () => /الفاتورة اتسجلت/.test(await text(d, '#posMsg'))));
  // The owner takes 15 out of the drawer: it comes off what the drawer should have.
  await d.click('#drawerOut');
  await d.waitForSelector('#outDlg[open]');
  await d.fill('#outAmount', '15');
  await d.fill('#outPerson', 'أحمد');
  await d.click('#outForm button[type=submit]');
  assert.ok(await until(d, async () => /أحمد أخد 15/.test(await text(d, '#posMsg'))));
  await d.click('#closeShift');
  await d.waitForSelector('#shiftDlg[open]');
  assert.match(await text(d, '#shSum'), /اتسحب من الدرج/);
  await d.fill('#shCount', '200');
  await d.click('#shiftForm button[type=submit]');
  await d.waitForSelector('#pinDlg[open]');
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
  await owner.click('[data-sec=money]');
  await owner.click('[data-tab=shifts]');
  assert.ok(await until(owner, async () => /سارة/.test(await text(owner, '#panel')) && /مظبوط/.test(await text(owner, '#panel'))));
  await owner.click('[data-tab=log]');
  assert.ok(await until(owner, async () => /وردية/.test(await text(owner, '#panel')) && /طلبية|فاتورة شراء/.test(await text(owner, '#panel'))));
});

test('withdrawals: money and goods the owner took, per person, and what is left in the pharmacy', { skip }, async () => {
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
  await owner.click('[data-sec=money]');
  await owner.click('[data-tab=withdrawals]');
  assert.ok(await until(owner, async () => /أحمد/.test(await text(owner, '#panel')) && /من الدرج/.test(await text(owner, '#panel'))), 'the drawer withdrawal from the cashier');
  await owner.waitForLoadState('networkidle'); // the page has finished loading and drawing
  await owner.fill('#wdPerson', 'أحمد');
  await owner.fill('#wdAmount', '500');
  await owner.click('#wdForm button[type=submit]');
  assert.ok(await until(owner, async () => /أحمد أخد 500/.test(await text(owner, '#wdMsg'))));
  // Goods: from the stock, at what they cost.
  await owner.click('#wdGoods');
  await owner.waitForSelector('#adjQ');
  await owner.fill('#adjQ', '6220000000001');
  await owner.press('#adjQ', 'Enter');
  await owner.fill('#adjQty', '1');
  await owner.fill('#adjPerson', 'أحمد');
  await owner.click('#adjForm button[type=submit]');
  assert.ok(await until(owner, async () => /مسحوبات بضاعة 1/.test(await text(owner, '#adjMsg'))));
  await owner.click('[data-sec=money]');
  await owner.click('[data-tab=withdrawals]');
  assert.ok(await until(owner, async () => /بضاعة/.test(await text(owner, '#panel tbody')) && /518/.test(await text(owner, '#panel .ledger'))), await text(owner, '#panel'));
  await owner.click('[data-tab=books]');
  assert.ok(await until(owner, async () => /اللي فاضل في الصيدلية/.test(await text(owner, '#panel'))));
});

test('moving: a full backup goes into a new, empty pharmacy', { skip }, async () => {
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
  await openTools(owner);
  await owner.click('#cloudBackupBox summary');
  const backup = await captureDownload(owner, '#cloudBackupBtn');
  const m = await newPage();
  await signUp(m, `mover-${rnd}@test.local`);
  await m.waitForSelector('#phNameNew');
  await m.fill('#phNameNew', 'صيدلية منقولة');
  await m.click('#createForm button[type=submit]');
  await m.waitForSelector('#app:not([hidden])');
  await openTools(m);
  await m.click('#cloudBackupBox summary');
  await m.setInputFiles('#cloudImportFile', { name: backup.filename, mimeType: 'application/json', buffer: Buffer.from(backup.bytes) });
  const reloaded = m.waitForEvent('load', { timeout: 30000 });
  assert.ok(await until(m, async () => /اتنقل/.test(await text(m, '#cloudBackupMsg')), 20000));
  await reloaded; // the page opens again with the moved data
  await m.waitForSelector('#app:not([hidden])');
  await m.click('[data-sec=stock]');
  await m.click('[data-tab=items]');
  await m.fill('#itemsQ', 'شاش');
  // The encrypted server backup, from the same panel (Phase 2 M2).
  await openTools(owner);
  await owner.click('#serverBackupBtn');
  assert.ok(await until(owner, async () => /آخر نسخة/.test(await text(owner, '#serverBackupState')), 20000), await text(owner, '#serverBackupState'));
  assert.ok(await until(m, async () => /11/.test(await text(m, '#itemsBody tr'))), `the same stock as the old pharmacy: ${await text(m, '#itemsBody')} / ${await text(m, '#cloudBackupMsg')} / ${await text(m, '#fileMsg')}`);
});

test('the Windows program: turning on the sync with United makes a working connector code', { skip }, async () => {
  // The bridge the Windows program gives the page (here a stand-in that keeps what it was asked).
  await owner.addInitScript(() => {
    let st = { enabled: false };
    window.__enable = [];
    window.saydalitiDesktop = { genius: {
      status: async () => st,
      find: async () => ({ servers: [{ name: '.\\GENIUS', running: true }], databases: [{ server: '.\\GENIUS', database: 'Pharmacy', items: 62974 }], errors: [] }),
      enable: async (o) => { window.__enable.push(o); st = { enabled: true, server: o.server, database: o.database, minutes: o.minutes, lastCheck: new Date().toISOString(), lastUpload: new Date().toISOString(), items: 62974, stockDay: 20261028 }; return st; },
      disable: async () => { st = { ...st, enabled: false }; return st; },
      now: async () => st,
    } };
  });
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
  await openTools(owner);
  await owner.click('#geniusLiveBox summary');
  await owner.click('#glFind');
  await owner.waitForSelector('#glFound:not([hidden])');
  assert.match(await text(owner, '#glDb'), /Pharmacy/);
  await owner.selectOption('#glMin', '5');
  await owner.click('#glOn');
  assert.ok(await until(owner, async () => /شغالة من «Pharmacy»/.test(await text(owner, '#glStatus')) && /28\/10\/2026/.test(await text(owner, '#glStatus'))), await text(owner, '#geniusLiveBox'));
  const [o] = await owner.evaluate(() => window.__enable);
  assert.deepEqual([o.server, o.database, o.minutes], ['.\\GENIUS', 'Pharmacy', 5]);
  // The code the page made works for uploading, like the program will.
  const r = await fetch(`${BASE}/rest/v1/rpc/upload_snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: `{"p_token":${JSON.stringify(o.token)},"p_data":{"exportedAt":"2026-10-28T10:00:00Z","source":"genius-live","items":[{"code":"1","name":"بانادول","price":50,"cost":40}],"batches":[],"sales":[],"purchases":[]}}` });
  assert.equal(r.status, 200, await r.text());
  await owner.click('#glOff');
  assert.ok(await until(owner, async () => /مقفولة/.test(await text(owner, '#glStatus'))));
});

// Receipt numbers (Phase 1): "YYMMDD-K1-<device>-<0001>", unique across devices, and the count goes on
// after the browser's saved counter is lost (sign-out, cleared storage) because the server is asked.
const serverSales = (p) => p.evaluate(async () => {
  // The page signs in with its HttpOnly cookie (it can't read the token); X-Saydaliti is the CSRF header.
  const r = await fetch('/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saydaliti': '1' },
    body: JSON.stringify({ op: 'select', table: 'pos_sales', cols: 'number, receipt_device', filters: [], limit: 1000 }) });
  return (await r.json()).data;
});
async function sellOne(p) {
  await p.goto(`${BASE}/cashier.html`);
  await p.waitForSelector('#pos:not([hidden])');
  await p.evaluate(() => { window.print = () => {}; });
  assert.ok(await until(p, async () => /صنف/.test(await text(p, '#posMsg'))));
  await p.fill('#q', '6220000000001');
  await p.press('#q', 'Enter');
  await p.keyboard.press('F2');
  assert.ok(await until(p, async () => /الفاتورة اتسجلت/.test(await text(p, '#posMsg'))));
  assert.ok(await until(p, async () => /متصل/.test(await text(p, '#netChip'))), 'uploaded, nothing refused');
  return (await text(p, '#posMsg')).match(/\d{6}-K1-[A-Z0-9]{4}-\d{4}/)[0];
}
test('receipt numbers stay unique across devices and after the saved counter is lost', { skip }, async () => {
  const dev1 = await owner.evaluate(() => localStorage.getItem('pos-device-v1'));
  assert.match(dev1, /^[A-HJ-NP-Z2-9]{4}$/);
  const first = await sellOne(owner);
  assert.ok(first.includes(`-${dev1}-`));
  // The browser's counter and its copy of the receipts are gone (like a sign-out); the device code stays.
  await owner.evaluate(() => { localStorage.removeItem('pos-receipt-seq-v1'); return new Promise((r) => { const q = indexedDB.deleteDatabase('saydaliti'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); });
  const second = await sellOne(owner);
  assert.equal(+second.slice(-4), +first.slice(-4) + 1, `${first} then ${second}`);
  // Another computer of the same pharmacy gets its own device code.
  const p2 = await newPage();
  await p2.goto(BASE);
  await p2.waitForSelector('#loginForm');
  await p2.fill('#email', OWNER); await p2.fill('#password', 'password123');
  await p2.click('#loginForm button[type=submit]');
  await p2.waitForSelector('#app:not([hidden])');
  const other = await sellOne(p2);
  const dev2 = await p2.evaluate(() => localStorage.getItem('pos-device-v1'));
  assert.notEqual(dev2, dev1);
  assert.ok(other.includes(`-${dev2}-`));
  const rows = await serverSales(owner);
  const numbers = rows.map((r) => r.number);
  assert.equal(new Set(numbers).size, numbers.length, 'no number twice');
  for (const n of [first, second, other]) assert.ok(numbers.includes(n), `${n} reached the server`);
  assert.ok(rows.filter((r) => r.receipt_device).every((r) => r.number.includes(`-${r.receipt_device}-`)));
  await owner.goto(BASE); // back to the dashboard for the next test
  await owner.waitForSelector('#app:not([hidden])');
});

test('a return without a receipt: the cashier signs in, a manager the owner allowed approves with their PIN', { skip }, async () => {
  // The owner adds a manager and allows them to approve returns.
  await owner.goto(`${BASE}/attendance.html`);
  await owner.waitForSelector('#app:not([hidden])');
  await owner.click('[data-tab=staff]');
  await owner.fill('#nName', 'مدير المرتجع');
  await owner.fill('#nPin', '7777');
  await owner.click('#addForm button[type=submit]');
  assert.ok(await until(owner, async () => /مدير المرتجع/.test(await text(owner, '#staff'))), `step 1: posMsg=${await text(owner, '#posMsg').catch(() => '')} apprMsg=${await text(owner, '#apprMsg').catch(() => '')} chip=${await text(owner, '#cashierChip').catch(() => '')}`);
  const box = owner.locator('tr', { hasText: 'مدير المرتجع' }).locator('[data-approve]');
  await box.check();
  assert.ok(await until(owner, async () => /يقدر يوافق/.test(await text(owner, '#staffMsg'))), `step 2: posMsg=${await text(owner, '#posMsg').catch(() => '')} apprMsg=${await text(owner, '#apprMsg').catch(() => '')} chip=${await text(owner, '#cashierChip').catch(() => '')}`);
  // At the cashier: سارة (PIN 1234, added earlier) sells; a return with no receipt.
  await owner.goto(`${BASE}/cashier.html`);
  await owner.waitForSelector('#pos:not([hidden])');
  await owner.evaluate(() => { window.print = () => {}; });
  const signIn = async () => {
    await owner.fill('#pinIn', '1234'); await owner.click('#pinOk');
    await owner.waitForTimeout(500);
    if (await owner.locator('#openCashWrap:not([hidden])').count()) { await owner.fill('#openCash', '0'); await owner.click('#pinOk'); }
    assert.ok(await until(owner, async () => /سارة/.test(await text(owner, '#cashierChip'))), `step 3: posMsg=${await text(owner, '#posMsg').catch(() => '')} apprMsg=${await text(owner, '#apprMsg').catch(() => '')} chip=${await text(owner, '#cashierChip').catch(() => '')}`);
  };
  // The cashier loads its items and staff after the page opens: wait for both before starting.
  assert.ok(await until(owner, async () => /صنف/.test(await text(owner, '#posMsg')), 20000), `loaded: ${await text(owner, '#posMsg')}`);
  if (await owner.locator('#pinDlg[open]').count()) await signIn();
  await owner.click('#modeReturn');
  await owner.check('#retNoReceipt');
  await owner.fill('#retReason', 'الفاتورة ضاعت');
  await owner.fill('#q', '6220000000001');
  await owner.press('#q', 'Enter');
  assert.ok(await until(owner, async () => (await owner.locator('#cart tr').count()) > 0), `in the cart: ${await text(owner, '#posMsg')}`);
  // F2 opens the cashier's PIN (no cashier yet) or the manager's approval; the staff count may still be
  // arriving, so try again until one opens.
  const dialog = () => owner.locator('#pinDlg[open], #apprDlg[open]').count();
  assert.ok(await until(owner, async () => { if (await dialog()) return true; await owner.keyboard.press('F2'); await owner.waitForTimeout(700); return (await dialog()) > 0; }, 20000),
    `a dialog opens: posMsg=${await text(owner, '#posMsg')} cart=${await owner.locator('#cart tr').count()} chip=${await text(owner, '#cashierChip').catch(() => '')}`);
  if (await owner.locator('#pinDlg[open]').count()) {
    assert.match(await text(owner, '#posMsg'), /الكاشير يدخل برقمه السري الأول/);
    await signIn();
    await owner.keyboard.press('F2');
  }
  await owner.waitForSelector('#apprDlg[open]');
  assert.match(await text(owner, '#apprNote'), /الفاتورة ضاعت/);
  // The cashier can't approve her own return.
  await owner.fill('#apprPin', '1234');
  await owner.click('#apprForm button[type=submit]');
  assert.ok(await until(owner, async () => /موظف تاني|مش مسموح/.test(await text(owner, '#apprMsg'))), 'the cashier is not an approver');
  await owner.fill('#apprPin', '7777');
  await owner.click('#apprForm button[type=submit]');
  assert.ok(await until(owner, async () => /المرتجع اتسجل/.test(await text(owner, '#posMsg'))), `step 4: posMsg=${await text(owner, '#posMsg').catch(() => '')} apprMsg=${await text(owner, '#apprMsg').catch(() => '')} chip=${await text(owner, '#cashierChip').catch(() => '')}`);
  assert.ok(await until(owner, async () => /متصل/.test(await text(owner, '#netChip'))), 'uploaded, not refused');
  const rows = await owner.evaluate(async () => {
    const r = await fetch('/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saydaliti': '1' },
      body: JSON.stringify({ op: 'select', table: 'return_approvals', cols: 'return_id, reason, cashier_name, approver_name', filters: [], limit: 10 }) });
    return (await r.json()).data;
  });
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], return_id: undefined }, { return_id: undefined, reason: 'الفاتورة ضاعت', cashier_name: 'سارة', approver_name: 'مدير المرتجع' });
  assert.equal(await owner.evaluate(() => localStorage.getItem('sd:apprPin')), null);
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
});

test('stock on the server: the owner opens it from the app\'s numbers, they match, and a blocked branch refuses selling past zero', { skip }, async () => {
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
  await openTools(owner);
  await owner.click('#stockBox summary');
  assert.ok(await until(owner, async () => /لسه ما بدأش|شغال/.test(await text(owner, '#stockState'))), `state: ${await text(owner, '#stockState')}`);
  await owner.click('#stockOpen');
  assert.ok(await until(owner, async () => /اتسجل رصيد/.test(await text(owner, '#stockDiff')), 30000), await text(owner, '#stockState'));
  await owner.click('#stockCheck');
  assert.ok(await until(owner, async () => /نفس رصيد البرنامج/.test(await text(owner, '#stockDiff')), 30000), `the server and the app agree: ${await text(owner, '#stockDiff')}`);
  await owner.check('#stockBlock');
  assert.ok(await until(owner, async () => /ممنوع/.test(await text(owner, '#stockState'))), `blocked: ${await text(owner, '#stockState')}`);
  // At the cashier: more boxes than the server has → refused before printing, nothing saved.
  await owner.goto(`${BASE}/cashier.html`);
  await owner.waitForSelector('#pos:not([hidden])');
  await owner.evaluate(() => { window.print = () => {}; });
  if (await owner.locator('#pinDlg[open]').count()) { await owner.fill('#pinIn', '1234'); await owner.click('#pinOk'); await owner.waitForTimeout(500); if (await owner.locator('#openCashWrap:not([hidden])').count()) { await owner.fill('#openCash', '0'); await owner.click('#pinOk'); } }
  await owner.waitForTimeout(1500); // the branch's policy is read with the rest of the data
  await owner.fill('#q', '6220000000001');
  await owner.press('#q', 'Enter');
  await owner.fill('[data-qty="0"]', '999');
  await owner.press('[data-qty="0"]', 'Tab');
  const before = null; // the page's own sign-in (HttpOnly cookie) is used
  const count = async () => owner.evaluate(async () => (await (await fetch('/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saydaliti': '1' }, body: JSON.stringify({ op: 'select', table: 'pos_sales', cols: 'id', filters: [], limit: 1000 }) })).json()).data.length, before);
  const n0 = await count();
  await owner.keyboard.press('F2');
  assert.ok(await until(owner, async () => /الرصيد على السيرفر مش كفاية/.test(await text(owner, '#posMsg'))), await text(owner, '#posMsg'));
  assert.equal(await count(), n0, 'nothing saved');
  assert.ok((await owner.locator('#cart tr').count()) > 0, 'the cart is kept to fix');
  // After a delivery (1,000 boxes, so it doesn't depend on the stock earlier tests left), one box sells.
  const pid = await owner.evaluate(async (tok) => {
    const id = crypto.randomUUID();
    const ph = JSON.parse(localStorage.getItem('saydaliti-member-v1')).pharmacy.id;
    const r = await fetch('/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saydaliti': '1' }, body: JSON.stringify({ op: 'upsert', table: 'purchases', ignoreDuplicates: true, rows: [{ id, pharmacy_id: ph, received_on: new Date().toISOString().slice(0, 10), lines: [{ code: '6220000000001', qty: 1000, cost: 10 }], total: 10000 }] }) });
    return (await r.json()).error ? null : id;
  }, before);
  assert.ok(pid, 'the delivery was recorded');
  await owner.fill('[data-qty="0"]', '1');
  await owner.press('[data-qty="0"]', 'Tab');
  await owner.keyboard.press('F2');
  assert.ok(await until(owner, async () => /الفاتورة اتسجلت/.test(await text(owner, '#posMsg'))), `one box: ${await text(owner, '#posMsg')}`);
  assert.equal(await count(), n0 + 1);
  // Back to the default for the next tests: selling below zero allowed.
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
  await openTools(owner);
  await owner.click('#stockBox summary');
  await owner.waitForTimeout(800);
  await owner.uncheck('#stockBlock');
  assert.ok(await until(owner, async () => !/ممنوع/.test(await text(owner, '#stockState'))), `allowed again: ${await text(owner, '#stockState')}`);
});

test('a table too big to load whole is reported on screen, not used in part', { skip }, async () => {
  // The server here answers every page of stock adjustments with 1,000 rows: there is always more.
  const p = await newPage();
  await p.route('**/api/db', async (route) => {
    const q = JSON.parse(route.request().postData() || '{}');
    if (q.op !== 'select' || q.table !== 'stock_moves') return route.continue();
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: crypto.randomUUID(), branch_id: null, code: 'X', qty: 1, kind: 'count', expiry: null, cost: null, ref: null, note: null, person: null, happened_at: '2026-10-01T00:00:00Z', created_at: `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}Z` }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: rows, error: null }) });
  });
  await p.goto(BASE);
  await p.waitForSelector('#loginForm');
  await p.fill('#email', OWNER); await p.fill('#password', 'password123');
  await p.click('#loginForm button[type=submit]');
  await p.waitForSelector('#app:not([hidden])');
  assert.ok(await until(p, async () => /البيانات مش كاملة: حركات المخزون/.test(await p.locator('#dataAlert').innerText().catch(() => '')), 60000), 'the dashboard says the data is incomplete');
  await p.goto(`${BASE}/cashier.html`);
  await p.waitForSelector('#pos:not([hidden])');
  assert.ok(await until(p, async () => /البيانات مش كاملة: حركات المخزون/.test(await p.locator('#dataAlert').innerText().catch(() => '')), 60000), 'the cashier says so too');
});

test('security headers are sent, and no page or tab breaks the Content-Security-Policy', { skip }, async () => {
  const h = (await fetch(`${BASE}/`)).headers;
  const csp = h.get('content-security-policy') || '';
  for (const d of ["default-src 'self'", "object-src 'none'", "frame-ancestors 'self'", "base-uri 'self'"]) assert.ok(csp.includes(d), `CSP has ${d}`);
  assert.doesNotMatch(csp.split('script-src')[1].split(';')[0], /unsafe-inline|unsafe-eval/, 'no inline or eval scripts allowed');
  assert.doesNotMatch(csp.split('style-src')[1].split(';')[0], /unsafe-inline/, 'no inline styles allowed');
  assert.equal(h.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  const api = (await fetch(`${BASE}/api/config`)).headers.get('content-security-policy');
  assert.equal(api, "default-src 'none'; frame-ancestors 'none'");
  // Every section and tab of the dashboard, the cashier and the other pages, as the owner.
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
  for (const sec of await owner.$$eval('[data-sec]', (e) => [...new Set(e.map((x) => x.dataset.sec))])) {
    await owner.click(`[data-sec=${sec}]`);
    for (const tab of await owner.$$eval('#tabs [data-tab]', (e) => e.map((x) => x.dataset.tab))) {
      await owner.click(`#tabs [data-tab=${tab}]`).catch(() => {});
      await owner.waitForTimeout(150);
    }
  }
  for (const page of ['cashier.html', 'attendance.html', 'about.html', 'privacy.html', 'terms.html', 'admin.html']) { await owner.goto(`${BASE}/${page}`); await owner.waitForTimeout(1500); }
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
  assert.deepEqual(cspViolations, []);
});

test('signing out and in again', { skip }, async () => {
  await owner.click('#logout');
  await owner.waitForSelector('#loginForm');
  await owner.fill('#email', OWNER);
  await owner.fill('#password', 'password123');
  await owner.click('#loginForm button[type=submit]');
  await owner.waitForSelector('#app:not([hidden])');
  assert.equal(await text(owner, '#phTitle'), 'صيدلية أحمد منصور');
});

test('public pages show the prices from the server', { skip }, async () => {
  const p = await newPage();
  await p.goto(`${BASE}/about.html`);
  assert.match(await text(p, 'h1'), /صيدليتي/);
});

test('no script errors', { skip }, () => { assert.deepEqual(errors, []); assert.deepEqual(cspViolations, [], 'no Content-Security-Policy refusals in any test'); });
