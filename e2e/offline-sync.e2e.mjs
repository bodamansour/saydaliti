// Offline receipts at the cashier, in a branch that blocks selling below zero (owner decision for the
// pilot), against a running Worker (local or staging): WORKER_URL=… node --test e2e/offline-sync.e2e.mjs
// Synthetic data only. Every receipt has an explicit state on screen — confirmed by the server, waiting
// on this device, or refused by the server with the reason — and none is ever dropped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.WORKER_URL;
const skip = !BASE && 'WORKER_URL not set';
const rnd = () => Math.random().toString(36).slice(2, 10);
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

async function api(token, path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, ...(await r.json()) };
}
async function account() {
  const email = `o-${rnd()}@test.local`;
  const r = await api(null, '/api/auth/signup', { email, password: 'password123' });
  return { email, session: r.data, token: r.data.access_token };
}

let browser, owner, other, P, B, ctx;
const errors = [];
after(async () => { await browser?.close(); });

const text = (p, sel) => p.locator(sel).first().innerText().catch(() => '');
const until = async (p, fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await p.waitForTimeout(150); } return false; };
const serverSales = async () => (await api(owner.token, '/api/db', { op: 'select', table: 'pos_sales', cols: 'id, number', filters: [['pharmacy_id', 'eq', P]], limit: 1000 })).data;
const level = async () => (await api(owner.token, '/api/db', { op: 'select', table: 'stock_levels', cols: 'qty', filters: [['pharmacy_id', 'eq', P], ['branch_id', 'eq', B], ['code', 'eq', 'G1']] })).data[0]?.qty ?? 0;
async function cashierPage() {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto(`${BASE}/cashier.html`);
  await p.waitForSelector('#pos:not([hidden])');
  await p.evaluate(() => { window.print = () => {}; });
  assert.ok(await until(p, async () => /صنف/.test(await text(p, '#posMsg'))), await text(p, '#posMsg'));
  await p.waitForTimeout(800); // the branch's stock policy arrives with the rest of the data
  return p;
}
async function sell(p) {
  await p.fill('#q', 'G1');
  await p.press('#q', 'Enter');
  assert.ok(await until(p, async () => (await p.locator('#cart tr').count()) > 0), 'in the cart');
  await p.keyboard.press('F2');
  assert.ok(await until(p, async () => /الفاتورة اتسجلت/.test(await text(p, '#posMsg'))), await text(p, '#posMsg'));
  return text(p, '#posMsg');
}
const offline = async (p, off) => { await ctx.setOffline(off); await p.evaluate((o) => dispatchEvent(new Event(o ? 'offline' : 'online')), off); };

test('setup: a pharmacy with one item (1 box), stock opened on the server, selling below zero blocked', { skip }, async () => {
  owner = await account(); other = await account();
  P = (await api(owner.token, '/api/rpc/create_pharmacy', { p_name: 'صيدلية تجربة المزامنة' })).data;
  B = (await api(owner.token, '/api/db', { op: 'select', table: 'branches', cols: 'id', filters: [['pharmacy_id', 'eq', P]] })).data[0].id;
  const file = { exportedAt: now(), items: [{ code: 'G1', name: 'شاش طبي', category: null, cost: 5, price: 10, owner: null, qty: null, expiry: null }], batches: [{ code: 'G1', qty: 1, expiry: '2028-01-31' }], sales: [] };
  const up = await fetch(`${BASE}/api/snapshot?pharmacy=${P}&branch=${B}&items=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` }, body: JSON.stringify(file) });
  assert.equal(up.status, 200);
  const st = (await api(owner.token, '/api/rpc/stock_status', { p_pharmacy: P, p_branch: B })).data;
  assert.equal((await api(owner.token, '/api/rpc/open_stock', { p_pharmacy: P, p_branch: B, p_base_at: st.server_now, p_watermark: st.server_now, p_items: [{ code: 'G1', qty: 1 }] })).error, null);
  assert.equal((await api(owner.token, '/api/rpc/set_stock_policy', { p_pharmacy: P, p_branch: B, p_block_negative: true })).error, null);
  const code = (await api(owner.token, '/api/rpc/create_invite', { p_pharmacy: P, p_role: 'device', p_branch_ids: [B] })).data;
  assert.equal((await api(other.token, '/api/rpc/join_pharmacy', { p_code: code })).data, P);
  browser = await chromium.launch();
  ctx = await browser.newContext({ locale: 'ar-EG', viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.addInitScript((s) => { if (!localStorage.getItem('sd-cf-auth')) localStorage.setItem('sd-cf-auth', JSON.stringify(s)); }, owner.session);
});

