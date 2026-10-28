// The Cloudflare server's rules, tested on a local Worker (wrangler dev --local):
//   cd worker && npm run dev   (in another terminal), then: WORKER_URL=http://localhost:8787 node --test test/
// Each run uses new random accounts, so it can run again on the same local database.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.WORKER_URL;
const skip = !BASE && 'WORKER_URL not set (start the local Worker first)';
const rnd = () => Math.random().toString(36).slice(2, 10);
const uuid = () => crypto.randomUUID();

function user() {
  let token = null;
  const call = async (path, body) => {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
    const j = await r.json();
    return { status: r.status, ...j };
  };
  const u = {
    email: `t-${rnd()}@test.local`,
    async signUp(pw = 'password123') { const r = await call('/api/auth/signup', { email: u.email, password: pw }); token = r.data?.access_token; u.id = r.data?.user?.id; return r; },
    rpc: (name, args) => call(`/api/rpc/${name}`, args),
    db: (q) => call('/api/db', q),
    select: (table, cols, filters = [], extra = {}) => call('/api/db', { op: 'select', table, cols, filters, ...extra }),
    insert: (table, rows) => call('/api/db', { op: 'upsert', table, rows, ignoreDuplicates: true }),
    call,
    token: () => token,
    logout() { token = null; },
  };
  return u;
}

let owner, partner, device, other, P, B, P2;

test('sign up, wrong password, and a pharmacy with a main branch and a free trial', { skip }, async () => {
  owner = user();
  const r = await owner.signUp();
  assert.equal(r.error, null);
  assert.match(r.data.access_token, /^[0-9a-f]{64}$/);
  assert.match((await user().call('/api/auth/signup', { email: owner.email, password: 'password123' })).error.message, /registered/);
  assert.match((await user().call('/api/auth/signin', { email: owner.email, password: 'wrong-pass' })).error.message, /Invalid login/);
  assert.match((await user().call('/api/auth/signup', { email: `x-${rnd()}@t.io`, password: 'short' })).error.message, /weak/i);
  P = (await owner.rpc('create_pharmacy', { p_name: 'صيدلية التجربة' })).data;
  const m = await owner.select('members', 'role, pharmacies(id, name, settings, branches(id, name, created_at))');
  assert.equal(m.data[0].role, 'owner');
  assert.equal(m.data[0].pharmacies.branches.length, 1);
  B = m.data[0].pharmacies.branches[0].id;
  const sub = await owner.select('subscriptions', 'status, trial_ends', [['pharmacy_id', 'eq', P]]);
  assert.equal(sub.data[0].status, 'trial');
});

test('nobody signed out reads anything but the public prices', { skip }, async () => {
  const anon = user();
  assert.equal((await anon.select('pos_sales', '*')).status, 401);
  assert.equal((await anon.select('users', '*')).status, 404, 'accounts are not reachable at all');
  assert.equal((await anon.select('app_config', 'price_month')).data.length, 1);
});

test('invites: a partner and the pharmacy device join with a code; wrong codes are limited', { skip }, async () => {
  const code = (await owner.rpc('create_invite', { p_pharmacy: P, p_role: 'partner' })).data;
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  partner = user(); await partner.signUp();
  assert.equal((await partner.rpc('join_pharmacy', { p_code: 'WRONG-CODE-1234' })).data, null);
  assert.equal((await partner.rpc('join_pharmacy', { p_code: code.toLowerCase() })).data, P);
  assert.equal((await user().rpc('join_pharmacy', { p_code: code })).status, 401);
  device = user(); await device.signUp();
  assert.equal((await device.rpc('join_pharmacy', { p_code: (await owner.rpc('create_invite', { p_pharmacy: P, p_role: 'device' })).data })).data, P);
  const guesser = user(); await guesser.signUp();
  for (let i = 0; i < 10; i++) await guesser.rpc('join_pharmacy', { p_code: `NOPE${i}` });
  assert.match((await guesser.rpc('join_pharmacy', { p_code: code })).error.message, /too many attempts/);
});

test('each pharmacy sees only its own data', { skip }, async () => {
  other = user(); await other.signUp();
  P2 = (await other.rpc('create_pharmacy', { p_name: 'صيدلية تانية' })).data;
  await owner.insert('catalog_items', { id: uuid(), pharmacy_id: P, code: 'A1', name: 'بانادول', price: 50 });
  assert.equal((await other.select('catalog_items', '*', [['pharmacy_id', 'eq', P]])).data.length, 0);
  assert.equal((await other.insert('catalog_items', { id: uuid(), pharmacy_id: P, code: 'X', name: 'دس' })).status, 403);
  assert.equal((await other.rpc('create_invite', { p_pharmacy: P, p_role: 'partner' })).status, 403);
  // A receipt can't point at another pharmacy's branch.
  assert.match((await other.insert('pos_sales', { id: uuid(), pharmacy_id: P2, branch_id: B, number: 'X1', sold_at: new Date().toISOString(), kind: 'sale', lines: [{ code: 'A', qty: 1, price: 1 }], total: 1 })).error.message, /unknown branch/);
});

