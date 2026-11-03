// Stock kept by the server (Phase 2 M1): the ledger follows every movement atomically, retries add
// nothing twice, refused requests add nothing, openings set the levels from the app's numbers, and a
// branch that blocks selling below zero never sells the last box twice — even from two devices at once.
// Runs on a local Worker with local D1 (like api.test.mjs): WORKER_URL=http://localhost:8787 node --test worker/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.WORKER_URL;
const skip = !BASE && 'WORKER_URL not set (start the local Worker first)';
const rnd = () => Math.random().toString(36).slice(2, 10);
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function user() {
  let token = null;
  const call = async (path, body) => {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
    return { status: r.status, ...(await r.json()) };
  };
  return {
    email: `s-${rnd()}@test.local`,
    async signUp() { const r = await call('/api/auth/signup', { email: this.email, password: 'password123' }); token = r.data.access_token; },
    rpc: (n, a) => call(`/api/rpc/${n}`, a),
    db: (q) => call('/api/db', q),
    select: (table, cols, filters = [], extra = {}) => call('/api/db', { op: 'select', table, cols, filters, limit: 1000, ...extra }),
    insert: (table, rows) => call('/api/db', { op: 'upsert', table, rows, ignoreDuplicates: true }),
    call,
  };
}

let owner, device, phB2, P, B, B2;
const join = async (role, branches) => { const u = user(); await u.signUp(); const code = (await owner.rpc('create_invite', { p_pharmacy: P, p_role: role, p_branch_ids: branches })).data; assert.equal((await u.rpc('join_pharmacy', { p_code: code })).data, P); return u; };
const level = async (code, branch = B) => (await owner.select('stock_levels', 'qty', [['pharmacy_id', 'eq', P], ['branch_id', 'eq', branch], ['code', 'eq', code]])).data[0]?.qty ?? null;
const ledger = async (sourceId) => (await owner.select('stock_ledger', 'code, qty, applied, kind', [['pharmacy_id', 'eq', P], ['source_id', 'eq', sourceId]])).data;
const sale = (o = {}) => ({ id: uuid(), pharmacy_id: P, branch_id: B, number: `T-${rnd()}`, sold_at: now(), kind: 'sale', lines: [{ code: 'A1', qty: 1, price: 10 }], total: 10, paid: 10, ...o });
const buy = (lines, o = {}) => ({ id: uuid(), pharmacy_id: P, branch_id: B, received_on: now().slice(0, 10), lines, total: 1, ...o });
const move = (code, qty, kind = 'count', o = {}) => ({ id: uuid(), pharmacy_id: P, branch_id: B, code, qty, kind, happened_at: now(), ...o });

test('setup: a pharmacy with two branches, a cashier device on both, a pharmacist on the second', { skip }, async () => {
  owner = user(); await owner.signUp();
  P = (await owner.rpc('create_pharmacy', { p_name: 'صيدلية المخزون' })).data;
  B = (await owner.select('branches', 'id', [['pharmacy_id', 'eq', P]])).data[0].id;
  B2 = (await owner.rpc('add_branch', { p_pharmacy: P, p_name: 'فرع تاني' })).data;
  assert.ok(B && B2);
  device = await join('device', [B, B2]);
  phB2 = await join('pharmacist', [B2]);
});

