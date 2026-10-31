// The database functions the app calls by name (rpc), the same ones the Supabase database had:
// pharmacies and branches, employees and attendance, invites, uploads, the cashier's PIN and
// returns, subscriptions and the admin page, and error reports.
import { planOf, readPlans } from '../../src/plans.js';
import { ApiError, requireRole, requireBranch, nowIso, todayIso, uuid, runBatch, blobKey, fromDb } from './db.js';
import { TABLES } from './schema.js';
import { hashPin, sha256, randomHex } from './auth.js';

const signedIn = (ctx) => { if (!ctx.user) throw new ApiError('not signed in', '42501', 401); };
const isAdmin = async (env, ctx) => !!ctx.user && !!(await env.DB.prepare('SELECT 1 FROM app_admins WHERE user_id = ?').bind(ctx.user.id).first());
const needAdmin = async (env, ctx) => { if (!(await isAdmin(env, ctx))) throw new ApiError('not allowed', '42501', 403); };
const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const one = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const recent = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
async function branchIdsOf(env, pharmacyId, ids) {
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some((x) => typeof x !== 'string') || new Set(ids).size !== ids.length) throw new ApiError('bad branches');
  if (ids.length && (await one(env, 'SELECT count(*) AS n FROM branches WHERE pharmacy_id = ? AND id IN (SELECT value FROM json_each(?))', pharmacyId, JSON.stringify(ids))).n !== ids.length) throw new ApiError('unknown branch');
  return ids;
}
const audit = (env, ctx, table, op, before, after) => {
  const r = after || before; const strip = (x) => { if (!x) return null; const { pin_hash, ...rest } = x; return JSON.stringify(rest); };
  return env.DB.prepare('INSERT INTO audit_log (pharmacy_id, at, user_id, table_name, op, row_id, old_row, new_row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(r.pharmacy_id, nowIso(), ctx.user?.id ?? null, table, op, String(r.id), strip(before), strip(after));
};

// The plan limits of a pharmacy (src/plans.js). No plan set = no limits.
async function planFor(env, p) {
  const s = await one(env, 'SELECT plan FROM subscriptions WHERE pharmacy_id = ?', p).catch(() => null);
  const c = await one(env, 'SELECT plans FROM app_config WHERE id = 1').catch(() => null);
  return planOf(s, c?.plans);
}
export { planFor };
async function mainBranch(env, p) { return (await one(env, 'SELECT id FROM branches WHERE pharmacy_id = ? ORDER BY created_at, id LIMIT 1', p))?.id ?? null; }
async function branchOf(env, p, b) {
  if (!b) return mainBranch(env, p);
  if (!(await one(env, 'SELECT 1 FROM branches WHERE id = ? AND pharmacy_id = ?', b, p))) throw new ApiError('unknown branch');
  return b;
}

// Saves an upload (the data goes to R2) and keeps the 10 newest of the branch.
async function storeSnapshot(env, pharmacyId, branchId, userId, data, createdAt = null) {
  if (!data || !Array.isArray(data.items)) throw new ApiError('bad snapshot');
  return storeSnapshotText(env, pharmacyId, branchId, userId, JSON.stringify(data), data.items.length, createdAt);
}
// The same with the data as text, not parsed here: an upload can be several MB, and parsing it would
// take more time than the free Workers plan gives a request. Only its outline is checked.
export async function storeSnapshotText(env, pharmacyId, branchId, userId, text, itemCount, createdAt = null) {
  if (typeof text !== 'string' || text.length > 20 * 1024 * 1024) throw new ApiError('snapshot too large');
  if (!/^\s*\{/.test(text.slice(0, 64)) || !/\}\s*$/.test(text.slice(-64)) || !text.includes('"items":[')) throw new ApiError('bad snapshot');
  const r = await one(env, 'INSERT INTO snapshots (pharmacy_id, branch_id, created_at, created_by, item_count) VALUES (?, ?, ?, ?, ?) RETURNING id',
    pharmacyId, branchId, createdAt && !Number.isNaN(Date.parse(createdAt)) ? new Date(createdAt).toISOString() : nowIso(), userId, Math.max(0, Math.trunc(+itemCount || 0)));
  await env.FILES.put(blobKey('snapshots', r.id), text, { httpMetadata: { contentType: 'application/json' } });
  const old = await all(env, 'SELECT id FROM snapshots WHERE branch_id IS ? AND pharmacy_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 10', branchId, pharmacyId);
  if (old.length) {
    await env.DB.prepare(`DELETE FROM snapshots WHERE id IN (${old.map(() => '?').join(', ')})`).bind(...old.map((o) => o.id)).run();
    await env.FILES.delete(old.map((o) => blobKey('snapshots', o.id)));
  }
  return r.id;
}
export { branchOf };

async function trialFor(env) { return (await one(env, 'SELECT trial_days FROM app_config WHERE id = 1'))?.trial_days ?? 14; }

const INVITE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function inviteCode() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => INVITE_ABC[x % INVITE_ABC.length]).join('');
}

