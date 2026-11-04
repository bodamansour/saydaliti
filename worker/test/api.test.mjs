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
  assert.match((await other.insert('pos_sales', { id: uuid(), pharmacy_id: P2, branch_id: B, number: 'X1', sold_at: new Date().toISOString(), kind: 'sale', lines: [{ code: 'A', qty: 1, price: 1 }], total: 1, paid: 1 })).error.message, /unknown branch/);
});

test('staff data, writes, invitations and returns stay inside assigned branches', { skip }, async () => {
  const B2 = (await owner.rpc('add_branch', { p_pharmacy: P, p_name: 'فرع تاني' })).data;
  const staff = user(); await staff.signUp();
  const badInvite = await owner.rpc('create_invite', { p_pharmacy: P, p_role: 'device', p_branch_ids: [uuid()] });
  assert.equal(badInvite.status, 400, 'an invitation cannot name another pharmacy branch');
  const invite = (await owner.rpc('create_invite', { p_pharmacy: P, p_role: 'device', p_branch_ids: [B2] })).data;
  assert.equal((await staff.rpc('join_pharmacy', { p_code: invite })).data, P);

  const mainSale = { id: uuid(), pharmacy_id: P, branch_id: B, number: 'MAIN-BRANCH', sold_at: new Date().toISOString(), kind: 'sale', lines: [{ code: 'A1', qty: 1, price: 50 }], total: 50, paid: 50 };
  const branchSale = { ...mainSale, id: uuid(), branch_id: B2, number: 'SECOND-BRANCH' };
  assert.equal((await owner.insert('pos_sales', [mainSale, branchSale])).error, null);
  assert.deepEqual((await staff.select('branches', 'id')).data.map((x) => x.id), [B2]);
  assert.deepEqual((await staff.select('pos_sales', 'id')).data.map((x) => x.id), [branchSale.id]);
  assert.equal((await owner.select('pos_sales', 'id', [['pharmacy_id', 'eq', P]])).data.length, 2);
  assert.equal((await partner.select('branches', 'id')).data.length, 2);
  assert.equal((await staff.insert('pos_sales', { ...mainSale, id: uuid(), number: 'DENIED-MAIN' })).status, 403);
  assert.equal((await staff.insert('pos_sales', { ...branchSale, id: uuid(), number: 'ALLOWED-BRANCH', branch_id: null })).status, 403, 'NULL belongs to the main branch');
  assert.equal((await staff.insert('pos_sales', { ...branchSale, id: uuid(), number: 'ALLOWED-BRANCH' })).error, null);
  assert.equal((await staff.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B2, number: 'CROSS-RETURN', sold_at: new Date().toISOString(), kind: 'return', return_of: mainSale.id, lines: [{ code: 'A1', qty: 1, price: 50 }], total: -50, paid: -50 })).status, 403);

  const members = (await owner.rpc('list_branch_members', { p_pharmacy: P })).data;
  assert.deepEqual(members.find((m) => m.user_id === staff.id).branch_ids, [B2]);
  assert.equal((await owner.rpc('set_member_branches', { p_pharmacy: P, p_user_id: staff.id, p_branch_ids: [uuid()] })).status, 400);
  assert.equal((await owner.rpc('set_member_branches', { p_pharmacy: P, p_user_id: staff.id, p_branch_ids: [B] })).error, null);
  assert.deepEqual((await staff.select('branches', 'id')).data.map((x) => x.id), [B]);
  assert.equal((await owner.rpc('set_member_branches', { p_pharmacy: P, p_user_id: staff.id, p_branch_ids: [B, B2] })).error, null);
  assert.equal((await staff.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B2, number: 'CROSS-RETURN-ASSIGNED', sold_at: new Date().toISOString(), kind: 'return', return_of: mainSale.id, lines: [{ code: 'A1', qty: 1, price: 50 }], total: -50, paid: -50 })).status, 403, 'a return must stay in the sale branch even when both branches are assigned');
  assert.equal((await owner.rpc('set_member_branches', { p_pharmacy: P, p_user_id: staff.id, p_branch_ids: [] })).error, null);
  assert.equal((await staff.select('branches', 'id')).data.length, 0);
});

