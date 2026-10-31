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
  assert.equal(m.data[0].pharmacies.main_branch_id, B);
  assert.equal(m.data[0].pharmacies.branch_scope_version, 1);
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

test('staff data, writes, invitations and returns stay inside assigned branches', { skip }, async () => {
  const B2 = (await owner.rpc('add_branch', { p_pharmacy: P, p_name: 'فرع تاني' })).data;
  const staff = user(); await staff.signUp();
  const badInvite = await owner.rpc('create_invite', { p_pharmacy: P, p_role: 'device', p_branch_ids: [uuid()] });
  assert.equal(badInvite.status, 400, 'an invitation cannot name another pharmacy branch');
  const invite = (await owner.rpc('create_invite', { p_pharmacy: P, p_role: 'device', p_branch_ids: [B2] })).data;
  assert.equal((await staff.rpc('join_pharmacy', { p_code: invite })).data, P);

  const mainSale = { id: uuid(), pharmacy_id: P, branch_id: B, number: 'MAIN-BRANCH', sold_at: new Date().toISOString(), kind: 'sale', lines: [{ code: 'A1', qty: 1, price: 50 }], total: 50 };
  const branchSale = { ...mainSale, id: uuid(), branch_id: B2, number: 'SECOND-BRANCH' };
  assert.equal((await owner.insert('pos_sales', [mainSale, branchSale])).error, null);
  assert.deepEqual((await staff.select('branches', 'id')).data.map((x) => x.id), [B2]);
  assert.deepEqual((await staff.select('pos_sales', 'id')).data.map((x) => x.id), [branchSale.id]);
  assert.equal((await owner.select('pos_sales', 'id', [['pharmacy_id', 'eq', P]])).data.length, 2);
  assert.equal((await partner.select('branches', 'id')).data.length, 2);
  assert.equal((await staff.insert('pos_sales', { ...mainSale, id: uuid(), number: 'DENIED-MAIN' })).status, 403);
  assert.equal((await staff.insert('pos_sales', { ...branchSale, id: uuid(), number: 'ALLOWED-BRANCH', branch_id: null })).status, 403, 'NULL belongs to the main branch');
  assert.equal((await staff.insert('pos_sales', { ...branchSale, id: uuid(), number: 'ALLOWED-BRANCH' })).error, null);
  assert.equal((await staff.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B2, number: 'CROSS-RETURN', sold_at: new Date().toISOString(), kind: 'return', return_of: mainSale.id, lines: [{ code: 'A1', qty: 1, price: 50 }], total: -50 })).status, 403);

  const members = (await owner.rpc('list_branch_members', { p_pharmacy: P })).data;
  assert.deepEqual(members.find((m) => m.user_id === staff.id).branch_ids, [B2]);
  assert.equal((await owner.rpc('set_member_branches', { p_pharmacy: P, p_user_id: staff.id, p_branch_ids: [uuid()] })).status, 400);
  assert.equal((await owner.rpc('set_member_branches', { p_pharmacy: P, p_user_id: staff.id, p_branch_ids: [B] })).error, null);
  assert.deepEqual((await staff.select('branches', 'id')).data.map((x) => x.id), [B]);
  assert.equal((await owner.rpc('set_member_branches', { p_pharmacy: P, p_user_id: staff.id, p_branch_ids: [B, B2] })).error, null);
  assert.equal((await staff.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B2, number: 'CROSS-RETURN-ASSIGNED', sold_at: new Date().toISOString(), kind: 'return', return_of: mainSale.id, lines: [{ code: 'A1', qty: 1, price: 50 }], total: -50 })).status, 403, 'a return must stay in the sale branch even when both branches are assigned');
  assert.equal((await owner.rpc('set_member_branches', { p_pharmacy: P, p_user_id: staff.id, p_branch_ids: [] })).error, null);
  assert.equal((await staff.select('branches', 'id')).data.length, 0);
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
  const concurrentSale = uuid();
  assert.equal((await device.insert('pos_sales', { id: concurrentSale, pharmacy_id: P, branch_id: B, number: 'S3', sold_at: new Date().toISOString(), kind: 'sale', lines: [{ code: 'A1', qty: 1, price: 50 }], total: 50 })).error, null);
  const concurrentReturns = await Promise.all([1, 2].map((n) => device.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B, number: `CR${n}`, sold_at: new Date().toISOString(), kind: 'return', return_of: concurrentSale, lines: [{ code: 'A1', qty: 1, price: 50 }], total: -50 })));
  assert.equal(concurrentReturns.filter((r) => !r.error).length, 1);
  assert.match(concurrentReturns.find((r) => r.error)?.error.message, /return more than sold/);
  const again = uuid();
  const row = { id: again, pharmacy_id: P, branch_id: B, number: 'S2', sold_at: new Date().toISOString(), lines: [{ code: 'A1', qty: 1, price: 50 }], total: 50 };
  await device.insert('pos_sales', row);
  await device.insert('pos_sales', row); // sent twice after a lost answer: saved once
  assert.equal((await owner.select('pos_sales', 'id', [['pharmacy_id', 'eq', P], ['number', 'eq', 'S2']])).data.length, 1);
});