export const RPC = {
  // ---------- Pharmacy ----------
  async create_pharmacy(env, ctx, { p_name }) {
    signedIn(ctx);
    const name = String(p_name || '').trim();
    if (!name) throw new ApiError('name required');
    const p = uuid(), now = nowIso();
    const trial = new Date(Date.now() + (await trialFor(env)) * 86400000).toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO pharmacies (id, name, timezone, settings, created_at) VALUES (?, ?, 'Africa/Cairo', '{}', ?)").bind(p, name.slice(0, 120), now),
      env.DB.prepare("INSERT INTO members (pharmacy_id, user_id, role) VALUES (?, ?, 'owner')").bind(p, ctx.user.id),
      env.DB.prepare('INSERT INTO branches (id, pharmacy_id, name, created_at) VALUES (?, ?, ?, ?)').bind(uuid(), p, 'الفرع الرئيسي', now),
      env.DB.prepare("INSERT INTO subscriptions (pharmacy_id, status, trial_ends, updated_at) VALUES (?, 'trial', ?, ?)").bind(p, trial, now),
    ]);
    return p;
  },
  async add_branch(env, ctx, { p_pharmacy, p_name }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    const name = String(p_name || '').trim();
    if (!name) throw new ApiError('name required');
    const plan = await planFor(env, p_pharmacy);
    if ((await one(env, 'SELECT count(*) AS n FROM branches WHERE pharmacy_id = ?', p_pharmacy)).n >= plan.max_branches) throw new ApiError('plan limit: branches');
    const id = uuid();
    await env.DB.prepare('INSERT INTO branches (id, pharmacy_id, name, created_at) VALUES (?, ?, ?, ?)').bind(id, p_pharmacy, name.slice(0, 80), nowIso()).run();
    return id;
  },
  async save_settings(env, ctx, { p_pharmacy, p_settings }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    if (!p_settings || typeof p_settings !== 'object' || Array.isArray(p_settings)) throw new ApiError('bad settings');
    await env.DB.prepare('UPDATE pharmacies SET settings = ? WHERE id = ?').bind(JSON.stringify(p_settings), p_pharmacy).run();
    return null;
  },
  async save_snapshot(env, ctx, { p_pharmacy, p_data, p_branch = null }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    return storeSnapshot(env, p_pharmacy, await branchOf(env, p_pharmacy, p_branch), ctx.user.id, p_data);
  },
  async create_connector_token(env, ctx, { p_pharmacy, p_branch = null }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    const b = await branchOf(env, p_pharmacy, p_branch);
    const t = `sdl_${randomHex(24)}`;
    await env.DB.batch([
      env.DB.prepare('UPDATE connector_tokens SET revoked = 1 WHERE branch_id IS ? AND pharmacy_id = ? AND revoked = 0').bind(b, p_pharmacy),
      env.DB.prepare('INSERT INTO connector_tokens (pharmacy_id, branch_id, token_hash, created_at, revoked) VALUES (?, ?, ?, ?, 0)').bind(p_pharmacy, b, await sha256(t), nowIso()),
    ]);
    return t;
  },
  // Called by the connector on the pharmacy computer with its token (no account).
  async upload_snapshot(env, ctx, { p_token, p_data, p_data_text }) {
    const ct = await one(env, 'SELECT id, pharmacy_id, branch_id FROM connector_tokens WHERE token_hash = ? AND revoked = 0', await sha256(String(p_token || '')));
    if (!ct) throw new ApiError('invalid token');
    const b = ct.branch_id || await mainBranch(env, ct.pharmacy_id);
    const id = p_data_text !== undefined ? await storeSnapshotText(env, ct.pharmacy_id, b, null, p_data_text, 0) : await storeSnapshot(env, ct.pharmacy_id, b, null, p_data);
    await env.DB.prepare('UPDATE connector_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(), ct.id).run();
    return id;
  },

  // ---------- Invites ----------
  async create_invite(env, ctx, { p_pharmacy, p_role, p_branch_ids }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    if (!['partner', 'device', 'pharmacist', 'accountant', 'stock'].includes(p_role)) throw new ApiError('bad role');
    const branches = p_role === 'partner' ? [] : await branchIdsOf(env, p_pharmacy,
      p_branch_ids === undefined ? [await mainBranch(env, p_pharmacy)].filter(Boolean) : p_branch_ids);
    if (p_role !== 'partner' && !branches.length) throw new ApiError('choose at least one branch');
    let c;
    do c = inviteCode(); while (await one(env, 'SELECT 1 FROM invites WHERE code = ?', c));
    await env.DB.prepare('INSERT INTO invites (code, pharmacy_id, role, branch_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(c, p_pharmacy, p_role, JSON.stringify(branches), nowIso(), new Date(Date.now() + 3 * 86400000).toISOString()).run();
    return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
  },
  // A wrong code returns nothing and is counted: 10 wrong in an hour and the account waits.
  async join_pharmacy(env, ctx, { p_code }) {
    signedIn(ctx);
    if ((await one(env, 'SELECT count(*) AS n FROM invite_attempts WHERE user_id = ? AND at > ?', ctx.user.id, recent(60))).n >= 10) throw new ApiError('too many attempts');
    const c = String(p_code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const i = await one(env, 'SELECT code, pharmacy_id, role, branch_ids FROM invites WHERE code = ? AND used_by IS NULL AND expires_at > ?', c, nowIso());
    if (!i) {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO invite_attempts (user_id, at) VALUES (?, ?)').bind(ctx.user.id, nowIso()),
        env.DB.prepare('DELETE FROM invite_attempts WHERE at < ?').bind(recent(1440)),
      ]);
      return null;
    }
    const plan = await planFor(env, i.pharmacy_id);
    if ((await one(env, 'SELECT count(*) AS n FROM members WHERE pharmacy_id = ?', i.pharmacy_id)).n >= plan.max_users) throw new ApiError('plan limit: users');
    await env.DB.batch([
      env.DB.prepare('INSERT INTO members (pharmacy_id, user_id, role, branch_ids) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(i.pharmacy_id, ctx.user.id, i.role, i.branch_ids || '[]'),
      env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL').bind(ctx.user.id, nowIso(), i.code),
    ]);
    return i.pharmacy_id;
  },
  async list_branch_members(env, ctx, { p_pharmacy }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    return all(env, `SELECT m.user_id, u.email, m.role, m.branch_ids FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.pharmacy_id = ? AND m.role NOT IN ('owner', 'partner') ORDER BY u.email`, p_pharmacy)
      .then((rows) => rows.map((r) => { try { return { ...r, branch_ids: JSON.parse(r.branch_ids || '[]') }; } catch { return { ...r, branch_ids: [] }; } }));
  },
  async set_member_branches(env, ctx, { p_pharmacy, p_user_id, p_branch_ids }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    const ids = await branchIdsOf(env, p_pharmacy, p_branch_ids);
    const member = await one(env, "SELECT role, branch_ids FROM members WHERE pharmacy_id = ? AND user_id = ?", p_pharmacy, p_user_id);
    if (!member || ['owner', 'partner'].includes(member.role)) throw new ApiError('member not found', '42501', 403);
    let old = []; try { old = JSON.parse(member.branch_ids || '[]'); } catch { /* fail closed */ }
    await runBatch(env, [
      env.DB.prepare('UPDATE members SET branch_ids = ? WHERE pharmacy_id = ? AND user_id = ?').bind(JSON.stringify(ids), p_pharmacy, p_user_id),
      audit(env, ctx, 'members', 'update', { id: p_user_id, pharmacy_id: p_pharmacy, user_id: p_user_id, role: member.role, branch_ids: old },
        { id: p_user_id, pharmacy_id: p_pharmacy, user_id: p_user_id, role: member.role, branch_ids: ids }),
    ]);
    return null;
  },

  // ---------- Employees and attendance ----------
  async add_employee(env, ctx, { p_pharmacy, p_name, p_pin, p_shift_start = '09:00', p_shift_end = '17:00', p_work_days = [6, 0, 1, 2, 3, 4], p_grace = 15 }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    const name = String(p_name || '').trim();
    if (!name) throw new ApiError('name required');
    if (!/^\d{4,6}$/.test(String(p_pin))) throw new ApiError('PIN must be 4-6 digits');
    const h = await hashPin(env, p_pharmacy, p_pin);
    if (await one(env, 'SELECT 1 FROM employees WHERE pharmacy_id = ? AND active = 1 AND pin_hash = ?', p_pharmacy, h)) throw new ApiError('PIN already used');
    const e = { id: uuid(), pharmacy_id: p_pharmacy, name: name.slice(0, 120), pin_hash: h, shift_start: `${p_shift_start}:00`.slice(0, 8), shift_end: `${p_shift_end}:00`.slice(0, 8),
      work_days: p_work_days, grace_minutes: Math.max(0, Math.min(600, +p_grace || 0)), active: true, created_at: nowIso() };
    await env.DB.batch([
      env.DB.prepare('INSERT INTO employees (id, pharmacy_id, name, pin_hash, shift_start, shift_end, work_days, grace_minutes, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
        .bind(e.id, e.pharmacy_id, e.name, e.pin_hash, e.shift_start, e.shift_end, JSON.stringify(e.work_days), e.grace_minutes, e.created_at),
      audit(env, ctx, 'employees', 'insert', null, e),
    ]);
    return e.id;
  },
  async set_employee_pin(env, ctx, { p_employee, p_pin }) {
    if (!/^\d{4,6}$/.test(String(p_pin))) throw new ApiError('PIN must be 4-6 digits');
    const e = await one(env, 'SELECT id, pharmacy_id FROM employees WHERE id = ?', String(p_employee));
    if (!e) throw new ApiError('not allowed', '42501', 403);
    requireRole(ctx, e.pharmacy_id, ['owner']);
    const h = await hashPin(env, e.pharmacy_id, p_pin);
    if (await one(env, 'SELECT 1 FROM employees WHERE pharmacy_id = ? AND id <> ? AND active = 1 AND pin_hash = ?', e.pharmacy_id, e.id, h)) throw new ApiError('PIN already used');
    await env.DB.prepare('UPDATE employees SET pin_hash = ? WHERE id = ?').bind(h, e.id).run();
    return null;
  },
  async clock(env, ctx, { p_pharmacy, p_pin }) {
    requireRole(ctx, p_pharmacy, ['owner', 'partner', 'device', 'pharmacist', 'stock', 'accountant']);
    const e = await pinEmployee(env, ctx, p_pharmacy, p_pin, 'wrong pin');
    const open = await one(env, 'SELECT id FROM attendance WHERE employee_id = ? AND check_out IS NULL', e.id);
    const at = nowIso();
    if (open) { await env.DB.prepare('UPDATE attendance SET check_out = ? WHERE id = ?').bind(at, open.id).run(); return [{ employee_name: e.name, action: 'out', at }]; }
    await env.DB.prepare('INSERT INTO attendance (pharmacy_id, employee_id, check_in) VALUES (?, ?, ?)').bind(p_pharmacy, e.id, at).run();
    return [{ employee_name: e.name, action: 'in', at }];
  },
  async cashier_staff(env, ctx, { p_pharmacy }) {
    if (!['owner', 'device', 'pharmacist'].includes(ctx.roles.get(String(p_pharmacy)))) return 0;
    return (await one(env, 'SELECT count(*) AS n FROM employees WHERE pharmacy_id = ? AND active = 1', p_pharmacy)).n;
  },
  async cashier_pin(env, ctx, { p_pharmacy, p_pin }) {
    requireRole(ctx, p_pharmacy, ['owner', 'device', 'pharmacist']);
    const e = await pinEmployee(env, ctx, p_pharmacy, p_pin, null);
    return e ? [{ employee_id: e.id, employee_name: e.name }] : [];
  },

  // ---------- Selling Saydaliti ----------
  async is_app_admin(env, ctx) { return isAdmin(env, ctx); },
  async admin_pharmacies(env, ctx) {
    await needAdmin(env, ctx);
    const since = recent(30 * 1440);
    return all(env, `SELECT p.id AS pharmacy_id, p.name, p.created_at,
        (SELECT u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.pharmacy_id = p.id AND m.role = 'owner' LIMIT 1) AS owner_email,
        (SELECT count(*) FROM branches b WHERE b.pharmacy_id = p.id) AS branches,
        (SELECT count(*) FROM employees e WHERE e.pharmacy_id = p.id AND e.active = 1) AS employees,
        s.status, s.trial_ends, s.paid_until, s.price_month, s.note, s.plan,
        (SELECT max(x.sold_at) FROM pos_sales x WHERE x.pharmacy_id = p.id) AS last_sale,
        (SELECT count(*) FROM pos_sales x WHERE x.pharmacy_id = p.id AND x.sold_at > ?) AS sales_30d
      FROM pharmacies p LEFT JOIN subscriptions s ON s.pharmacy_id = p.id ORDER BY p.created_at DESC`, since);
  },
  async admin_set_subscription(env, ctx, { p_pharmacy, p_status, p_trial_ends = null, p_paid_until = null, p_price = null, p_note = null, p_plan }) {
    await needAdmin(env, ctx);
    if (!['trial', 'active', 'free', 'suspended'].includes(p_status)) throw new ApiError('bad status');
    if (p_plan !== undefined && p_plan !== null && p_plan !== '' && !['starter', 'pro', 'business'].includes(p_plan)) throw new ApiError('bad plan');
    const note = String(p_note ?? '').trim().slice(0, 600) || null;
    await env.DB.prepare(`INSERT INTO subscriptions (pharmacy_id, status, trial_ends, paid_until, price_month, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pharmacy_id) DO UPDATE SET status = excluded.status, trial_ends = excluded.trial_ends, paid_until = excluded.paid_until,
      price_month = excluded.price_month, note = excluded.note, updated_at = excluded.updated_at`)
      .bind(p_pharmacy, p_status, p_trial_ends, p_paid_until, p_price === null || p_price === '' ? null : +p_price, note, nowIso()).run();
    if (p_plan !== undefined) await env.DB.prepare('UPDATE subscriptions SET plan = ? WHERE pharmacy_id = ?').bind(p_plan || null, p_pharmacy).run();
    return null;
  },
  async admin_set_plans(env, ctx, { p_plans }) {
    await needAdmin(env, ctx);
    await env.DB.prepare('UPDATE app_config SET plans = ?, updated_at = ? WHERE id = 1').bind(JSON.stringify(readPlans(p_plans)), nowIso()).run();
    return null;
  },
  async admin_set_config(env, ctx, { p_trial_days, p_grace_days, p_price_month, p_price_branch, p_pay_note, p_support_phone }) {
    await needAdmin(env, ctx);
    const n = (v, lo, hi) => { const x = +v; if (!Number.isFinite(x) || x < lo || x > hi) throw new ApiError('bad value'); return x; };
    await env.DB.prepare('UPDATE app_config SET trial_days = ?, grace_days = ?, price_month = ?, price_branch = ?, pay_note = ?, support_phone = ?, updated_at = ? WHERE id = 1')
      .bind(n(p_trial_days, 0, 365), n(p_grace_days, 0, 60), n(p_price_month, 0, 1e7), n(p_price_branch, 0, 1e7), String(p_pay_note ?? '').slice(0, 600), String(p_support_phone ?? '').slice(0, 30), nowIso()).run();
    return null;
  },
  async admin_errors(env, ctx, { p_limit = 200 }) {
    await needAdmin(env, ctx);
    return all(env, 'SELECT * FROM client_errors ORDER BY at DESC LIMIT ?', Math.max(1, Math.min(1000, +p_limit || 200)));
  },
  // At most 30 an hour per account.
  async log_client_error(env, ctx, { p_pharmacy, p_page, p_message, p_stack, p_agent, p_version }) {
    if (!ctx.user) return null;
    if ((await one(env, 'SELECT count(*) AS n FROM client_errors WHERE user_id = ? AND at > ?', ctx.user.id, recent(60))).n >= 30) return null;
    await env.DB.prepare('INSERT INTO client_errors (at, user_id, pharmacy_id, page, message, stack, agent, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(nowIso(), ctx.user.id, p_pharmacy && ctx.roles.has(String(p_pharmacy)) ? p_pharmacy : null, String(p_page ?? '').slice(0, 60),
        String(p_message ?? '?').slice(0, 500), p_stack ? String(p_stack).slice(0, 4000) : null, p_agent ? String(p_agent).slice(0, 300) : null, p_version ? String(p_version).slice(0, 40) : null).run();
    return null;
  },

  // ---------- Restoring a full backup into a new, empty pharmacy (moving from Supabase) ----------
  async import_backup(env, ctx, { p_pharmacy, p_dump }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    return importBackup(env, ctx, p_pharmacy, p_dump);
  },
};

// The employee a PIN belongs to; wrong PINs are counted (20 in 15 minutes and the account waits).
async function pinEmployee(env, ctx, pharmacyId, pin, wrongMessage) {
  if ((await one(env, 'SELECT count(*) AS n FROM pin_attempts WHERE user_id = ? AND at > ?', ctx.user.id, recent(15))).n >= 20) throw new ApiError('too many attempts');
  const e = /^\d{4,6}$/.test(String(pin)) ? await one(env, 'SELECT id, name FROM employees WHERE pharmacy_id = ? AND active = 1 AND pin_hash = ?', pharmacyId, await hashPin(env, pharmacyId, pin)) : null;
  if (!e) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO pin_attempts (user_id, at) VALUES (?, ?)').bind(ctx.user.id, nowIso()),
      env.DB.prepare('DELETE FROM pin_attempts WHERE at < ?').bind(recent(1440)),
    ]);
    if (wrongMessage) throw new ApiError(wrongMessage);
    return null;
  }
  return e;
}