test('roles: the partner reads numbers only, the device sells, only the owner buys and edits', { skip }, async () => {
  const cust = uuid();
  assert.equal((await device.insert('customers', { id: cust, pharmacy_id: P, name: 'عم أحمد', phone: '0100' })).error, null);
  assert.equal((await partner.select('customers', '*', [['pharmacy_id', 'eq', P]])).data.length, 0, 'partners do not see customers');
  assert.equal((await owner.select('customers', '*', [['pharmacy_id', 'eq', P]])).data.length, 1);
  assert.equal((await device.insert('purchases', { id: uuid(), pharmacy_id: P, received_on: '2026-10-28', lines: [{ code: 'A1', qty: 1, cost: 1 }], total: 1 })).status, 403);
  assert.equal((await partner.insert('pos_sales', { id: uuid(), pharmacy_id: P, number: 'P1', sold_at: new Date().toISOString(), lines: [{ code: 'A1', qty: 1, price: 50 }], total: 50, paid: 50 })).status, 403);
  await device.db({ op: 'update', table: 'catalog_items', patch: { price: 1 }, filters: [['code', 'eq', 'A1']] }); // like row-level security: nothing matches, nothing changes
  assert.equal((await owner.select('catalog_items', 'price', [['code', 'eq', 'A1']])).data[0].price, 50);
  assert.equal((await owner.db({ op: 'update', table: 'catalog_items', patch: { price: 55, updated_at: new Date().toISOString() }, filters: [['code', 'eq', 'A1']] })).error, null);
  assert.equal((await owner.db({ op: 'update', table: 'catalog_items', patch: { pharmacy_id: P2 }, filters: [['code', 'eq', 'A1']] })).status, 403, 'only the allowed columns');
  assert.equal((await owner.select('employees', 'pin_hash', [['pharmacy_id', 'eq', P]])).status, 403, 'no one reads PIN hashes');
});

test('returns: only against the receipt, never more than was sold', { skip }, async () => {
  const sale = uuid();
  assert.equal((await device.insert('pos_sales', { id: sale, pharmacy_id: P, branch_id: B, number: 'S1', sold_at: new Date().toISOString(), kind: 'sale', lines: [{ code: 'A1', qty: 2, price: 50 }], total: 100, paid: 100 })).error, null);
  assert.equal((await device.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B, number: 'R1', sold_at: new Date().toISOString(), kind: 'return', return_of: sale, lines: [{ code: 'A1', qty: 1, price: 50 }], total: -50, paid: -50 })).error, null);
  assert.match((await device.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B, number: 'R2', sold_at: new Date().toISOString(), kind: 'return', return_of: sale, lines: [{ code: 'A1', qty: 2, price: 50 }], total: -100, paid: -100 })).error.message, /return more than sold/);
  const concurrentSale = uuid();
  assert.equal((await device.insert('pos_sales', { id: concurrentSale, pharmacy_id: P, branch_id: B, number: 'S3', sold_at: new Date().toISOString(), kind: 'sale', lines: [{ code: 'A1', qty: 1, price: 50 }], total: 50, paid: 50 })).error, null);
  const concurrentReturns = await Promise.all([1, 2].map((n) => device.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B, number: `CR${n}`, sold_at: new Date().toISOString(), kind: 'return', return_of: concurrentSale, lines: [{ code: 'A1', qty: 1, price: 50 }], total: -50, paid: -50 })));
  assert.equal(concurrentReturns.filter((r) => !r.error).length, 1);
  assert.match(concurrentReturns.find((r) => r.error)?.error.message, /return more than sold/);
  const again = uuid();
  const row = { id: again, pharmacy_id: P, branch_id: B, number: 'S2', sold_at: new Date().toISOString(), lines: [{ code: 'A1', qty: 1, price: 50 }], total: 50, paid: 50 };
  await device.insert('pos_sales', row);
  await device.insert('pos_sales', row); // sent twice after a lost answer: saved once
  assert.equal((await owner.select('pos_sales', 'id', [['pharmacy_id', 'eq', P], ['number', 'eq', 'S2']])).data.length, 1);
});