test('the ledger follows every movement: purchase, sale by box and strip, return, supplier return, damage, transfer, deletion', { skip }, async () => {
  const p1 = buy([{ code: 'A1', qty: 10, bonus: 2, cost: 5 }]);
  assert.equal((await owner.insert('purchases', p1)).error, null);
  assert.equal(await level('A1'), 12, 'bonus boxes count');
  const s1 = sale({ lines: [{ code: 'A1', qty: 2, price: 10 }], total: 20, paid: 20 });
  assert.equal((await device.insert('pos_sales', s1)).error, null);
  assert.equal(await level('A1'), 10);
  const s2 = sale({ lines: [{ code: 'A1', qty: 2, per: 4, unit: 'strip', price: 2.5 }], total: 5, paid: 5 });
  assert.equal((await device.insert('pos_sales', s2)).error, null);
  assert.equal(await level('A1'), 9.5, '2 strips of 4 = half a box');
  const r1 = sale({ kind: 'return', return_of: s1.id, lines: [{ code: 'A1', qty: 1, price: 10 }], total: -10, paid: -10 });
  assert.equal((await device.insert('pos_sales', r1)).error, null);
  assert.equal(await level('A1'), 10.5);
  assert.equal((await owner.insert('purchases', buy([{ code: 'A1', qty: 3, cost: 5 }], { kind: 'return' }))).error, null);
  assert.equal(await level('A1'), 7.5, 'supplier return');
  const dmg = move('A1', -1, 'damaged');
  assert.equal((await owner.insert('stock_moves', dmg)).error, null);
  assert.equal(await level('A1'), 6.5);
  const out = move('A1', -2, 'transfer'), inn = move('A1', 2, 'transfer', { branch_id: B2 });
  assert.equal((await owner.insert('stock_moves', [out, inn])).error, null);
  assert.equal(await level('A1'), 4.5);
  assert.equal(await level('A1', B2), 2);
  // Deleting the damage record undoes it with new ledger rows; nothing is rewritten.
  assert.equal((await owner.db({ op: 'delete', table: 'stock_moves', filters: [['id', 'eq', dmg.id]] })).error, null);
  assert.equal(await level('A1'), 5.5);
  assert.deepEqual((await ledger(dmg.id)).map((r) => [r.kind, r.qty]).sort(), [['move:damaged', -1], ['reversal', 1]]);
  // The level is exactly the sum of the ledger.
  const all = (await owner.select('stock_ledger', 'applied', [['pharmacy_id', 'eq', P], ['branch_id', 'eq', B], ['code', 'eq', 'A1']])).data;
  assert.equal(Math.round(all.reduce((a, r) => a + r.applied, 0) * 1e6) / 1e6, 5.5);
});

test('retries add nothing twice; refused requests add nothing (rollback)', { skip }, async () => {
  const start = await level('A1');
  const s = sale({});
  await device.insert('pos_sales', s);
  await device.insert('pos_sales', s);
  await Promise.all([device.insert('pos_sales', s), device.insert('pos_sales', s)]);
  assert.equal(await level('A1'), start - 1, 'one sale, sent four times');
  assert.equal((await ledger(s.id)).length, 1);
  // Refused: a wrong total, and a request whose second receipt reuses a number (all or nothing).
  assert.equal((await device.insert('pos_sales', sale({ total: 1, paid: 1 }))).status, 400);
  const a = sale({});
  assert.equal((await device.insert('pos_sales', [a, sale({ number: a.number })])).status, 409);
  assert.equal(await level('A1'), start - 1, 'nothing taken out by refused requests');
  assert.deepEqual(await ledger(a.id), []);
  // The ledger and levels can't be written through the data API.
  assert.equal((await owner.insert('stock_ledger', { id: 'x', pharmacy_id: P, branch_id: B, code: 'A1', qty: 100, applied: 100, kind: 'x', source_table: 'x', source_id: 'x', effective_at: now(), received_at: now() })).status, 403);
  assert.equal((await owner.insert('stock_levels', { pharmacy_id: P, branch_id: B, code: 'A1', qty: 100, updated_at: now() })).status, 403);
});

