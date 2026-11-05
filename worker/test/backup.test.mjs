// Encrypted server backups through the API (Phase 2 M2), on a local Worker with local D1/R2.
// The restore drill (worker/scripts/restore-drill.mjs) restores into a separate database and checks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.WORKER_URL;
const skip = !BASE && 'WORKER_URL not set (start the local Worker first)';
const rnd = () => Math.random().toString(36).slice(2, 10);
function user() {
  let token = null;
  const call = async (path, body) => { const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Want-Token': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) }); return { status: r.status, ...(await r.json()) }; };
  return { email: `b-${rnd()}@test.local`, async signUp() { token = (await call('/api/auth/signup', { email: this.email, password: 'password123' })).data.access_token; },
    rpc: (n, a) => call(`/api/rpc/${n}`, a), select: (t, c, f = []) => call('/api/db', { op: 'select', table: t, cols: c, filters: f }), insert: (t, rows) => call('/api/db', { op: 'upsert', table: t, rows, ignoreDuplicates: true }) };
}

test('the owner makes a backup and sees the list; nobody else can; the files are not reachable through the API', { skip }, async () => {
  const owner = user(); await owner.signUp();
  const P = (await owner.rpc('create_pharmacy', { p_name: 'صيدلية النسخ' })).data;
  const B = (await owner.select('branches', 'id', [['pharmacy_id', 'eq', P]])).data[0].id;
  await owner.insert('pos_sales', { id: crypto.randomUUID(), pharmacy_id: P, branch_id: B, number: `B-${rnd()}`, sold_at: new Date().toISOString(), lines: [{ code: 'A', qty: 2, price: 10 }], total: 20, paid: 20 });
  await owner.insert('customers', { id: crypto.randomUUID(), pharmacy_id: P, name: 'عميل' });
  const r = await owner.rpc('backup_now', { p_pharmacy: P });
  assert.equal(r.error, null, JSON.stringify(r.error));
  assert.ok(r.data.bytes > 0);
  assert.equal(r.data.counts.pos_sales, 1);
  assert.equal(r.data.counts.customers, 1);
  assert.equal(r.data.counts.users, 1, 'the owner account, so people can sign in after a restore');
  const list = (await owner.rpc('list_backups', { p_pharmacy: P })).data;
  assert.equal(list[0].status, 'ok');
  assert.equal(list[0].summary.money.sales, 20);
  assert.equal(list[0].r2_key, undefined, 'the file location is not handed out');
  // A partner and a cashier device can't make or list backups.
  for (const role of ['partner', 'device']) {
    const u = user(); await u.signUp();
    const code = (await owner.rpc('create_invite', { p_pharmacy: P, p_role: role, ...(role === 'device' ? { p_branch_ids: [B] } : {}) })).data;
    await u.rpc('join_pharmacy', { p_code: code });
    assert.equal((await u.rpc('backup_now', { p_pharmacy: P })).status, 403, role);
    assert.equal((await u.rpc('list_backups', { p_pharmacy: P })).status, 403, role);
  }
  // Another pharmacy's owner can't either.
  const other = user(); await other.signUp(); await other.rpc('create_pharmacy', { p_name: 'تانية' });
  assert.equal((await other.rpc('backup_now', { p_pharmacy: P })).status, 403);
  // The list table is not reachable through the data API.
  assert.equal((await owner.select('backups', 'id')).status, 404);
  // At most 6 backups by hand an hour.
  for (let i = 0; i < 5; i++) assert.equal((await owner.rpc('backup_now', { p_pharmacy: P })).error, null);
  assert.equal((await owner.rpc('backup_now', { p_pharmacy: P })).status, 429);
});
