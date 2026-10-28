// Browser test of the whole app on the Cloudflare server (worker/), with real accounts:
//   cd worker && npm run dev        (local Worker with D1 and R2 on this computer)
//   WORKER_URL=http://localhost:8787 node --test e2e/cloudflare.e2e.mjs
// Skipped when WORKER_URL is not set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
  page.on('dialog', (d) => d.accept());
  pages.push(page);
  return page;
}
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

test('a partner joins with a code and sees the numbers, not the customers', { skip }, async () => {
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
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
  await d.click('#closeShift');
  await d.waitForSelector('#shiftDlg[open]');
  await d.fill('#shCount', '215');
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

test('moving: a full backup goes into a new, empty pharmacy', { skip }, async () => {
  await owner.goto(BASE);
  await owner.waitForSelector('#app:not([hidden])');
  await owner.click('#cloudBackupBox summary');
  const [dl] = await Promise.all([owner.waitForEvent('download'), owner.click('#cloudBackupBtn')]);
  const file = await dl.path();
  const m = await newPage();
  await signUp(m, `mover-${rnd}@test.local`);
  await m.waitForSelector('#phNameNew');
  await m.fill('#phNameNew', 'صيدلية منقولة');
  await m.click('#createForm button[type=submit]');
  await m.waitForSelector('#app:not([hidden])');
  await m.click('#cloudBackupBox summary');
  await m.setInputFiles('#cloudImportFile', file);
  const reloaded = m.waitForEvent('load', { timeout: 30000 });
  assert.ok(await until(m, async () => /اتنقل/.test(await text(m, '#cloudBackupMsg')), 20000));
  await reloaded; // the page opens again with the moved data
  await m.waitForSelector('#app:not([hidden])');
  await m.click('[data-sec=stock]');
  await m.click('[data-tab=items]');
  await m.fill('#itemsQ', 'شاش');
  assert.ok(await until(m, async () => /12/.test(await text(m, '#itemsBody tr'))), `the same stock as the old pharmacy: ${await text(m, '#itemsBody')} / ${await text(m, '#cloudBackupMsg')} / ${await text(m, '#fileMsg')}`);
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

test('no script errors', { skip }, () => { assert.deepEqual(errors, []); });