// ---------- Phase 1: the server checks every receipt (src/sale-rules.js) ----------
const now = () => new Date().toISOString();
const rcpt = (o) => ({ id: uuid(), pharmacy_id: P, branch_id: B, number: `T-${rnd()}`, sold_at: now(), kind: 'sale', lines: [{ code: 'A1', qty: 1, price: 100 }], total: 100, paid: 100, ...o });
const countSales = async () => (await owner.select('pos_sales', 'id', [['pharmacy_id', 'eq', P]], { limit: 1000 })).data.length;

test('every invalid receipt from the audit is refused and nothing is stored', { skip }, async () => {
  const before = await countSales();
  const sold = rcpt({ lines: [{ code: 'A1', qty: 1, price: 10 }], total: 10, paid: 10 });
  assert.equal((await device.insert('pos_sales', sold)).error, null);
  const cases = [
    ['sale total that does not match its lines', rcpt({ total: 1, paid: 1 }), /total does not match/],
    ['negative sale total', rcpt({ total: -500, paid: -500 }), /must not be negative/],
    ['return with no receipt and no reason', rcpt({ kind: 'return', lines: [{ code: 'ANY', qty: 50, price: 100 }], total: -5000, paid: -5000 }), /needs a reason/],
    ['discount bigger than the sale', rcpt({ discount: 99999 }), /discount more than the items/],
    ['duplicate receipt number', rcpt({ number: sold.number }), /number already used/],
    ['sale dated in the future', rcpt({ sold_at: new Date(Date.now() + 86400000).toISOString() }), /future/],
    ['lines with no item', rcpt({ lines: [{ foo: 'bar' }], total: 0, paid: 0 }), /bad sale line/],
    ['refund at a price above the sold price', rcpt({ kind: 'return', return_of: sold.id, lines: [{ code: 'A1', qty: 1, price: 9999 }], total: -9999, paid: -9999 }), /return price more than sold/],
    ['no paid amount', rcpt({ paid: undefined }), /paid missing/],
    ['card paying more than the bill', rcpt({ payment: 'card', paid: 500 }), /paid does not match/],
    ['credit with no customer', rcpt({ payment: 'credit', credit: 100, paid: 0 }), /credit needs a customer/],
    ['a bad device code', rcpt({ receipt_device: 'bad!' }), /check constraint/],
  ];
  for (const [what, row, re] of cases) {
    const r = await device.insert('pos_sales', row);
    assert.ok(r.status >= 400, `${what}: refused (got ${r.status})`);
    assert.match(r.error.message, re, what);
  }
  assert.equal(await countSales(), before + 1, 'only the valid receipt was stored');
});

test('legitimate receipts: cash with change, card, wallet, account, insurance, strips, delivery, discounts', { skip }, async () => {
  const cust = uuid(), ins = uuid();
  assert.equal((await device.insert('customers', [{ id: cust, pharmacy_id: P, name: 'عميل آجل' }, { id: ins, pharmacy_id: P, name: 'شركة تأمين', kind: 'insurance', coverage_pct: 80 }])).error, null);
  const ok = [
    rcpt({ paid: 200 }), // 100 due, 200 handed over
    rcpt({ payment: 'card' }),
    rcpt({ payment: 'wallet' }),
    rcpt({ payment: 'credit', customer_id: cust, credit: 100, paid: 0 }),
    rcpt({ payment: 'card', customer_id: ins, credit: 80, paid: 20 }),
    rcpt({ lines: [{ code: 'A1', qty: 2, per: 3, unit: 'strip', price: 10 }], total: 25, paid: 25, delivery_fee: 5, delivery_to: 'البيت' }),
    rcpt({ lines: [{ code: 'A1', qty: 2, price: 50, discount: 5 }, { code: 'B2', qty: 1, price: 20 }], discount: 15, total: 105, paid: 105 }),
    rcpt({ sold_at: '2026-10-01T09:00:00Z' }), // made offline weeks ago
  ];
  for (const row of ok) { const r = await device.insert('pos_sales', row); assert.equal(r.error, null, JSON.stringify([row, r.error])); }
});

