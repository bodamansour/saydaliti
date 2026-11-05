// Treasury moves, voiding a receipt, two-step sign-in, forgotten password and usage counts, on a local
// Worker (wrangler dev --local, with EMAIL_OUTBOX=dev so reset emails are kept in the database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totpAt } from '../src/totp.js';

const BASE = process.env.WORKER_URL;
const skip = !BASE && 'WORKER_URL not set (start the local Worker first)';
const rnd = () => Math.random().toString(36).slice(2, 10);
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function user(email = `f-${rnd()}@test.local`) {
  let token = null;
  const call = async (path, body, method = 'POST') => {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) });
    return { status: r.status, ...(await r.json()) };
  };
  const u = {
    email,
    async signUp(pw = 'password123') { const r = await call('/api/auth/signup', { email, password: pw }); token = r.data?.access_token; return r; },
    async signIn(password, code) { const r = await call('/api/auth/signin', { email, password, ...(code ? { code } : {}) }); if (r.data?.access_token) token = r.data.access_token; return r; },
    rpc: (name, args) => call(`/api/rpc/${name}`, args),
    insert: (table, rows) => call('/api/db', { op: 'upsert', table, rows, ignoreDuplicates: true }),
    select: (table, cols, filters = []) => call('/api/db', { op: 'select', table, cols, filters }),
    call, setToken: (t) => { token = t; }, token: () => token,
  };
  return u;
}
const codeNow = (secret) => totpAt(secret, Math.floor(Date.now() / 30000));

let owner, device, P, B;
test('setup: a pharmacy with a device', { skip }, async () => {
  owner = user(); await owner.signUp();
  P = (await owner.rpc('create_pharmacy', { p_name: 'صيدلية الخزينة' })).data;
  B = (await owner.select('branches', 'id', [['pharmacy_id', 'eq', P]])).data[0].id;
  device = user(); await device.signUp();
  assert.equal((await device.rpc('join_pharmacy', { p_code: (await owner.rpc('create_invite', { p_pharmacy: P, p_role: 'device' })).data })).data, P);
});

test('treasury moves: the owner records them, a device can not read or add them', { skip }, async () => {
  const row = { id: uuid(), pharmacy_id: P, moved_at: now(), kind: 'count', amount: 1500, note: 'عدّ الخزنة' };
  assert.equal((await owner.insert('cash_moves', row)).error, null);
  assert.equal((await owner.insert('cash_moves', { ...row, id: uuid(), kind: 'adjust', amount: -20 })).error, null, 'a correction may be negative');
  assert.match((await owner.insert('cash_moves', { ...row, id: uuid(), kind: 'gift' })).error.message, /kind/);
  assert.equal((await device.insert('cash_moves', { ...row, id: uuid() })).status, 403);
  assert.equal((await device.select('cash_moves', 'id')).data.length, 0);
  assert.equal((await owner.select('cash_moves', 'id, kind, amount', [['pharmacy_id', 'eq', P]])).data.length, 2);
});

test('voiding a receipt: everything left, by the owner or with a manager approval', { skip }, async () => {
  const sale = { id: uuid(), pharmacy_id: P, branch_id: B, number: `V-${rnd()}`, sold_at: now(), kind: 'sale', lines: [{ code: 'A1', qty: 2, price: 50 }, { code: 'B1', qty: 1, price: 20 }], total: 120, paid: 120 };
  assert.equal((await device.insert('pos_sales', sale)).error, null);
  const voidOf = (lines, total, o = {}) => ({ id: uuid(), pharmacy_id: P, branch_id: B, number: `VR-${rnd()}`, sold_at: now(), kind: 'return', return_of: sale.id, is_void: true, lines, total: -total, paid: -total, note: 'إلغاء: غلطة في الفاتورة', ...o });
  const all = voidOf(sale.lines, 120);
  // Part of the receipt is not a void.
  assert.match((await owner.insert('pos_sales', voidOf([{ code: 'A1', qty: 2, price: 50 }], 100))).error.message, /everything left/);
  // A device needs a manager's approval for this return.
  const cashier = (await owner.rpc('add_employee', { p_pharmacy: P, p_name: 'كاشير', p_pin: '731904' })).data;
  const manager = (await owner.rpc('add_employee', { p_pharmacy: P, p_name: 'مدير', p_pin: '846102' })).data;
  assert.match((await device.insert('pos_sales', { ...all, employee_id: cashier })).error.message, /manager approval/);
  await owner.call('/api/db', { op: 'update', table: 'employees', patch: { can_approve_returns: true }, filters: [['id', 'eq', manager]] });
  const ok = await device.rpc('approve_no_receipt_return', { p_pharmacy: P, p_branch: B, p_return_id: all.id, p_total: -120, p_reason: 'إلغاء: غلطة في الفاتورة', p_cashier: cashier, p_pin: '846102' });
  assert.equal(ok.error, null);
  assert.equal((await device.insert('pos_sales', { ...all, employee_id: cashier, approval_id: ok.data.approval_id })).error, null);
  // Nothing is left to return after a void.
  assert.match((await owner.insert('pos_sales', voidOf([{ code: 'B1', qty: 1, price: 20 }], 20, { is_void: false }))).error.message, /return more than sold/);
  // The owner voids without an approval.
  const sale2 = { ...sale, id: uuid(), number: `V-${rnd()}` };
  assert.equal((await device.insert('pos_sales', sale2)).error, null);
  assert.equal((await owner.insert('pos_sales', { ...voidOf(sale2.lines, 120), return_of: sale2.id })).error, null);
  // A void must point at a receipt.
  assert.match((await owner.insert('pos_sales', { ...voidOf(sale.lines, 120), return_of: undefined })).error.message, /return of a receipt/);
});