test('a sale made offline says it is only on this device; a competing online sale takes the last box; on reconnect it is shown as refused, with the reason, and kept', { skip }, async () => {
  const p = await cashierPage();
  await offline(p, true);
  const said = await sell(p);
  assert.match(said, /محفوظة على الجهاز/, 'says where it is');
  assert.match(said, /ممكن يرفضها/, 'says it may still be refused');
  assert.doesNotMatch(said, /السيرفر أكّدها/, 'never claims the server confirmed it');
  // Another device sells the last box while this one is offline.
  const competing = { id: uuid(), pharmacy_id: P, branch_id: B, number: `X-${rnd()}`, sold_at: now(), kind: 'sale', lines: [{ code: 'G1', qty: 1, price: 10 }], total: 10, paid: 10 };
  assert.equal((await api(other.token, '/api/db', { op: 'upsert', table: 'pos_sales', rows: competing, ignoreDuplicates: true })).error, null);
  await offline(p, false);
  assert.ok(await until(p, async () => /السيرفر رفضها/.test(await text(p, '#dayList'))), `refused on screen: ${await text(p, '#dayList')}`);
  assert.match(await text(p, '#dayList'), /insufficient stock|الرصيد على السيرفر مش كفاية/);
  assert.match(await text(p, '#dayRefused'), /محفوظة على الجهاز ده بس/);
  assert.ok(await p.locator('#stuckChip:not([hidden])').count(), 'the refused list button is shown');
  assert.equal((await serverSales()).length, 1, 'only the competing sale is on the server');
  assert.equal(await level(), 0);
  await p.close();
});

test('after a restock, the refused receipt is sent again from the refused list and accepted once', { skip }, async () => {
  assert.equal((await api(owner.token, '/api/db', { op: 'upsert', table: 'purchases', ignoreDuplicates: true, rows: { id: uuid(), pharmacy_id: P, branch_id: B, received_on: now().slice(0, 10), lines: [{ code: 'G1', qty: 10, cost: 5 }], total: 50 } })).error, null);
  const p = await cashierPage();
  assert.ok(await p.locator('#stuckChip:not([hidden])').count(), 'still in the refused list after a restart');
  await p.click('#stuckChip');
  assert.ok(await until(p, async () => (await serverSales()).length === 2), 'sent again and stored');
  assert.ok(await until(p, async () => !/السيرفر رفضها/.test(await text(p, '#dayList'))), 'no longer shown as refused');
  assert.equal(await level(), 9);
  await p.close();
});

test('restart with receipts waiting: they are sent when the cashier opens again, once each', { skip }, async () => {
  const p = await cashierPage();
  await offline(p, true);
  await sell(p); await sell(p);
  assert.match(await text(p, '#netChip'), /مستني/);
  await p.close(); // the cashier closes while offline
  await ctx.setOffline(false);
  const p2 = await cashierPage(); // and opens again, online
  assert.ok(await until(p2, async () => (await serverSales()).length === 4), `stored: ${(await serverSales()).length}`);
  assert.equal(await level(), 7);
  await p2.close();
});

test('the connection drops in the middle of sending: what was not sent stays waiting, then goes, nothing twice', { skip }, async () => {
  const p = await cashierPage();
  await offline(p, true);
  await sell(p); await sell(p); await sell(p);
  // Back online, but the network fails after the first receipt is sent.
  let sent = 0;
  await p.route('**/api/db', async (route) => {
    const q = JSON.parse(route.request().postData() || '{}');
    if (q.table === 'pos_sales' && q.op !== 'select') { sent++; if (sent > 1) return route.abort('internetdisconnected'); }
    return route.continue();
  });
  await offline(p, false);
  assert.ok(await until(p, async () => (await serverSales()).length === 5), 'the first one arrived');
  await p.waitForTimeout(1500);
  assert.equal((await serverSales()).length, 5, 'the others are still waiting, not lost and not doubled');
  assert.match(await text(p, '#netChip'), /بيرفع|مستني/);
  await p.unroute('**/api/db');
  await p.evaluate(() => dispatchEvent(new Event('online')));
  assert.ok(await until(p, async () => (await serverSales()).length === 7), `all arrived: ${(await serverSales()).length}`);
  const numbers = (await serverSales()).map((s) => s.number);
  assert.equal(new Set(numbers).size, numbers.length, 'no receipt twice');
  assert.equal(await level(), 4);
  await p.close();
});

test('online in a blocked branch, the sale is confirmed by the server before printing; past zero it is refused and nothing is saved', { skip }, async () => {
  const p = await cashierPage();
  const said = await sell(p);
  assert.match(said, /السيرفر أكّدها/);
  const n = (await serverSales()).length;
  await p.fill('#q', 'G1'); await p.press('#q', 'Enter');
  await p.fill('[data-qty="0"]', '999'); await p.press('[data-qty="0"]', 'Tab');
  await p.keyboard.press('F2');
  assert.ok(await until(p, async () => /الرصيد على السيرفر مش كفاية/.test(await text(p, '#posMsg'))));
  assert.equal((await serverSales()).length, n);
  await p.close();
});

test('no script errors', { skip }, () => { assert.deepEqual(errors, []); });