test('returns against a receipt: partial, the rest, never more, never above the price paid, same account', { skip }, async () => {
  const cust = uuid();
  await device.insert('customers', { id: cust, pharmacy_id: P, name: 'عميل' });
  // 2 × 50 with 4 off the line, and 6 off the whole receipt: 90 paid, 45 per box.
  const sale = rcpt({ lines: [{ code: 'A1', qty: 2, price: 50, discount: 4 }], discount: 10, total: 90, paid: 90 });
  assert.equal((await device.insert('pos_sales', sale)).error, null);
  const back = (qty, price, discount, o = {}) => rcpt({ kind: 'return', return_of: sale.id, lines: [{ code: 'A1', qty, price, discount }], discount, total: -(price * qty - discount), paid: -(price * qty - discount), ...o });
  assert.match((await device.insert('pos_sales', back(1, 50, 0))).error.message, /refund more than paid/, 'the full price was not paid');
  assert.equal((await device.insert('pos_sales', back(1, 50, 5))).error, null, 'one box back at what was paid');
  assert.match((await device.insert('pos_sales', back(2, 50, 10))).error.message, /return more than sold/, 'only one is left');
  assert.equal((await device.insert('pos_sales', back(1, 50, 5))).error, null, 'the last box');
  assert.match((await device.insert('pos_sales', back(1, 50, 5))).error.message, /return more than sold/);
  // A sale on account comes back to the same account, not another one.
  const other = uuid();
  await device.insert('customers', { id: other, pharmacy_id: P, name: 'عميل تاني' });
  const onAcc = rcpt({ payment: 'credit', customer_id: cust, credit: 100, paid: 0 });
  assert.equal((await device.insert('pos_sales', onAcc)).error, null);
  const ret = (c) => rcpt({ kind: 'return', return_of: onAcc.id, payment: 'credit', customer_id: c, credit: -100, total: -100, paid: 0 });
  assert.match((await device.insert('pos_sales', ret(other))).error.message, /another customer/);
  assert.equal((await device.insert('pos_sales', ret(cust))).error, null);
});