test('opening sets the levels from the app\'s numbers, keeping what arrived while the app was loading', { skip }, async () => {
  const st = (await owner.rpc('stock_status', { p_pharmacy: P, p_branch: B })).data;
  assert.equal(st.opened_at, null);
  assert.equal(st.block_negative, false);
  // A sale arrives after the app took the watermark (it is not in the app's numbers).
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await device.insert('pos_sales', sale({ lines: [{ code: 'A1', qty: 3, price: 10 }], total: 30, paid: 30 }))).error, null);
  const r = await owner.rpc('open_stock', { p_pharmacy: P, p_branch: B, p_base_at: null, p_watermark: st.server_now, p_items: [{ code: 'A1', qty: 20 }, { code: 'B2', qty: 4 }] });
  assert.equal(r.error, null);
  assert.equal(await level('A1'), 17, '20 counted by the app, then the sale it had not seen');
  assert.equal(await level('B2'), 4);
  assert.equal((await owner.rpc('stock_status', { p_pharmacy: P, p_branch: B })).data.stale, false);
  // A second opening without B2: its level goes to zero.
  const st2 = (await owner.rpc('stock_status', { p_pharmacy: P, p_branch: B })).data;
  assert.equal((await owner.rpc('open_stock', { p_pharmacy: P, p_branch: B, p_watermark: st2.server_now, p_items: [{ code: 'A1', qty: 17 }] })).error, null);
  assert.equal(await level('B2'), 0);
  assert.equal(await level('A1'), 17);
  // Openings are in the ledger and the log; staff of another branch and the device can't open.
  assert.ok((await owner.select('audit_log', 'op', [['pharmacy_id', 'eq', P], ['table_name', 'eq', 'stock_openings']])).data.length >= 2);
  assert.equal((await phB2.rpc('open_stock', { p_pharmacy: P, p_branch: B, p_watermark: st2.server_now, p_items: [] })).status, 403);
  assert.equal((await device.rpc('open_stock', { p_pharmacy: P, p_branch: B, p_watermark: st2.server_now, p_items: [] })).status, 403);
  assert.match((await owner.rpc('open_stock', { p_pharmacy: P, p_branch: B, p_watermark: 'x', p_items: [] })).error.message, /watermark/);
  assert.match((await owner.rpc('open_stock', { p_pharmacy: P, p_branch: B, p_watermark: st2.server_now, p_items: [{ code: 'A1', qty: 'lots' }] })).error.message, /bad items/);
});

test('allowed by default: selling below zero goes negative, as today', { skip }, async () => {
  const st = (await owner.rpc('stock_status', { p_pharmacy: P, p_branch: B })).data;
  assert.equal((await owner.rpc('open_stock', { p_pharmacy: P, p_branch: B, p_watermark: st.server_now, p_items: [{ code: 'A1', qty: 1 }] })).error, null);
  assert.equal((await device.insert('pos_sales', sale({ lines: [{ code: 'A1', qty: 3, price: 10 }], total: 30, paid: 30 }))).error, null);
  assert.equal(await level('A1'), -2);
});

