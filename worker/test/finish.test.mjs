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
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Want-Token': '1', 'X-Saydaliti': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) });
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
  // The whole pharmacy's cash: an accountant (who may see only some branches) can neither read nor write it.
  const acc = user(); await acc.signUp();
  await acc.rpc('join_pharmacy', { p_code: (await owner.rpc('create_invite', { p_pharmacy: P, p_role: 'accountant' })).data });
  assert.equal((await acc.insert('cash_moves', { ...row, id: uuid() })).status, 403);
  assert.equal((await acc.select('cash_moves', 'id')).data.length, 0);
  // The server keeps the amounts' signs too: only a correction may be negative.
  for (const kind of ['count', 'to_bank', 'from_bank']) assert.ok((await owner.insert('cash_moves', { ...row, id: uuid(), kind, amount: -5 })).error, `${kind} below zero`);
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

test('one-time codes hold under sending them many times at once (reset link, recovery code)', { skip }, async () => {
  // The same reset link, 8 times at the same moment with 8 different passwords: exactly one works.
  const u = user(); await u.signUp('old-password1');
  const anon = user();
  await anon.call('/api/auth/forgot', { email: u.email });
  const token = /#reset=([0-9a-f]{64})/.exec((await anon.call(`/api/auth/dev-outbox?email=${encodeURIComponent(u.email)}`, null, 'GET')).data.body)[1];
  const pws = Array.from({ length: 8 }, (_, i) => `race-password-${i}`);
  const rs = await Promise.all(pws.map((password) => user().call('/api/auth/reset', { token, password })));
  const won = rs.map((r, i) => (r.error ? null : i)).filter((i) => i !== null);
  assert.equal(won.length, 1, `exactly one reset with the same link: ${JSON.stringify(rs.map((r) => r.error?.code ?? 'ok'))}`);
  for (const r of rs) if (r.error) assert.equal(r.error.code, 'reset_invalid');
  assert.equal((await user(u.email).signIn(pws[won[0]])).error, null, 'the password that won is the one set');
  for (const [i, pw] of pws.entries()) if (i !== won[0]) assert.equal((await user(u.email).signIn(pw)).error.code, 'invalid_credentials');
  // The same recovery code, 6 sign-ins at once: exactly one session.
  const m = user(); await m.signUp();
  const s = await m.call('/api/auth/mfa/setup', { current_password: 'password123' });
  const en = await m.call('/api/auth/mfa/enable', { code: await codeNow(s.data.secret) });
  const ins = await Promise.all(Array.from({ length: 6 }, () => user(m.email).signIn('password123', en.data.recovery[0])));
  assert.equal(ins.filter((r) => !r.error).length, 1, `exactly one sign-in with the same recovery code: ${JSON.stringify(ins.map((r) => r.error?.code ?? 'ok'))}`);
  // A successful check releases its reservation, so the order of the losing requests affects the remaining quota.
  for (const r of ins.filter((r) => r.error)) assert.ok(['mfa_invalid', 'over_request_rate_limit'].includes(r.error.code));
  const next = await user(m.email).signIn('password123', en.data.recovery[1]);
  if (next.error) assert.equal(next.error.code, 'over_request_rate_limit');
  else assert.match(next.data.access_token, /^[0-9a-f]{64}$/);
});

test('usage counts are for the app owner only', { skip }, async () => {
  assert.match((await owner.rpc('admin_usage')).error.message, /not allowed/);
});