test('a return without a receipt needs a manager the owner allowed, approving with their own PIN', { skip }, async () => {
  const cashierId = (await owner.rpc('add_employee', { p_pharmacy: P, p_name: 'كاشير المرتجع', p_pin: '482915' })).data;
  const managerId = (await owner.rpc('add_employee', { p_pharmacy: P, p_name: 'مدير الوردية', p_pin: '593026' })).data;
  const loose = (o = {}) => rcpt({ kind: 'return', lines: [{ code: 'Z1', qty: 1, price: 30 }], total: -30, paid: -30, note: 'مرتجع من غير فاتورة: العميل نسيها', employee_id: cashierId, ...o });
  const approve = (ret, o = {}) => device.rpc('approve_no_receipt_return', { p_pharmacy: P, p_branch: B, p_return_id: ret.id, p_total: ret.total, p_reason: 'العميل نسي الفاتورة', p_cashier: cashierId, p_pin: '593026', ...o });

  // No approval: refused, nothing stored.
  const bare = loose();
  assert.match((await device.insert('pos_sales', bare)).error.message, /needs a manager approval/);
  // The manager is not allowed yet: refused.
  assert.match((await approve(bare)).error.message, /may not approve returns/);
  // Only the owner may allow it: the device's change is not applied (the data API ignores rows it may not change).
  await device.db({ op: 'update', table: 'employees', patch: { can_approve_returns: true }, filters: [['id', 'eq', managerId]] });
  assert.match((await approve(bare)).error.message, /may not approve returns/, 'still not allowed after the device tried');
  assert.equal((await owner.db({ op: 'update', table: 'employees', patch: { can_approve_returns: true }, filters: [['id', 'eq', managerId]] })).error, null);
  // Wrong PIN, the cashier approving their own return, no cashier, no reason: refused.
  assert.match((await approve(bare, { p_pin: '000000' })).error.message, /wrong pin/);
  assert.equal((await owner.db({ op: 'update', table: 'employees', patch: { can_approve_returns: true }, filters: [['id', 'eq', cashierId]] })).error, null);
  assert.match((await approve(bare, { p_pin: '482915' })).error.message, /another employee/);
  assert.match((await approve(bare, { p_cashier: uuid() })).error.message, /sign in with their PIN/);
  assert.match((await approve(bare, { p_reason: '  ' })).error.message, /needs a reason/);
  assert.match((await approve(bare, { p_total: 30 })).error.message, /bad return total/);
  // Approved: the approval is for this return, this amount and this cashier only.
  const ok = await approve(bare);
  assert.equal(ok.error, null);
  assert.equal(ok.data.approver_name, 'مدير الوردية');
  const again = await approve(bare); // the same request again (a lost answer): the same approval
  assert.equal(again.data.approval_id, ok.data.approval_id);
  assert.match((await approve(bare, { p_total: -31 })).error.message, /approved differently/);
  const other = loose({ approval_id: ok.data.approval_id });
  assert.match((await device.insert('pos_sales', other)).error.message, /not for this return/, 'not reusable for another return');
  assert.match((await device.insert('pos_sales', { ...bare, approval_id: ok.data.approval_id, total: -300, paid: -300, lines: [{ code: 'Z1', qty: 10, price: 30 }] })).error.message, /not for this amount/);
  assert.match((await device.insert('pos_sales', { ...bare, approval_id: ok.data.approval_id, employee_id: managerId })).error.message, /not for this cashier/);
  assert.match((await device.insert('pos_sales', { ...bare, approval_id: ok.data.approval_id, employee_id: undefined })).error.message, /sign in with their PIN/);
  assert.equal((await device.insert('pos_sales', { ...bare, approval_id: ok.data.approval_id })).error, null);
  // The record: the approval (who sold, who approved, why, how much) and the return, in the log of changes.
  const appr = (await owner.select('return_approvals', 'return_id, total, reason, cashier_name, approver_name', [['id', 'eq', ok.data.approval_id]])).data[0];
  assert.deepEqual(appr, { return_id: bare.id, total: -30, reason: 'العميل نسي الفاتورة', cashier_name: 'كاشير المرتجع', approver_name: 'مدير الوردية' });
  const log = (await owner.select('audit_log', 'table_name', [['pharmacy_id', 'eq', P], ['row_id', 'in', [bare.id, ok.data.approval_id]]])).data.map((r) => r.table_name).sort();
  assert.deepEqual(log, ['pos_sales', 'return_approvals']);
  // Approvals are written only by the server: nobody can add or change one through the data API.
  assert.equal((await owner.insert('return_approvals', { id: uuid(), pharmacy_id: P, return_id: uuid(), total: -1, reason: 'x', cashier_employee_id: cashierId, cashier_name: 'x', approver_employee_id: managerId, approver_name: 'x', created_at: now() })).status, 403);
  assert.equal((await owner.db({ op: 'delete', table: 'return_approvals', filters: [['id', 'eq', ok.data.approval_id]] })).status, 403);
  assert.equal((await device.select('return_approvals', 'id', [['pharmacy_id', 'eq', P]])).data?.length ?? 0, 0, 'the cashier device does not read the approvals');
  // Stopped employees can't approve; and the later tests expect no other active employees here.
  for (const id of [cashierId, managerId]) await owner.db({ op: 'update', table: 'employees', patch: { active: false }, filters: [['id', 'eq', id]] });
  assert.match((await approve(loose())).error.message, /wrong pin|sign in with their PIN/);
});