test('roles: the partner reads numbers only, the device sells, only the owner buys and edits', { skip }, async () => {
  const cust = uuid();
  assert.equal((await device.insert('customers', { id: cust, pharmacy_id: P, name: 'عم أحمد', phone: '0100' })).error, null);
  assert.equal((await partner.select('customers', '*', [['pharmacy_id', 'eq', P]])).data.length, 0, 'partners do not see customers');
  assert.equal((await owner.select('customers', '*', [['pharmacy_id', 'eq', P]])).data.length, 1);
  assert.equal((await device.insert('purchases', { id: uuid(), pharmacy_id: P, received_on: '2026-10-28', lines: [{ code: 'A1', qty: 1, cost: 1 }], total: 1 })).status, 403);
  assert.equal((await partner.insert('pos_sales', { id: uuid(), pharmacy_id: P, number: 'P1', sold_at: new Date().toISOString(), lines: [{ code: 'A1', qty: 1, price: 50 }], total: 50 })).status, 403);
  await device.db({ op: 'update', table: 'catalog_items', patch: { price: 1 }, filters: [['code', 'eq', 'A1']] }); // like row-level security: nothing matches, nothing changes
  assert.equal((await owner.select('catalog_items', 'price', [['code', 'eq', 'A1']])).data[0].price, 50);
  assert.equal((await owner.db({ op: 'update', table: 'catalog_items', patch: { price: 55, updated_at: new Date().toISOString() }, filters: [['code', 'eq', 'A1']] })).error, null);
  assert.equal((await owner.db({ op: 'update', table: 'catalog_items', patch: { pharmacy_id: P2 }, filters: [['code', 'eq', 'A1']] })).status, 403, 'only the allowed columns');
  assert.equal((await owner.select('employees', 'pin_hash', [['pharmacy_id', 'eq', P]])).status, 403, 'no one reads PIN hashes');
});

test('returns: only against the receipt, never more than was sold', { skip }, async () => {
  const sale = uuid();
  assert.equal((await device.insert('pos_sales', { id: sale, pharmacy_id: P, branch_id: B, number: 'S1', sold_at: new Date().toISOString(), kind: 'sale', lines: [{ code: 'A1', qty: 2, price: 50 }], total: 100 })).error, null);
  assert.equal((await device.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B, number: 'R1', sold_at: new Date().toISOString(), kind: 'return', return_of: sale, lines: [{ code: 'A1', qty: 1, price: 50 }], total: -50 })).error, null);
  assert.match((await device.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B, number: 'R2', sold_at: new Date().toISOString(), kind: 'return', return_of: sale, lines: [{ code: 'A1', qty: 2, price: 50 }], total: -100 })).error.message, /return more than sold/);
  const again = uuid();
  const row = { id: again, pharmacy_id: P, branch_id: B, number: 'S2', sold_at: new Date().toISOString(), lines: [{ code: 'A1', qty: 1, price: 50 }], total: 50 };
  await device.insert('pos_sales', row);
  await device.insert('pos_sales', row); // sent twice after a lost answer: saved once
  assert.equal((await owner.select('pos_sales', 'id', [['pharmacy_id', 'eq', P], ['number', 'eq', 'S2']])).data.length, 1);
});

test('cashier PIN, shifts, and the log of changes', { skip }, async () => {
  assert.equal((await owner.rpc('add_employee', { p_pharmacy: P, p_name: 'سارة', p_pin: '1234' })).error, null);
  assert.match((await owner.rpc('add_employee', { p_pharmacy: P, p_name: 'تانية', p_pin: '1234' })).error.message, /PIN already used/);
  assert.equal((await device.rpc('cashier_staff', { p_pharmacy: P })).data, 1);
  const e = (await device.rpc('cashier_pin', { p_pharmacy: P, p_pin: '1234' })).data[0];
  assert.equal(e.employee_name, 'سارة');
  assert.deepEqual((await device.rpc('cashier_pin', { p_pharmacy: P, p_pin: '9999' })).data, []);
  const shift = uuid();
  assert.equal((await device.insert('pos_shifts', { id: shift, pharmacy_id: P, branch_id: B, employee_id: e.employee_id, employee_name: 'سارة', opened_at: new Date().toISOString(), opening_cash: 100 })).error, null);
  assert.equal((await device.db({ op: 'update', table: 'pos_shifts', patch: { closed_at: new Date().toISOString(), counted_cash: 90, expected_cash: 100 }, filters: [['id', 'eq', shift]] })).error, null);
  await device.db({ op: 'update', table: 'pos_shifts', patch: { counted_cash: 1000 }, filters: [['id', 'eq', shift]] });
  assert.equal((await owner.select('pos_shifts', 'counted_cash', [['id', 'eq', shift]])).data[0].counted_cash, 90, 'a closed shift is not changed');
  const log = (await owner.select('audit_log', 'table_name, op, new_row', [['pharmacy_id', 'eq', P]], { order: { col: 'at', asc: false } })).data;
  assert.ok(log.some((x) => x.table_name === 'pos_shifts' && x.op === 'update'));
  assert.ok(log.every((x) => !JSON.stringify(x.new_row || {}).includes('pin_hash')));
  assert.equal((await partner.select('audit_log', '*', [['pharmacy_id', 'eq', P]])).data.length, 0, 'the log is for the owner');
  assert.equal((await device.rpc('clock', { p_pharmacy: P, p_pin: '1234' })).data[0].action, 'in');
});