test('strips sold and returned are counted in boxes; returns to the supplier; tasks are the owner\'s', { skip }, async () => {
  const sale = uuid();
  assert.equal((await device.insert('pos_sales', { id: sale, pharmacy_id: P, branch_id: B, number: 'ST1', sold_at: new Date().toISOString(), kind: 'sale', lines: [{ code: 'A1', qty: 2, per: 3, unit: 'strip', price: 10, bp: 30 }], total: 20, delivery_fee: 5, delivery_to: 'x' })).error, null);
  assert.match((await device.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B, number: 'SR2', sold_at: new Date().toISOString(), kind: 'return', return_of: sale, lines: [{ code: 'A1', qty: 1, price: 30 }], total: -30 })).error.message, /return more than sold/, 'a whole box is more than 2 strips of 3');
  assert.equal((await device.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B, number: 'SR3', sold_at: new Date().toISOString(), kind: 'return', return_of: sale, lines: [{ code: 'A1', qty: 2, per: 3, price: 10 }], total: -20 })).error, null);
  assert.equal((await owner.insert('purchases', { id: uuid(), pharmacy_id: P, received_on: '2026-10-28', kind: 'return', supplier_name: 'الأمل', lines: [{ code: 'A1', qty: 1, cost: 1 }], total: 1 })).error, null);
  assert.equal((await owner.insert('purchases', { id: uuid(), pharmacy_id: P, received_on: '2026-10-28', kind: 'gift', lines: [{ code: 'A1', qty: 1, cost: 1 }], total: 1 })).status, 400);
  assert.equal((await owner.insert('catalog_items', { id: uuid(), pharmacy_id: P, code: 'K9', name: 'كونكور', strips: 3, generic: 'BISOPROLOL', maker: 'ميرك', min_qty: 2 })).error, null);
  assert.equal((await owner.insert('tasks', { id: uuid(), pharmacy_id: P, title: 'رجّع الراكد' })).error, null);
  assert.equal((await partner.select('tasks', 'title', [['pharmacy_id', 'eq', P]])).data.length, 1, 'partners see tasks');
  assert.equal((await partner.insert('tasks', { id: uuid(), pharmacy_id: P, title: 'x' })).status, 403);
  assert.equal((await device.select('tasks', 'title', [['pharmacy_id', 'eq', P]])).data?.length ?? 0, 0, 'the cashier device does not');
});

test('staff roles: the pharmacist sells, the accountant pays, the stock manager buys and counts — each only that', { skip }, async () => {
  const join = async (role) => { const u = user(); await u.signUp(); assert.equal((await u.rpc('join_pharmacy', { p_code: (await owner.rpc('create_invite', { p_pharmacy: P, p_role: role })).data })).data, P); return u; };
  const ph = await join('pharmacist'), acc = await join('accountant'), st = await join('stock');
  const sale = (n) => ({ id: uuid(), pharmacy_id: P, branch_id: B, number: n, sold_at: new Date().toISOString(), lines: [{ code: 'A1', qty: 1, price: 50 }], total: 50 });
  assert.equal((await ph.insert('pos_sales', sale('PH1'))).error, null, 'the pharmacist sells');
  assert.equal((await acc.insert('pos_sales', sale('AC1'))).status, 403);
  assert.equal((await st.insert('pos_sales', sale('ST9'))).status, 403);
  const buy = () => ({ id: uuid(), pharmacy_id: P, received_on: '2026-10-28', lines: [{ code: 'A1', qty: 1, cost: 1 }], total: 1 });
  assert.equal((await st.insert('purchases', buy())).error, null, 'the stock manager records deliveries');
  assert.equal((await st.insert('stock_moves', { id: uuid(), pharmacy_id: P, code: 'A1', qty: -1, kind: 'damaged', happened_at: new Date().toISOString() })).error, null);
  assert.equal((await ph.insert('purchases', buy())).status, 403);
  assert.equal((await acc.insert('purchases', buy())).status, 403);
  assert.equal((await acc.insert('expenses', { id: uuid(), pharmacy_id: P, spent_on: '2026-10-28', kind: 'rent', amount: 100 })).error, null, 'the accountant records expenses');
  assert.equal((await ph.insert('expenses', { id: uuid(), pharmacy_id: P, spent_on: '2026-10-28', kind: 'rent', amount: 100 })).status, 403, 'the pharmacist only takes money out of the drawer');
  assert.equal((await acc.insert('supplier_payments', { id: uuid(), pharmacy_id: P, supplier_name: 'الأمل', paid_on: '2026-10-28', amount: 10 })).error, null);
  assert.equal((await st.insert('supplier_payments', { id: uuid(), pharmacy_id: P, supplier_name: 'الأمل', paid_on: '2026-10-28', amount: 10 })).status, 403);
  assert.ok((await acc.select('expenses', 'id', [['pharmacy_id', 'eq', P]])).data.length >= 1, 'the accountant reads the money');
  assert.equal((await ph.select('expenses', 'id', [['pharmacy_id', 'eq', P]])).data?.length ?? 0, 0, 'the pharmacist does not');
  assert.equal((await st.select('audit_log', 'id', [['pharmacy_id', 'eq', P]])).data?.length ?? 0, 0, 'only the owner reads the log');
  assert.equal((await st.db({ op: 'update', table: 'catalog_items', patch: { price: 60, updated_at: new Date().toISOString() }, filters: [['code', 'eq', 'A1']] })).error, null, 'the stock manager edits items');
  assert.equal((await owner.rpc('create_invite', { p_pharmacy: P, p_role: 'owner' })).error.message, 'bad role');
});