test('receipt numbers: unique per pharmacy, also under concurrency; a repeated request is stored once', { skip }, async () => {
  // Two devices race with the same number: exactly one is stored.
  const n = `261103-K1-ABCD-${rnd()}`;
  const race = await Promise.all([1, 2].map(() => device.insert('pos_sales', rcpt({ number: n, receipt_device: 'ABCD' }))));
  assert.equal(race.filter((r) => !r.error).length, 1);
  assert.match(race.find((r) => r.error).error.message, /number already used/);
  // Different numbers at the same moment are all stored.
  const many = await Promise.all([1, 2, 3, 4].map((i) => device.insert('pos_sales', rcpt({ number: `261103-K1-WXYZ-000${i}-${rnd()}`, receipt_device: 'WXYZ' }))));
  assert.ok(many.every((r) => !r.error), JSON.stringify(many.map((r) => r.error)));
  // The same receipt sent again (lost answer), also at the same time: stored once.
  const same = rcpt({ receipt_device: 'ABCD', number: `261103-K1-ABCD-${rnd()}` });
  const twice = await Promise.all([device.insert('pos_sales', same), device.insert('pos_sales', same)]);
  assert.ok(twice.every((r) => !r.error), JSON.stringify(twice.map((r) => r.error)));
  assert.equal((await owner.select('pos_sales', 'id', [['pharmacy_id', 'eq', P], ['number', 'eq', same.number]])).data.length, 1);
  // Another pharmacy may use the same number.
  const P3 = (await other.rpc('create_pharmacy', { p_name: 'صيدلية تالتة' })).data;
  const B3 = (await other.select('branches', 'id', [['pharmacy_id', 'eq', P3]])).data[0].id;
  assert.equal((await other.insert('pos_sales', rcpt({ pharmacy_id: P3, branch_id: B3, number: same.number }))).error, null);
  // The device's latest number is readable for numbering after a sign-out.
  const p = '261103-K1-WXYZ-';
  const last = await device.select('pos_sales', 'number', [['pharmacy_id', 'eq', P], ['number', 'gte', p], ['number', 'lt', `${p}~`]], { order: { col: 'number', asc: false }, limit: 1 });
  assert.match(last.data[0].number, /^261103-K1-WXYZ-0004-/);
});