test('blocked: two devices sell the last box at the same moment — exactly one sale is stored', { skip }, async () => {
  assert.equal((await device.rpc('set_stock_policy', { p_pharmacy: P, p_branch: B, p_block_negative: true })).status, 403, 'only the owner sets the policy');
  assert.equal((await owner.rpc('set_stock_policy', { p_pharmacy: P, p_branch: B, p_block_negative: true })).error, null);
  const st = (await owner.rpc('stock_status', { p_pharmacy: P, p_branch: B })).data;
  assert.equal(st.block_negative, true);
  assert.equal((await owner.rpc('open_stock', { p_pharmacy: P, p_branch: B, p_watermark: st.server_now, p_items: [{ code: 'A1', qty: 1 }] })).error, null);
  const pharmacist = await join('pharmacist', [B]);
  const [x, y] = [sale({}), sale({})];
  const race = await Promise.all([device.insert('pos_sales', x), pharmacist.insert('pos_sales', y)]);
  assert.equal(race.filter((r) => !r.error).length, 1, JSON.stringify(race.map((r) => r.error)));
  assert.match(race.find((r) => r.error).error.message, /insufficient stock: A1/);
  assert.equal(await level('A1'), 0, 'never below zero');
  const stored = (await owner.select('pos_sales', 'id', [['pharmacy_id', 'eq', P], ['id', 'in', [x.id, y.id]]])).data;
  assert.equal(stored.length, 1, 'the refused sale was not stored');
  assert.equal((await ledger(stored[0].id)).length, 1);
  // Ten devices racing for 3 boxes: 3 sales stored.
  const st2 = (await owner.rpc('stock_status', { p_pharmacy: P, p_branch: B })).data;
  await owner.rpc('open_stock', { p_pharmacy: P, p_branch: B, p_watermark: st2.server_now, p_items: [{ code: 'A1', qty: 3 }] });
  const many = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? device : pharmacist).insert('pos_sales', sale({}))));
  assert.equal(many.filter((r) => !r.error).length, 3);
  assert.equal(await level('A1'), 0);
  // An item with no stock at all, and a mixed receipt: refused whole. A return is never blocked; a purchase restocks.
  assert.match((await device.insert('pos_sales', sale({ lines: [{ code: 'NEVER', qty: 1, price: 10 }] }))).error.message, /insufficient stock: NEVER/);
  assert.equal((await owner.insert('purchases', buy([{ code: 'A1', qty: 2, cost: 5 }]))).error, null);
  assert.match((await device.insert('pos_sales', sale({ lines: [{ code: 'A1', qty: 1, price: 10 }, { code: 'NEVER', qty: 1, price: 10 }], total: 20, paid: 20 }))).error.message, /insufficient stock: NEVER/);
  assert.equal(await level('A1'), 2, 'the refused mixed receipt took nothing');
  const r = sale({ kind: 'return', lines: [{ code: 'A1', qty: 1, price: 10 }], total: -10, paid: -10, return_of: stored[0].id });
  assert.equal((await device.insert('pos_sales', r)).error, null);
  assert.equal(await level('A1'), 3);
  // The other branch is not blocked.
  assert.equal((await device.insert('pos_sales', sale({ branch_id: B2, lines: [{ code: 'A1', qty: 5, price: 10 }], total: 50, paid: 50 }))).error, null);
});

test('a new upload makes the levels stale (not enforced) until the next opening; movements dated before the base change nothing', { skip }, async () => {
  const up = await owner.call(`/api/snapshot?pharmacy=${P}&branch=${B}&items=0`, { exportedAt: now(), items: [] });
  assert.equal(up.error, null);
  const st = (await owner.rpc('stock_status', { p_pharmacy: P, p_branch: B })).data;
  assert.equal(st.stale, true);
  assert.equal((await device.insert('pos_sales', sale({ lines: [{ code: 'A1', qty: 50, price: 10 }], total: 500, paid: 500 }))).error, null, 'stale levels block nothing');
  const baseAt = new Date(Date.now() - 3600000).toISOString();
  const st2 = (await owner.rpc('stock_status', { p_pharmacy: P, p_branch: B })).data;
  assert.equal((await owner.rpc('open_stock', { p_pharmacy: P, p_branch: B, p_base_at: baseAt, p_watermark: st2.server_now, p_items: [{ code: 'A1', qty: 5 }] })).error, null);
  const after = (await owner.rpc('stock_status', { p_pharmacy: P, p_branch: B })).data;
  assert.equal(after.stale, false);
  assert.equal(after.base_at, baseAt);
  // A receipt made offline before the uploaded file's time: the file already holds it.
  const old = sale({ sold_at: new Date(Date.now() - 2 * 3600000).toISOString() });
  assert.equal((await device.insert('pos_sales', old)).error, null);
  assert.deepEqual((await ledger(old.id)).map((r) => [r.qty, r.applied]), [[-1, 0]]);
  assert.equal(await level('A1'), 5);
});

test('levels follow branch access: staff see only their branches', { skip }, async () => {
  const seen = (await phB2.select('stock_levels', 'branch_id', [['pharmacy_id', 'eq', P]])).data.map((r) => r.branch_id);
  assert.ok(seen.length > 0 && seen.every((b) => b === B2));
  assert.equal((await phB2.rpc('stock_status', { p_pharmacy: P, p_branch: B })).status, 403);
});