// ---------- Moving in a full backup ----------
// The backup made by «نسخة احتياطية من كل بياناتك» (or by the desktop version) is loaded into this
// pharmacy, which must still be empty. Ids are kept; the pharmacy and the people are the new ones.
const IMPORT_ORDER = ['branches', 'employees', 'attendance', 'customers', 'patients', 'reminders', 'catalog_items', 'purchases', 'supplier_payments',
  'stock_moves', 'expenses', 'shortages', 'market_prices', 'pos_barcodes', 'pos_shifts', 'pos_sales', 'customer_payments'];
async function importBackup(env, ctx, pharmacyId, dump) {
  if (dump?.app !== 'saydaliti' || !dump.tables || typeof dump.tables !== 'object') throw new ApiError('not a backup');
  for (const t of ['catalog_items', 'purchases', 'pos_sales', 'stock_moves', 'customers', 'expenses']) {
    if ((await one(env, `SELECT count(*) AS n FROM ${t} WHERE pharmacy_id = ?`, pharmacyId)).n) throw new ApiError('pharmacy not empty');
  }
  const old = dump.tables.pharmacies?.[0];
  if (old?.settings && typeof old.settings === 'object') await env.DB.prepare('UPDATE pharmacies SET settings = ? WHERE id = ?').bind(JSON.stringify(old.settings), pharmacyId).run();
  // Every row gets a new id (the backup may come from a pharmacy on this same server), and links
  // between rows (branch, customer, employee, shift, patient, returned receipt) follow the new ids.
  // The new pharmacy's own main branch takes the place of the old main branch.
  const ids = new Map();
  const newId = (old) => { if (old === null || old === undefined || old === '') return old; if (!ids.has(old)) ids.set(old, uuid()); return ids.get(old); };
  const oldBranches = [...(dump.tables.branches || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const myMain = await mainBranch(env, pharmacyId);
  if (oldBranches[0] && myMain) ids.set(oldBranches[0].id, myMain);
  const LINKS = ['branch_id', 'customer_id', 'employee_id', 'shift_id', 'patient_id', 'return_of'];
  const counts = {};
  for (const table of IMPORT_ORDER) {
    const t = TABLES[table];
    const rows = (dump.tables[table] || []).filter((r) => r && typeof r === 'object');
    const stmts = [];
    for (const r0 of rows) {
      if (table === 'branches' && ids.get(r0.id) === myMain) continue;
      const r = { ...r0, pharmacy_id: pharmacyId };
      if (t.cols.id?.[0] === 'id') r.id = newId(r0.id);
      for (const l of LINKS) if (l in t.cols && r[l]) r[l] = newId(r[l]);
      if (table === 'employees') r.pin_hash = `reset:${uuid()}`; // PINs can't be carried over: set them again
      if ('created_by' in t.cols) r.created_by = ctx.user.id;
      const cols = Object.keys(t.cols).filter((c) => r[c] !== undefined && !(t.cols[c][0] === 'serial'));
      const vals = cols.map((c) => { const type = t.cols[c][0]; const v = r[c]; return v === null ? null : type === 'bool' ? (v ? 1 : 0) : type === 'json' ? JSON.stringify(v) : type === 'num' || type === 'int' ? +v : String(v); });
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...vals));
    }
    for (let i = 0; i < stmts.length; i += 200) await runBatch(env, stmts.slice(i, i + 200));
    counts[table] = stmts.length;
  }
  // The latest upload of each branch.
  let snaps = 0;
  for (const s of dump.tables.snapshots || []) {
    if (!s?.data || !Array.isArray(s.data.items)) continue;
    // Kept at its own time: what was entered after it (sales, deliveries…) is counted on top of it.
    await storeSnapshot(env, pharmacyId, s.branch_id ? newId(s.branch_id) : myMain, ctx.user.id, s.data, s.created_at);
    snaps += 1;
  }
  counts.snapshots = snaps;
  // Where each old branch went, so the app can upload the snapshots of the backup itself.
  return { ...counts, branches: Object.fromEntries(oldBranches.map((x) => [x.id, ids.get(x.id)])) };
}

