// The database functions the app calls by name (rpc), the same ones the Supabase database had:
// pharmacies and branches, employees and attendance, invites, uploads, the cashier's PIN and
// returns, subscriptions and the admin page, and error reports.
import { planOf, readPlans } from '../../src/plans.js';
import { checkSaleRow, checkReturnAgainst, checkVoid } from '../../src/sale-rules.js';
import { ApiError, requireRole, requireBranch, nowIso, todayIso, uuid, runBatch, blobKey, fromDb } from './db.js';
import { TABLES } from './schema.js';
import { hashPin, oldPinHashes, sha256, randomHex } from './auth.js';
import { openStock } from './stock.js';
import { runBackup, backupHealth } from './backup.js';
import { verifyAudit, rebaselineAudit } from './audit-seal.js';

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
  // A new upload is a new starting stock for the app: the server's levels wait for the next opening.
  await env.DB.prepare('UPDATE stock_bases SET stale = 1, updated_at = ? WHERE pharmacy_id = ? AND branch_id = ?').bind(nowIso(), pharmacyId, branchId ?? await mainBranch(env, pharmacyId)).run();
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
    for (const x of [h, ...await oldPinHashes(env, p_pharmacy, p_pin)]) if (await one(env, 'SELECT 1 FROM employees WHERE pharmacy_id = ? AND active = 1 AND pin_hash = ?', p_pharmacy, x)) throw new ApiError('PIN already used');
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
    for (const x of [h, ...await oldPinHashes(env, e.pharmacy_id, p_pin)]) if (await one(env, 'SELECT 1 FROM employees WHERE pharmacy_id = ? AND id <> ? AND active = 1 AND pin_hash = ?', e.pharmacy_id, e.id, x)) throw new ApiError('PIN already used');
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
  // A return without the original receipt, approved on the spot by a manager: an employee the owner
  // marked "may approve returns" types their own PIN (checked here, with the same limit on wrong tries
  // as every PIN). The approval is kept for this one return only: its id, the amount given back, the
  // reason, the cashier (signed in with their PIN at the cashier) and the approver, who must be someone
  // else. The return is then saved with approval_id, and checkPosSale makes sure it matches.
  async approve_no_receipt_return(env, ctx, { p_pharmacy, p_branch = null, p_return_id, p_total, p_reason, p_cashier, p_pin }) {
    requireRole(ctx, p_pharmacy, ['owner', 'device', 'pharmacist']);
    const branch = requireBranch(ctx, p_pharmacy, p_branch);
    const isId = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    if (!isId(p_return_id)) throw new ApiError('bad return id');
    const total = Math.round(+p_total * 100) / 100;
    if (!Number.isFinite(total) || total >= 0 || total < -99999999.99) throw new ApiError('bad return total');
    const reason = String(p_reason ?? '').trim();
    if (!reason || reason.length > 300) throw new ApiError('a return without a receipt needs a reason');
    if (!isId(p_cashier)) throw new ApiError('the cashier must sign in with their PIN first');
    const cashier = await one(env, 'SELECT id, name FROM employees WHERE id = ? AND pharmacy_id = ? AND active = 1', p_cashier, p_pharmacy);
    if (!cashier) throw new ApiError('the cashier must sign in with their PIN first');
    const approver = await pinEmployee(env, ctx, p_pharmacy, p_pin, 'wrong pin');
    const can = await one(env, 'SELECT can_approve_returns FROM employees WHERE id = ?', approver.id);
    if (!can?.can_approve_returns) throw new ApiError('this employee may not approve returns', '42501', 403);
    if (approver.id === cashier.id) throw new ApiError('the approver must be another employee', '42501', 403);
    // The same return asked again (a lost answer): the approval already given, if it is the same one.
    const had = await one(env, 'SELECT id, pharmacy_id, total, cashier_employee_id, approver_name FROM return_approvals WHERE return_id = ?', p_return_id);
    if (had) {
      if (had.pharmacy_id !== p_pharmacy || Math.abs(had.total - total) > 0.005 || had.cashier_employee_id !== cashier.id) throw new ApiError('return already approved differently', '23505', 409);
      return { approval_id: had.id, approver_name: had.approver_name };
    }
    const row = { id: uuid(), pharmacy_id: p_pharmacy, branch_id: branch, return_id: p_return_id, total, reason, cashier_employee_id: cashier.id, cashier_name: cashier.name,
      approver_employee_id: approver.id, approver_name: approver.name, approved_by_user: ctx.user.id, created_at: nowIso() };
    const cols = Object.keys(row);
    await runBatch(env, [
      env.DB.prepare(`INSERT INTO return_approvals (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => row[c])),
      audit(env, ctx, 'return_approvals', 'insert', null, row),
    ]);
    return { approval_id: row.id, approver_name: approver.name };
  },
  // ---------- Stock kept by the server (Phase 2 M1, stock.js) ----------
  // The state of a branch's levels, and the server's clock (the app takes it before loading its data,
  // as the watermark for open_stock).
  async stock_status(env, ctx, { p_pharmacy, p_branch = null }) {
    requireRole(ctx, p_pharmacy, ['owner', 'partner', 'device', 'pharmacist', 'accountant', 'stock']);
    const branch = requireBranch(ctx, p_pharmacy, p_branch);
    const b = await one(env, 'SELECT base_at, opened_at, stale, block_negative FROM stock_bases WHERE pharmacy_id = ? AND branch_id = ?', p_pharmacy, branch);
    return { server_now: nowIso(), branch_id: branch, base_at: b?.base_at ?? null, opened_at: b?.opened_at ?? null, stale: !!b?.stale, block_negative: !!b?.block_negative };
  },
  async open_stock(env, ctx, args) {
    requireRole(ctx, args.p_pharmacy, ['owner', 'stock']);
    requireBranch(ctx, args.p_pharmacy, args.p_branch ?? null);
    return openStock(env, ctx, args);
  },
  // Selling below zero: allowed (as today) or blocked, per branch. The owner decides; it is logged.
  async set_stock_policy(env, ctx, { p_pharmacy, p_branch = null, p_block_negative }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    const branch = requireBranch(ctx, p_pharmacy, p_branch);
    if (typeof p_block_negative !== 'boolean') throw new ApiError('bad policy');
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO stock_bases (pharmacy_id, branch_id, block_negative, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (pharmacy_id, branch_id) DO UPDATE SET block_negative = excluded.block_negative, updated_at = excluded.updated_at`).bind(p_pharmacy, branch, p_block_negative ? 1 : 0, now),
      audit(env, ctx, 'stock_bases', 'update', null, { id: branch, pharmacy_id: p_pharmacy, block_negative: p_block_negative }),
    ]);
    return { block_negative: p_block_negative };
  },
  // ---------- Encrypted server backups (Phase 2 M2, backup.js) ----------
  // The owner makes one now, or sees the list (not the files: restoring is a recovery procedure,
  // docs/operations/DISASTER_RECOVERY.md).
  async backup_now(env, ctx, { p_pharmacy }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    const recentOne = await one(env, "SELECT count(*) AS n FROM backups WHERE pharmacy_id = ? AND created_at > ? AND source = 'manual'", p_pharmacy, recent(60));
    if (recentOne.n >= 6) throw new ApiError('too many backups this hour', '429', 429);
    const r = await runBackup(env, p_pharmacy, { by: ctx.user.id, source: 'manual' });
    return { id: r.id, bytes: r.bytes, counts: r.counts };
  },
  // The app admin: which pharmacies' backups need a look (none, too old, or failing).
  async admin_backup_health(env, ctx) {
    await needAdmin(env, ctx);
    return backupHealth(env);
  },
  async list_backups(env, ctx, { p_pharmacy }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    return (await all(env, 'SELECT id, created_at, status, bytes, summary, error, source FROM backups WHERE pharmacy_id = ? ORDER BY created_at DESC LIMIT 60', p_pharmacy))
      .map((b) => ({ ...b, summary: b.summary ? JSON.parse(b.summary) : null }));
  },
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
  // Verification is read-only. New rows are sealed by the scheduled job after this check.
  async audit_verify(env, ctx, { p_pharmacy, p_cursor }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    return verifyAudit(env, p_pharmacy, { cursor: p_cursor || null, userId: ctx.user.id });
  },
  async audit_rebaseline(env, ctx, { p_pharmacy, p_reason, p_confirm, p_proof }) {
    requireRole(ctx, p_pharmacy, ['owner']);
    return rebaselineAudit(env, p_pharmacy, { userId: ctx.user.id, reason: p_reason, confirm: p_confirm, proof: p_proof || null });
  },
  // How much the app is used, for the app owner: counts only (no money, no names of customers or items).
  async admin_usage(env, ctx) {
    await needAdmin(env, ctx);
    const d7 = recent(7 * 1440), d30 = recent(30 * 1440);
    const per = await all(env, `SELECT p.id AS pharmacy_id, p.name,
        (SELECT count(*) FROM members m WHERE m.pharmacy_id = p.id) AS accounts,
        (SELECT count(DISTINCT s.user_id) FROM sessions s JOIN members m ON m.user_id = s.user_id WHERE m.pharmacy_id = p.id AND s.created_at > ?) AS signed_in_30d,
        (SELECT count(*) FROM pos_sales x WHERE x.pharmacy_id = p.id AND x.sold_at > ?) AS receipts_7d,
        (SELECT count(*) FROM pos_sales x WHERE x.pharmacy_id = p.id AND x.sold_at > ?) AS receipts_30d,
        (SELECT count(*) FROM purchases x WHERE x.pharmacy_id = p.id AND x.created_at > ?) AS purchases_30d,
        (SELECT count(*) FROM catalog_items x WHERE x.pharmacy_id = p.id) AS items,
        (SELECT max(t) FROM (SELECT max(sold_at) AS t FROM pos_sales WHERE pharmacy_id = p.id UNION ALL SELECT max(created_at) FROM purchases WHERE pharmacy_id = p.id
          UNION ALL SELECT max(created_at) FROM snapshots WHERE pharmacy_id = p.id)) AS last_activity
      FROM pharmacies p ORDER BY receipts_30d DESC, p.created_at DESC`, d30, d7, d30, d30);
    const signups = await all(env, "SELECT substr(created_at, 1, 10) AS day, count(*) AS n FROM pharmacies WHERE created_at > ? GROUP BY day ORDER BY day", d30);
    const status = await all(env, "SELECT coalesce(s.status, 'trial') AS status, count(*) AS n FROM pharmacies p LEFT JOIN subscriptions s ON s.pharmacy_id = p.id GROUP BY 1");
    const totals = {
      pharmacies: per.length,
      active_7d: per.filter((r) => r.receipts_7d > 0).length,
      active_30d: per.filter((r) => r.receipts_30d > 0 || r.purchases_30d > 0).length,
      receipts_30d: per.reduce((a, r) => a + r.receipts_30d, 0),
      accounts: per.reduce((a, r) => a + r.accounts, 0),
    };
    return { totals, status, signups, pharmacies: per };
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
// No prototype: a name from the address (/api/rpc/<name>) can only ever be one of the functions above,
// never something inherited such as `constructor` (Object, which would hand back env with its secrets).
Object.setPrototypeOf(RPC, null);
// The function for a name taken from a request, or null.
export const rpcNamed = (name) => (typeof name === 'string' && Object.hasOwn(RPC, name) && typeof RPC[name] === 'function' ? RPC[name] : null);

// The employee a PIN belongs to; wrong PINs are counted (20 in 15 minutes and the account waits).
async function pinEmployee(env, ctx, pharmacyId, pin, wrongMessage) {
  if ((await one(env, 'SELECT count(*) AS n FROM pin_attempts WHERE user_id = ? AND at > ?', ctx.user.id, recent(15))).n >= 20) throw new ApiError('too many attempts');
  let e = null;
  if (/^\d{4,6}$/.test(String(pin))) {
    const h = await hashPin(env, pharmacyId, pin);
    e = await one(env, 'SELECT id, name FROM employees WHERE pharmacy_id = ? AND active = 1 AND pin_hash = ?', pharmacyId, h);
    // A PIN hashed before PIN_PEPPER changed: accepted with the old value once, and hashed again now.
    for (const old of e ? [] : await oldPinHashes(env, pharmacyId, pin)) {
      e = await one(env, 'SELECT id, name FROM employees WHERE pharmacy_id = ? AND active = 1 AND pin_hash = ?', pharmacyId, old);
      if (e) { await env.DB.prepare('UPDATE employees SET pin_hash = ? WHERE id = ? AND pin_hash = ?').bind(h, e.id, old).run(); break; }
    }
  }
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
  // Moved-in sales, purchases and stock moves have no stock ledger rows: the server's stock of this
  // pharmacy is stale until the owner opens it again (so nothing is blocked on wrong numbers).
  await env.DB.prepare('UPDATE stock_bases SET stale = 1, updated_at = ? WHERE pharmacy_id = ?').bind(nowIso(), pharmacyId).run();
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
// Every receipt the cashier sends is checked here before it is stored (rules: src/sale-rules.js).
// A return against a receipt is also checked against that receipt and its earlier returns; the
// quantity and the receipt number are checked again inside the insert itself (db.js), atomically.
export async function checkPosSale(ctx, env, row) {
  try {
    checkSaleRow(row);
  } catch (e) { if (e.saleRule) throw new ApiError(e.message); throw e; }
  const flags = await timeFlags(env, row);
  if (row.is_void && (row.kind !== 'return' || !row.return_of)) throw new ApiError('a void must be a return of a receipt');
  if (row.kind === 'return' && !row.return_of) { await checkApproval(env, row); return { flags }; }
  if (row.kind !== 'return') return { flags };
  const o = await one(env, "SELECT id, kind, lines, branch_id, discount, customer_id, sold_at FROM pos_sales WHERE id = ? AND pharmacy_id = ? AND kind = 'sale'", row.return_of, row.pharmacy_id);
  if (!o) throw new ApiError('receipt not found');
  if (requireBranch(ctx, row.pharmacy_id, o.branch_id) !== requireBranch(ctx, row.pharmacy_id, row.branch_id)) throw new ApiError('receipt belongs to another branch', '42501', 403);
  const earlier = (await all(env, "SELECT lines FROM pos_sales WHERE return_of = ? AND pharmacy_id = ? AND kind = 'return' AND id <> ?", row.return_of, row.pharmacy_id, row.id))
    .map((r) => ({ lines: JSON.parse(r.lines) }));
  try {
    checkReturnAgainst(row, { ...o, lines: JSON.parse(o.lines) }, earlier);
    if (row.is_void) checkVoid(row, { ...o, lines: JSON.parse(o.lines) }, earlier);
  } catch (e) { if (e.saleRule) throw new ApiError(e.message); throw e; }
  // Cancelling a whole receipt: the owner, or a cashier with a manager's approval for this very return.
  if (row.is_void && ctx.roles.get(String(row.pharmacy_id)) !== 'owner') await checkApproval(env, row);
  if (o.sold_at && Date.parse(row.sold_at) < Date.parse(o.sold_at) - SKEW) flags.push('return_before_sale');
  return { flags };
}

// Signs that a receipt's time was set by hand or by a wrong clock. A receipt made offline arrives late
// and that alone is normal, so nothing here refuses a receipt: the signs go to the log of changes
// (op 'flag') for the owner to look at. Policy and edge cases: docs/architecture/OFFLINE_SYNC.md.
const SKEW = 10 * 60000; // device clocks drift; the same 10 minutes the future check allows
async function timeFlags(env, row) {
  const flags = [];
  const t = Date.parse(row.sold_at);
  // The receipt number carries the day the device numbered it (YYMMDD, the device's own date).
  const m = /^(\d{2})(\d{2})(\d{2})-/.exec(String(row.number));
  if (m && row.receipt_device) {
    const day = Date.UTC(2000 + +m[1], +m[2] - 1, +m[3]);
    if (t < day - 86400000 || t > day + 2 * 86400000) flags.push('time_not_number_day');
  }
  // Inside the shift it says it was sold in.
  if (row.shift_id) {
    const sh = await one(env, 'SELECT opened_at, closed_at FROM pos_shifts WHERE id = ? AND pharmacy_id = ?', row.shift_id, row.pharmacy_id);
    if (sh && t < Date.parse(sh.opened_at) - SKEW) flags.push('before_shift_opened');
    if (sh?.closed_at && t > Date.parse(sh.closed_at) + SKEW) flags.push('after_shift_closed');
  }
  // Dated before the uploaded file the branch's stock starts from (an old offline receipt, or a clock set back).
  const base = await one(env, 'SELECT base_at FROM stock_bases WHERE pharmacy_id = ? AND branch_id = ?', row.pharmacy_id, row.branch_id ?? await mainBranch(env, row.pharmacy_id));
  if (base?.base_at && t <= Date.parse(base.base_at)) flags.push('before_base');
  // A day already closed for this branch: the receipt changes totals the owner already signed off.
  const tz = (await one(env, 'SELECT timezone FROM pharmacies WHERE id = ?', row.pharmacy_id))?.timezone || 'Africa/Cairo';
  let day = null;
  try { day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); } catch { /* unknown zone */ }
  if (day && await one(env, 'SELECT 1 FROM day_closes WHERE pharmacy_id = ? AND day = ? AND branch_id IS ?', row.pharmacy_id, day, row.branch_id ?? null)) flags.push('after_day_closed');
  return flags;
}
// A return without a receipt must carry the manager's approval given for it (see
// approve_no_receipt_return): same pharmacy, same return, same amount, same cashier.
async function checkApproval(env, row) {
  if (!row.approval_id) throw new ApiError('a return without a receipt needs a manager approval', '42501', 403);
  if (!row.employee_id) throw new ApiError('the cashier must sign in with their PIN first', '42501', 403);
  const a = await one(env, 'SELECT pharmacy_id, return_id, total, cashier_employee_id FROM return_approvals WHERE id = ?', String(row.approval_id));
  if (!a || a.pharmacy_id !== row.pharmacy_id || a.return_id !== row.id) throw new ApiError('approval not for this return', '42501', 403);
  if (Math.abs(a.total - +row.total) > 0.005) throw new ApiError('approval not for this amount', '42501', 403);
  if (a.cashier_employee_id !== row.employee_id) throw new ApiError('approval not for this cashier', '42501', 403);
}
export { fromDb };