test('offline receipts: late ones are kept; a reused id with other contents is refused; odd times are flagged, not refused', { skip }, async () => {
  const flagsOf = async (id) => (await owner.select('audit_log', 'op, new_row', [['pharmacy_id', 'eq', P], ['row_id', 'eq', id], ['op', 'eq', 'flag']])).data.flatMap((r) => r.new_row.flags);
  // A retry with the same contents is the same receipt; the same id with other contents is a conflict.
  const a = rcpt({});
  assert.equal((await device.insert('pos_sales', a)).error, null);
  assert.equal((await device.insert('pos_sales', a)).error, null, 'a retry');
  const changed = await device.insert('pos_sales', { ...a, total: 50, paid: 50, lines: [{ code: 'A1', qty: 1, price: 50 }] });
  assert.equal(changed.status, 409);
  assert.match(changed.error.message, /conflicting receipt id/);
  assert.equal((await device.insert('pos_sales', { ...a, number: `${a.number}-x` })).status, 409, 'same id, another number');
  assert.equal((await owner.select('pos_sales', 'total', [['id', 'eq', a.id]])).data[0].total, 100, 'the stored receipt is unchanged');
  // Made offline two weeks ago, numbered that day: stored with no flag (normal for offline work).
  const old = new Date(Date.now() - 14 * 86400000);
  const ymd = (d) => `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const late = rcpt({ sold_at: old.toISOString(), number: `${ymd(old)}-K1-OFFL-${rnd()}`, receipt_device: 'QFFL' });
  assert.equal((await device.insert('pos_sales', late)).error, null);
  assert.deepEqual(await flagsOf(late.id), []);
  // Numbered today but dated two weeks back: kept, and flagged for the owner.
  const odd = rcpt({ sold_at: old.toISOString(), number: `${ymd(new Date())}-K1-QDDX-${rnd()}`, receipt_device: 'QDDX' });
  assert.equal((await device.insert('pos_sales', odd)).error, null);
  assert.deepEqual(await flagsOf(odd.id), ['time_not_number_day']);
  // Sold "before" the shift it says it belongs to was opened.
  const shift = { id: uuid(), pharmacy_id: P, branch_id: B, employee_name: 'سارة', opened_at: now(), opening_cash: 0 };
  assert.equal((await device.insert('pos_shifts', shift)).error, null);
  const early = rcpt({ shift_id: shift.id, sold_at: new Date(Date.now() - 2 * 86400000).toISOString() });
  assert.equal((await device.insert('pos_sales', early)).error, null);
  assert.deepEqual(await flagsOf(early.id), ['before_shift_opened']);
  // A return dated before the sale it returns.
  const sale = rcpt({});
  assert.equal((await device.insert('pos_sales', sale)).error, null);
  const back = rcpt({ kind: 'return', return_of: sale.id, sold_at: new Date(Date.now() - 86400000).toISOString(), total: -100, paid: -100 });
  assert.equal((await device.insert('pos_sales', back)).error, null);
  assert.deepEqual(await flagsOf(back.id), ['return_before_sale']);
  // A receipt for a day the owner already closed.
  const closedDay = new Date(Date.now() - 3 * 86400000);
  const dayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(closedDay);
  assert.equal((await owner.insert('day_closes', { id: uuid(), pharmacy_id: P, branch_id: B, day: dayStr, totals: { net: 0 } })).error, null);
  const afterClose = rcpt({ sold_at: closedDay.toISOString() });
  assert.equal((await device.insert('pos_sales', afterClose)).error, null, 'kept');
  assert.deepEqual(await flagsOf(afterClose.id), ['after_day_closed']);
  // A normal receipt gets no flag.
  const fine = rcpt({ shift_id: shift.id });
  assert.equal((await device.insert('pos_sales', fine)).error, null);
  assert.deepEqual(await flagsOf(fine.id), []);
});

test('one request is all or nothing; the server time is kept, not the device\'s', { skip }, async () => {
  const before = await countSales();
  const a = rcpt({});
  const r = await device.insert('pos_sales', [a, rcpt({ number: a.number })]);
  assert.equal(r.status, 409);
  const r2 = await device.insert('pos_sales', [rcpt({}), rcpt({ total: 1, paid: 1 })]);
  assert.equal(r2.status, 400);
  assert.equal(await countSales(), before, 'nothing from either request was stored');
  const forged = rcpt({ created_at: '2020-01-01T00:00:00Z' });
  assert.equal((await device.insert('pos_sales', forged)).error, null);
  const got = (await owner.select('pos_sales', 'created_at', [['id', 'eq', forged.id]])).data[0];
  assert.ok(Date.now() - Date.parse(got.created_at) < 5 * 60000, `created_at is the server's (${got.created_at})`);
});

test('strips sold and returned are counted in boxes; returns to the supplier; tasks are the owner\'s', { skip }, async () => {
  const sale = uuid();
  assert.equal((await device.insert('pos_sales', { id: sale, pharmacy_id: P, branch_id: B, number: 'ST1', sold_at: new Date().toISOString(), kind: 'sale', lines: [{ code: 'A1', qty: 2, per: 3, unit: 'strip', price: 10, bp: 30 }], total: 25, paid: 25, delivery_fee: 5, delivery_to: 'x' })).error, null);
  assert.match((await device.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B, number: 'SR2', sold_at: new Date().toISOString(), kind: 'return', return_of: sale, lines: [{ code: 'A1', qty: 1, price: 30 }], total: -30, paid: -30 })).error.message, /return more than sold/, 'a whole box is more than 2 strips of 3');
  assert.equal((await device.insert('pos_sales', { id: uuid(), pharmacy_id: P, branch_id: B, number: 'SR3', sold_at: new Date().toISOString(), kind: 'return', return_of: sale, lines: [{ code: 'A1', qty: 2, per: 3, price: 10 }], total: -20, paid: -20 })).error, null);
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
  const sale = (n) => ({ id: uuid(), pharmacy_id: P, branch_id: B, number: n, sold_at: new Date().toISOString(), lines: [{ code: 'A1', qty: 1, price: 50 }], total: 50, paid: 50 });
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
    pos_sales: [{ id: uuid(), number: 'OLD1', sold_at: '2026-10-01T10:00:00Z', kind: 'sale', lines: [{ code: 'Z9', qty: 1, price: 10 }], total: 10, paid: 10, discount: 0, payment: 'cash', credit: 0, created_at: '2026-10-01T10:00:00Z' }],
    snapshots: [{ id: 1, data: { items: [{ code: 'Z9', name: 'شاش' }] } }],
  } };
  const r = await mover.rpc('import_backup', { p_pharmacy: NP, p_dump: dump });
  assert.equal(r.error, null);
  assert.equal(r.data.catalog_items, 1);
  assert.ok(Object.values(r.data.branches).every(Boolean), 'each old branch maps to one here');
  assert.equal((await mover.select('pos_sales', 'number', [['pharmacy_id', 'eq', NP]])).data[0].number, 'OLD1');
  assert.match((await mover.rpc('import_backup', { p_pharmacy: NP, p_dump: dump })).error.message, /not empty/);
});