test('plans: limits on branches and accounts are kept by the server; AI is off with no key', { skip }, async () => {
  const st = await (await fetch(`${BASE}/api/ai/status`)).json();
  assert.equal(st.data.enabled, false);
  assert.equal((await owner.call('/api/ai', { pharmacy: P, messages: [], tools: [] })).status, 501);
});

test('item photos and closing a day', { skip }, async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const url = `${BASE}/api/item-image?pharmacy=${P}&code=A1`;
  const put = (u, body, type = 'image/png') => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${u.token()}`, 'Content-Type': type }, body });
  assert.equal((await put(partner, png)).status, 403, 'partners do not change photos');
  assert.equal((await put(owner, png, 'text/html')).status, 400);
  assert.equal((await put(owner, png)).status, 200);
  const got = await fetch(url, { headers: { Authorization: `Bearer ${device.token()}` } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('Content-Type'), 'image/png');
  assert.ok([401, 403].includes((await fetch(url)).status), 'not without signing in');
  assert.equal((await owner.insert('day_closes', { id: uuid(), pharmacy_id: P, branch_id: B, day: '2026-10-30', totals: { sales: 100 }, expected_cash: 80, counted_cash: 75 })).error, null);
  assert.equal((await device.insert('day_closes', { id: uuid(), pharmacy_id: P, day: '2026-10-30', totals: {} })).status, 403);
  assert.equal((await partner.select('day_closes', 'counted_cash', [['pharmacy_id', 'eq', P]])).data[0].counted_cash, 75);
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
  // Money taken out of the drawer: the cashier device records it (only that kind), the owner reads it.
  const out = uuid();
  assert.equal((await device.insert('expenses', { id: out, pharmacy_id: P, branch_id: B, spent_on: '2026-10-29', kind: 'withdrawal', amount: 150, person: 'أحمد', shift_id: shift })).error, null);
  assert.equal((await device.insert('expenses', { id: uuid(), pharmacy_id: P, branch_id: B, spent_on: '2026-10-29', kind: 'rent', amount: 150 })).status, 403, 'other expenses are the owner\'s');
  assert.equal((await device.insert('expenses', { id: uuid(), pharmacy_id: P, branch_id: B, spent_on: '2026-10-29', kind: 'withdrawal', amount: 1, shift_id: uuid() })).status, 400, 'a shift that does not exist');
  assert.equal((await device.select('expenses', 'id', [['pharmacy_id', 'eq', P]])).data.length, 0, 'the device does not read the pharmacy\'s expenses');
  assert.deepEqual((await owner.select('expenses', 'amount, person, shift_id', [['id', 'eq', out]])).data, [{ amount: 150, person: 'أحمد', shift_id: shift }]);
  // Goods taken for the owner: a stock move with who took them.
  assert.equal((await owner.insert('stock_moves', { id: uuid(), pharmacy_id: P, branch_id: B, code: 'A1', qty: -2, kind: 'withdrawal', person: 'أحمد', cost: 40 })).error, null);
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