test('the sign-in is an HttpOnly cookie; a change signed in by the cookie needs the app header (CSRF)', { skip }, async () => {
  const email = `c-${rnd()}@test.local`;
  const r = await fetch(`${BASE}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saydaliti': '1' }, body: JSON.stringify({ email, password: 'password123' }) });
  const j = await r.json();
  assert.equal(j.data.access_token, undefined, 'the page never sees the token');
  assert.equal(j.data.user.email, email);
  const set = r.headers.get('set-cookie');
  assert.match(set, /^sd_session=[0-9a-f]{64};/); assert.match(set, /HttpOnly/); assert.match(set, /Secure/); assert.match(set, /SameSite=Strict/);
  const cookie = set.split(';')[0];
  const get = async () => (await (await fetch(`${BASE}/api/auth/user`, { headers: { Cookie: cookie } })).json()).data.user;
  assert.equal((await get()).email, email, 'reading with the cookie');
  const post = (h = {}) => fetch(`${BASE}/api/rpc/create_pharmacy`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...h }, body: JSON.stringify({ p_name: 'صيدلية الكوكي' }) });
  const forged = await post();
  assert.equal(forged.status, 403, 'a cookie alone can not change anything');
  assert.equal((await forged.json()).error.code, 'csrf');
  assert.equal((await post({ 'X-Saydaliti': '1' })).status, 200);
  // Sign-out ends the session and clears the cookie.
  // Another site can't sign the user out (no app header), and can't sign anyone in either (login CSRF).
  assert.equal((await fetch(`${BASE}/api/auth/signout`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}' })).status, 403);
  assert.equal(await get() !== null, true, 'still signed in after a forged sign-out');
  for (const [h, why] of [[{ 'Content-Type': 'text/plain' }, 'a form (text/plain)'], [{ 'Content-Type': 'application/json' }, 'no app header'], [{ 'X-Saydaliti': '1', 'Content-Type': 'application/x-www-form-urlencoded' }, 'a form with the header']]) {
    for (const what of ['signin', 'signup', 'forgot', 'reset']) {
      const f = await fetch(`${BASE}/api/auth/${what}`, { method: 'POST', headers: h, body: JSON.stringify({ email, password: 'password123' }) });
      assert.equal(f.status, 403, `${what}: ${why}`);
      assert.equal(f.headers.get('set-cookie'), null, `${what}: ${why} sets no cookie`);
    }
  }
  const out = await fetch(`${BASE}/api/auth/signout`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Saydaliti': '1' }, body: '{}' });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(await get(), null);
});

test('an app that still keeps its token moves it into the cookie', { skip }, async () => {
  const u = user(); await u.signUp();
  const r = await fetch(`${BASE}/api/auth/adopt`, { method: 'POST', headers: { Authorization: `Bearer ${u.token()}`, 'Content-Type': 'application/json', 'X-Saydaliti': '1' }, body: '{}' });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal(cookie, `sd_session=${u.token()}`, 'the same session');
  assert.equal((await fetch(`${BASE}/api/auth/adopt`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Saydaliti': '1' }, body: '{}' })).status, 401, 'only from a Bearer token');
});

test('the log of changes: rows can not be changed, and a change made behind the app shows in the check', { skip }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { wranglerBin, WORKER } = await import('../scripts/staging-guard.mjs');
  // The other suites write to the same local database at the same time: a busy database is tried again.
  const sql = (q) => {
    for (let i = 0; ; i++) {
      try { return execFileSync(process.execPath, [wranglerBin(WORKER), 'd1', 'execute', 'saydaliti', '--local', '--command', q], { cwd: WORKER, stdio: 'pipe' }).toString(); }
      catch (e) { if (i < 20 && /SQLITE_BUSY|database is locked/.test(`${e.stdout}${e.stderr}${e.message}`)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); continue; } throw Object.assign(e, { message: `${e.message}\n${e.stdout}${e.stderr}` }); }
    }
  };
  // Something logged: a customer added.
  assert.equal((await owner.insert('customers', { id: uuid(), pharmacy_id: P, name: 'عميل السجل' })).error, null);
  const pending = await owner.rpc('audit_verify', { p_pharmacy: P });
  assert.equal(pending.data.ok, null); assert.equal(pending.data.reason, 'unsealed', 'checking the log never seals it');
  assert.equal((await device.rpc('audit_verify', { p_pharmacy: P })).status, 403, 'owner only');
  assert.equal((await device.rpc('audit_rebaseline', { p_pharmacy: P, p_reason: 'not authorized', p_confirm: 'REBASELINE_AUDIT_ANCHOR' })).status, 403, 'only the owner can rebaseline');
  const baseline = await owner.rpc('audit_rebaseline', { p_pharmacy: P, p_reason: 'Initial local test baseline.', p_confirm: 'REBASELINE_AUDIT_ANCHOR' });
  assert.equal(baseline.data.action, 'rebaselined');
  const ok = await owner.rpc('audit_verify', { p_pharmacy: P });
  assert.equal(ok.data.ok, true); assert.ok(ok.data.rows > 0);
  // The database itself refuses to change or remove a row.
  assert.throws(() => sql(`UPDATE audit_log SET op = 'x' WHERE pharmacy_id = '${P}'`), /append-only/);
  assert.throws(() => sql(`DELETE FROM audit_log WHERE pharmacy_id = '${P}'`), /append-only/);
  // Someone with the database removes the trigger and edits a row: the check finds it.
  sql('DROP TRIGGER audit_log_no_update');
  try {
    sql(`UPDATE audit_log SET new_row = '{"name":"edited"}' WHERE id = (SELECT min(id) FROM audit_log WHERE pharmacy_id = '${P}')`);
    const bad = await owner.rpc('audit_verify', { p_pharmacy: P });
    assert.equal(bad.data.ok, false);
  } finally {
    sql("CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END");
  }
});