test('two-step sign-in: set up with the password and a code, then every sign-in needs a code', { skip }, async () => {
  const u = user(); await u.signUp();
  assert.equal((await u.call('/api/auth/user', null, 'GET')).data.user.mfa, false);
  assert.match((await u.call('/api/auth/mfa/setup', { current_password: 'wrong' })).error.message, /Current password/);
  const s = await u.call('/api/auth/mfa/setup', { current_password: 'password123' });
  assert.equal(s.error, null); assert.match(s.data.url, /^otpauth:\/\/totp\//);
  assert.match((await u.call('/api/auth/mfa/enable', { code: '000000' })).error.message, /Wrong two-step code/);
  const en = await u.call('/api/auth/mfa/enable', { code: await codeNow(s.data.secret) });
  assert.equal(en.error, null); assert.equal(en.data.recovery.length, 8);
  assert.equal((await u.call('/api/auth/user', null, 'GET')).data.user.mfa, true);
  // Sign-in: the password alone is not enough; a wrong code is refused; the right code works.
  const again = user(u.email);
  const r1 = await again.signIn('password123');
  assert.equal(r1.status, 401); assert.equal(r1.error.code, 'mfa_required'); assert.equal(again.token(), null);
  assert.equal((await again.signIn('password123', '123456')).error.code, 'mfa_invalid');
  assert.equal((await again.signIn('wrong-pass', await codeNow(s.data.secret))).error.code, 'invalid_credentials');
  // A recovery code works once.
  assert.equal((await again.signIn('password123', en.data.recovery[0])).error, null);
  assert.equal((await user(u.email).signIn('password123', en.data.recovery[0])).error.code, 'mfa_invalid', 'a recovery code is used once');
  // Off: needs the password and a code.
  assert.equal((await again.call('/api/auth/mfa/disable', { current_password: 'password123', code: 'nope' })).error.code, 'mfa_invalid');
  assert.equal((await again.call('/api/auth/mfa/disable', { current_password: 'password123', code: en.data.recovery[1] })).data.on, false);
  assert.equal((await user(u.email).signIn('password123')).error, null, 'off again: the password is enough');
});

test('forgotten password: a one-time link by email, no hint whether the account exists', { skip }, async () => {
  const u = user(); await u.signUp('old-password1');
  const anon = user();
  assert.equal((await anon.call('/api/auth/forgot', { email: `nobody-${rnd()}@test.local` })).data.sent, true, 'same answer for an unknown email');
  assert.equal((await anon.call('/api/auth/forgot', { email: u.email })).data.sent, true);
  const mail = (await anon.call(`/api/auth/dev-outbox?email=${encodeURIComponent(u.email)}`, null, 'GET')).data;
  const token = /#reset=([0-9a-f]{64})/.exec(mail.body)[1];
  assert.match((await anon.call('/api/auth/reset', { token, password: 'short' })).error.message, /at least 8/);
  assert.match((await anon.call('/api/auth/reset', { token: 'f'.repeat(64), password: 'new-password1' })).error.message, /not valid/);
  const r = await anon.call('/api/auth/reset', { token, password: 'new-password1' });
  assert.equal(r.error, null); assert.match(r.data.access_token, /^[0-9a-f]{64}$/);
  assert.match((await anon.call('/api/auth/reset', { token, password: 'other-password1' })).error.message, /not valid/, 'the link works once');
  assert.equal((await u.call('/api/auth/user', null, 'GET')).data.user, null, 'old sessions ended');
  assert.equal((await user(u.email).signIn('old-password1')).error.code, 'invalid_credentials');
  assert.equal((await user(u.email).signIn('new-password1')).error, null);
});

test('usage counts are for the app owner only', { skip }, async () => {
  assert.match((await owner.rpc('admin_usage')).error.message, /not allowed/);
});