// ---------- For the scheduled jobs (morning report, patient reminders) ----------
export async function reportFeed(env) {
  const out = [];
  for (const p of await all(env, "SELECT id, name, settings FROM pharmacies WHERE json_extract(settings, '$.waNumbers') IS NOT NULL AND json_extract(settings, '$.waNumbers') <> ''")) {
    const per = [];
    for (const b of await all(env, 'SELECT id, name FROM branches WHERE pharmacy_id = ?', p.id)) {
      const s = await one(env, 'SELECT id, created_at FROM snapshots WHERE branch_id = ? ORDER BY created_at DESC LIMIT 1', b.id);
      if (!s) continue;
      const obj = await env.FILES.get(blobKey('snapshots', s.id));
      if (obj) per.push({ branch: b.name, at: s.created_at, data: await obj.json() });
    }
    if (!per.length) continue;
    per.sort((a, b) => b.at.localeCompare(a.at));
    out.push({ pharmacy_id: p.id, pharmacy_name: p.name, settings: JSON.parse(p.settings || '{}'), snapshot_at: per[0].at, data: per[0].data, branch_data: per });
  }
  return out;
}
export async function remindersFeed(env) {
  const rows = await all(env, `SELECT r.id, r.kind, r.medicine, r.dose_times, r.refill_every_days, r.next_refill, r.last_sent_at, pa.name AS patient_name, pa.phone, ph.name AS pharmacy_name
    FROM reminders r JOIN patients pa ON pa.id = r.patient_id JOIN pharmacies ph ON ph.id = r.pharmacy_id WHERE r.active = 1 AND pa.active = 1 AND pa.consent = 1`);
  return rows.map((r) => ({ ...r, dose_times: r.dose_times ? JSON.parse(r.dose_times) : null }));
}
export async function markRemindersSent(env, items) {
  const stmts = (items || []).map((i) => env.DB.prepare('UPDATE reminders SET last_sent_at = ?, next_refill = coalesce(?, next_refill) WHERE id = ?').bind(nowIso(), i.next_refill ?? null, i.id));
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

// ---------- Rules on cashier receipts (were database triggers) ----------
// A return names its sale receipt and can't take back more than that receipt sold.
export async function checkPosSale(ctx, env, row) {
  if (row.kind !== 'return') { if (row.return_of) throw new ApiError('return_of is only for returns'); return; }
  if (!row.return_of) return;
  const o = await one(env, "SELECT lines, branch_id FROM pos_sales WHERE id = ? AND pharmacy_id = ? AND kind = 'sale'", row.return_of, row.pharmacy_id);
  if (!o) throw new ApiError('receipt not found');
  if (requireBranch(ctx, row.pharmacy_id, o.branch_id) !== requireBranch(ctx, row.pharmacy_id, row.branch_id)) throw new ApiError('receipt belongs to another branch', '42501', 403);
  // In boxes: a line sold by the strip or pill has qty of them and per = how many in a box.
  const sum = (lines) => { const m = new Map(); for (const l of lines || []) m.set(String(l.code), (m.get(String(l.code)) || 0) + (+l.qty || 0) / (+l.per > 1 ? +l.per : 1)); return m; };
  const sold = sum(JSON.parse(o.lines));
  const back = new Map();
  for (const p of await all(env, 'SELECT lines FROM pos_sales WHERE return_of = ? AND id <> ?', row.return_of, row.id)) for (const [k, v] of sum(JSON.parse(p.lines))) back.set(k, (back.get(k) || 0) + v);
  for (const [code, q] of sum(row.lines)) if (q > (sold.get(code) || 0) - (back.get(code) || 0) + 0.0001) throw new ApiError('return more than sold');
}
export { fromDb };