test('uploads are kept in R2 and come back whole; the connector uploads with its token', { skip }, async () => {
  const data = { items: [{ code: 'A1', name: 'بانادول', cost: 40, price: 50, qty: 3 }], batches: [], sales: [] };
  assert.equal((await owner.rpc('save_snapshot', { p_pharmacy: P, p_data: data, p_branch: B })).error, null);
  assert.equal((await partner.rpc('save_snapshot', { p_pharmacy: P, p_data: data })).status, 403);
  const s = (await device.select('snapshots', 'created_at, data', [['pharmacy_id', 'eq', P], ['branch_id', 'eq', B]], { order: { col: 'created_at', asc: false }, limit: 1 })).data[0];
  assert.deepEqual(s.data, data);
  const token = (await owner.rpc('create_connector_token', { p_pharmacy: P, p_branch: B })).data;
  const r = await user().call('/rest/v1/rpc/upload_snapshot', { p_token: token, p_data: { ...data, items: [...data.items, { code: 'B2', name: 'x' }] } });
  assert.equal(r.error, null);
  assert.equal((await owner.select('snapshots', 'data', [['pharmacy_id', 'eq', P]], { order: { col: 'created_at', asc: false }, limit: 1 })).data[0].data.items.length, 2);
  // The app's own uploads go as a plain body, stored without being read through.
  const r2 = await fetch(`${BASE}/api/snapshot?pharmacy=${P}&items=1`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token()}` }, body: JSON.stringify(data) });
  assert.equal((await r2.json()).error, null);
  const r3 = await fetch(`${BASE}/api/snapshot?pharmacy=${P}&items=1`, { method: 'POST', headers: { Authorization: `Bearer ${partner.token()}` }, body: JSON.stringify(data) });
  assert.equal(r3.status, 403);
  const r4 = await fetch(`${BASE}/api/snapshot?pharmacy=${P}`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token()}` }, body: 'not json' });
  assert.match((await r4.json()).error.message, /bad snapshot/);
  assert.match((await user().call('/rest/v1/rpc/upload_snapshot', { p_token: 'sdl_bad', p_data: data })).error.message, /invalid token/);
});

test('the admin page is for the app owner only', { skip }, async () => {
  assert.match((await owner.rpc('admin_pharmacies')).error.message, /not allowed/);
  assert.equal((await owner.rpc('is_app_admin')).data, false);
});

test('a full backup moves into a new, empty pharmacy', { skip }, async () => {
  const mover = user(); await mover.signUp();
  const NP = (await mover.rpc('create_pharmacy', { p_name: 'صيدلية منقولة' })).data;
  const dump = { app: 'saydaliti', version: 1, tables: {
    pharmacies: [{ id: 'old', name: 'قديمة', settings: { taxMode: 'none' } }],
    branches: [{ id: uuid(), name: 'الرئيسي', created_at: '2026-01-01T00:00:00Z' }],
    catalog_items: [{ id: uuid(), code: 'Z9', name: 'شاش', price: 10, created_at: '2026-01-02T00:00:00Z' }],
    pos_sales: [{ id: uuid(), number: 'OLD1', sold_at: '2026-10-01T10:00:00Z', kind: 'sale', lines: [{ code: 'Z9', qty: 1, price: 10 }], total: 10, discount: 0, payment: 'cash', credit: 0, created_at: '2026-10-01T10:00:00Z' }],
    snapshots: [{ id: 1, data: { items: [{ code: 'Z9', name: 'شاش' }] } }],
  } };
  const r = await mover.rpc('import_backup', { p_pharmacy: NP, p_dump: dump });
  assert.equal(r.error, null);
  assert.equal(r.data.catalog_items, 1);
  assert.ok(Object.values(r.data.branches).every(Boolean), 'each old branch maps to one here');
  assert.equal((await mover.select('pos_sales', 'number', [['pharmacy_id', 'eq', NP]])).data[0].number, 'OLD1');
  assert.match((await mover.rpc('import_backup', { p_pharmacy: NP, p_dump: dump })).error.message, /not empty/);
});

test('signing out ends the session', { skip }, async () => {
  const r = await owner.call('/api/auth/signout', {});
  assert.equal(r.error, null);
  assert.equal((await owner.select('pos_sales', '*', [['pharmacy_id', 'eq', P]])).status, 401);
});