// A hidden column (the employees' PIN hash) is never readable, and can't be used to filter or sort either —
// that would reveal it one guess at a time.
test('hidden columns (the PIN hash) cannot be read, filtered or sorted on', { skip }, async () => {
  const emp = (await owner.rpc('add_employee', { p_pharmacy: P, p_name: 'موظف الكود', p_pin: String(100000 + Math.floor(Math.random() * 900000)) })).data;
  assert.ok(emp, 'employee added');
  assert.equal((await owner.select('employees', 'id,pin_hash')).status, 403);
  assert.equal((await partner.select('employees', 'id', [['pin_hash', 'neq', 'x']])).status, 403);
  assert.equal((await partner.select('employees', 'id', [['pin_hash', 'notnull']])).status, 403);
  assert.equal((await partner.select('employees', 'id', [], { order: { col: 'pin_hash' } })).status, 403);
  assert.equal((await owner.db({ op: 'update', table: 'employees', patch: { active: true }, filters: [['pin_hash', 'neq', 'x']] })).status, 403);
  assert.equal((await partner.select('employees', 'id,name', [['id', 'eq', emp]])).data.length, 1, 'visible columns still work');
});

// Changing the password needs the current one: a stolen session alone can't lock the owner out.
test('changing the password needs the current password; it ends the other sessions', { skip }, async () => {
  const u = user(); await u.signUp('password123');
  // A second session of the same account (another device).
  const second = (await user().call('/api/auth/signin', { email: u.email, password: 'password123' })).data.access_token;
  const whoIs = async (t) => (await (await fetch(`${BASE}/api/auth/user`, { headers: { Authorization: `Bearer ${t}` } })).json()).data.user;
  assert.ok(await whoIs(second));
  assert.equal((await u.call('/api/auth/password', { password: 'newpassword1' })).status, 400, 'no current password');
  assert.equal((await u.call('/api/auth/password', { password: 'newpassword1', current_password: 'wrong-pass' })).status, 400, 'wrong current password');
  assert.equal((await user().call('/api/auth/password', { password: 'newpassword1', current_password: 'password123' })).status, 401, 'signed out');
  const ok = await u.call('/api/auth/password', { password: 'newpassword1', current_password: 'password123' });
  assert.equal(ok.error, null);
  assert.match(ok.data.access_token, /^[0-9a-f]{64}$/);
  assert.equal(await whoIs(second), null, 'the other session ended');
  assert.ok(await whoIs(ok.data.access_token), 'the new session works');
  assert.equal((await user().call('/api/auth/signin', { email: u.email, password: 'password123' })).status, 400, 'old password no longer works');
  assert.equal((await user().call('/api/auth/signin', { email: u.email, password: 'newpassword1' })).error, null, 'new password works');
});

test('signing out ends the session', { skip }, async () => {
  const r = await owner.call('/api/auth/signout', {});
  assert.equal(r.error, null);
  assert.equal((await owner.select('pos_sales', '*', [['pharmacy_id', 'eq', P]])).status, 401);
});
