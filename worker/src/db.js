// The data API: the app sends a query ({ table, op, cols, filters, order, range, limit, rows, patch })
// and this checks it against the rules in schema.js before running it on D1 — the same checks the
// Supabase database did with row-level security. Anything not allowed is refused, never trimmed.
import { TABLES } from './schema.js';
import { ledgerStmt, reversalStmt, branchKey, needOf } from './stock.js';

export class ApiError extends Error {
  constructor(message, code = 'P0001', status = 400) { super(message); this.code = code; this.status = status; }
}
export const nowIso = () => new Date().toISOString();
export const todayIso = () => nowIso().slice(0, 10);
export const uuid = () => crypto.randomUUID();
const IDENT = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tableOf(name, { allowInternal = false } = {}) {
  const t = TABLES[name];
  if (!t || (t.internal && !allowInternal)) throw new ApiError(`relation "public.${name}" does not exist`, '42P01', 404);
  return t;
}
const colSpec = (t, table, col) => {
  if (!IDENT.test(String(col)) || !t.cols[col]) throw new ApiError(`column ${table}.${col} does not exist`, '42703');
  return t.cols[col];
};

// ---------- Values in and out of SQLite ----------
export function toDb(type, v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (type === 'bool') return v ? 1 : 0;
  if (type === 'json') return JSON.stringify(v);
  if (type === 'int' || type === 'serial') return Math.trunc(+v);
  if (type === 'num') return +v;
  return String(v);
}
export function fromDb(t, row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const type = t.cols[k]?.[0];
    if (v === null || v === undefined) out[k] = null;
    else if (type === 'bool') out[k] = !!v;
    else if (type === 'json') { try { out[k] = JSON.parse(v); } catch { out[k] = null; } }
    else out[k] = v;
  }
  return out;
}

// Checks one value against its column (like the CHECK constraints in Postgres).
function checkValue(table, col, [type, o = {}], v) {
  const bad = (why) => { throw new ApiError(`new row for relation "${table}" violates check constraint (${col}: ${why})`, '23514'); };
  if (v === null || v === undefined) { if (o.nn && o.def === undefined && type !== 'serial') bad('required'); return; }
  if (type === 'id' && !UUID_RE.test(String(v))) bad('not an id');
  if ((type === 'num' || type === 'int') && !Number.isFinite(+v)) bad('not a number');
  if (type === 'num' || type === 'int') {
    if (o.min !== undefined && +v < o.min) bad('too small');
    if (o.maxv !== undefined && +v > o.maxv) bad('too large');
    if (o.nonzero && +v === 0) bad('zero');
  }
  if (type === 'text') {
    const s = String(v);
    if (o.max && s.length > o.max) bad('too long');
    if (o.trim && !s.trim()) bad('empty');
    if (o.in && !o.in.includes(s)) bad('not allowed');
    if (o.re && !new RegExp(o.re).test(s)) bad('wrong format');
  }
  if (type === 'date' && !/^\d{4}-\d{2}-\d{2}/.test(String(v))) bad('not a date');
  if (type === 'ts' && Number.isNaN(Date.parse(v))) bad('not a time');
  if (type === 'bool' && o.must && !v) bad('must be true');
  if (type === 'json' && o.array && (!Array.isArray(v) || v.length < o.array[0] || v.length > o.array[1])) bad('list size');
}
function withDefaults(t, row) {
  const out = { ...row };
  for (const [col, [type, o = {}]] of Object.entries(t.cols)) {
    if (out[col] !== undefined && out[col] !== null) continue;
    if (type === 'serial') { delete out[col]; continue; }
    if (o.def === undefined) continue;
    if (out[col] === null && !o.nn) continue;
    out[col] = o.def === 'now' ? nowIso() : o.def === 'today' ? todayIso() : o.def === 'uuid' ? uuid() : o.def;
  }
  return out;
}

// A receipt is inserted only if, at that moment (one SQL statement, so two requests can't both pass):
//   • no other receipt of the pharmacy has the same number, and
//   • for a return against a receipt: what it takes back, plus every earlier return of that receipt,
//     is no more than the receipt sold (counted in boxes).
// Otherwise its id is NULL and SQLite refuses the row (NOT NULL), which insert() turns into an error.
function guardedSaleInsert(env, row, cols, ignoreDuplicates, branch = null, need = []) {
  const isReturn = row.kind === 'return' && !!row.return_of;
  const code = (line) => `CAST(json_extract(${line}.value, '$.code') AS TEXT)`;
  const qty = (line) => `COALESCE(CAST(json_extract(${line}.value, '$.qty') AS REAL), 0) / CASE WHEN CAST(json_extract(${line}.value, '$.per') AS REAL) > 1 THEN CAST(json_extract(${line}.value, '$.per') AS REAL) ELSE 1 END`;
  const ctes = [], head = [];
  if (isReturn) {
    ctes.push(`source_sale AS (
      SELECT lines FROM pos_sales WHERE id = ? AND pharmacy_id = ? AND kind = 'sale'
    ), sold AS (
      SELECT ${code('line')} AS code, SUM(${qty('line')}) AS qty FROM source_sale sale, json_each(sale.lines) line GROUP BY code
    ), returned AS (
      SELECT ${code('line')} AS code, SUM(${qty('line')}) AS qty FROM pos_sales p, json_each(p.lines) line
      WHERE p.kind = 'return' AND p.return_of = ? AND p.pharmacy_id = ? AND p.id <> ? GROUP BY code
    ), requested AS (
      SELECT ${code('line')} AS code, SUM(${qty('line')}) AS qty FROM json_each(?) line GROUP BY code
    )`);
    head.push(row.return_of, row.pharmacy_id, row.return_of, row.pharmacy_id, row.id, JSON.stringify(row.lines));
  }
  // Selling below zero, where the branch blocks it (stock kept by the server, Phase 2 M1): the levels
  // are read in the same statement that stores the receipt, so two devices can't both take the last box.
  const checkStock = !!branch && need.length > 0;
  if (checkStock) { ctes.push("need AS (SELECT json_extract(value, '$.code') AS code, json_extract(value, '$.qty') AS qty FROM json_each(?))"); head.push(JSON.stringify(need)); }
  const retOk = isReturn ? ' AND EXISTS (SELECT 1 FROM source_sale) AND NOT EXISTS (SELECT 1 FROM requested r LEFT JOIN sold s ON s.code IS r.code LEFT JOIN returned b ON b.code IS r.code WHERE r.qty > COALESCE(s.qty, 0) - COALESCE(b.qty, 0) + 0.0001)' : '';
  const stockOk = checkStock ? ` AND NOT (EXISTS (SELECT 1 FROM stock_bases sb WHERE sb.pharmacy_id = ? AND sb.branch_id = ? AND sb.block_negative = 1 AND sb.stale = 0 AND sb.opened_at IS NOT NULL)
      AND EXISTS (SELECT 1 FROM need n LEFT JOIN stock_levels lv ON lv.pharmacy_id = ? AND lv.branch_id = ? AND lv.code = n.code WHERE COALESCE(lv.qty, 0) - n.qty < -0.0001))` : '';
  const numberOk = 'NOT EXISTS (SELECT 1 FROM pos_sales d WHERE d.pharmacy_id = ? AND d.number = ? AND d.id <> ?)';
  // The same receipt already stored (a retry racing the first request): let ON CONFLICT skip it.
  const already = 'EXISTS (SELECT 1 FROM pos_sales x WHERE x.id = ?)';
  const sql = `${ctes.length ? `WITH ${ctes.join(', ')}` : ''}
    INSERT INTO pos_sales (${cols.join(', ')})
    SELECT ${cols.map((c) => c === 'id' ? `CASE WHEN ${already} OR (${numberOk}${retOk}${stockOk}) THEN ? ELSE NULL END` : '?').join(', ')}
    ${ignoreDuplicates ? 'ON CONFLICT(id) DO NOTHING' : ''}`;
  const idArgs = [row.id, row.pharmacy_id, row.number, row.id, ...(checkStock ? [row.pharmacy_id, branch, row.pharmacy_id, branch] : []), row.id];
  const values = cols.flatMap((c) => c === 'id' ? idArgs : [toDb(TABLES.pos_sales.cols[c][0], row[c])]);
  return env.DB.prepare(sql).bind(...head, ...values);
}

// Is a stored receipt the same one as a receipt sent again? (Retries send the same row.)
function sameReceipt(had, row) {
  const lines = (v) => JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v);
  return had.pharmacy_id === row.pharmacy_id && had.kind === (row.kind ?? 'sale') && had.number === row.number
    && Date.parse(had.sold_at) === Date.parse(row.sold_at) && Math.abs(+had.total - +row.total) < 0.005
    && (had.return_of ?? null) === (row.return_of ?? null) && lines(had.lines) === lines(row.lines);
}

// The first item a sale would take below zero, when its branch blocks that (else null).
async function shortOf(env, pharmacyId, branch, need) {
  if (!branch || !need.length) return null;
  const b = await env.DB.prepare('SELECT 1 FROM stock_bases WHERE pharmacy_id = ? AND branch_id = ? AND block_negative = 1 AND stale = 0 AND opened_at IS NOT NULL').bind(pharmacyId, branch).first();
  if (!b) return null;
  for (const n of need) {
    const lv = await env.DB.prepare('SELECT qty FROM stock_levels WHERE pharmacy_id = ? AND branch_id = ? AND code = ?').bind(pharmacyId, branch, n.code).first();
    if ((lv?.qty ?? 0) - n.qty < -0.0001) return n.code;
  }
  return null;
}

// ---------- Who may do what ----------
// ctx: { user: { id } | null, roles: Map(pharmacyId → role), admin }
const pharmaciesWith = (ctx, roles) => [...ctx.roles].filter(([, r]) => roles.includes(r)).map(([p]) => p);
export function requireRole(ctx, pharmacyId, roles) {
  if (!ctx.user) throw new ApiError('not signed in', '42501', 401);
  if (!roles.includes(ctx.roles.get(String(pharmacyId)))) throw new ApiError('not allowed', '42501', 403);
}

function readScope(ctx, table, t, allowedIds = null) {
  if (t.read === 'public') return { sql: '', args: [] };
  if (!ctx.user) throw new ApiError('not signed in', '42501', 401);
  if (t.read === 'self') return { sql: 'user_id = ?', args: [ctx.user.id] };
  const ids = allowedIds || pharmaciesWith(ctx, t.read || []);
  if (!ids.length) return { sql: '0', args: [] };
  const tenant = t.tenant || 'pharmacy_id';
  const branchCol = table === 'branches' ? 'id' : t.cols.branch_id ? 'branch_id' : null;
  if (!branchCol) return { sql: `${tenant} IN (${ids.map(() => '?').join(', ')})`, args: ids };
  const parts = [], args = [];
  for (const p of ids) {
    const role = ctx.roles.get(p);
    if (role === 'owner' || role === 'partner') { parts.push(`${tenant} = ?`); args.push(p); continue; }
    const assigned = (ctx.branchScopes.get(p) || []).filter((x) => typeof x === 'string');
    if (!assigned.length) continue;
    const branch = table === 'branches'
      ? `${branchCol} IN (SELECT value FROM json_each(?))`
      : `(${branchCol} IN (SELECT value FROM json_each(?))${assigned.includes(ctx.mainBranches.get(p)) ? ` OR ${branchCol} IS NULL` : ''})`;
    parts.push(`(${tenant} = ? AND ${branch})`);
    args.push(p, JSON.stringify(assigned));
  }
  return parts.length ? { sql: `(${parts.join(' OR ')})`, args } : { sql: '0', args: [] };
}

export function requireBranch(ctx, pharmacyId, branchId) {
  const p = String(pharmacyId), role = ctx.roles.get(p);
  if (role === 'owner' || role === 'partner') return branchId ?? ctx.mainBranches?.get(p) ?? null;
  const branch = branchId ?? ctx.mainBranches?.get(p) ?? null;
  if (!branch || !(ctx.branchScopes?.get(p) || []).includes(branch)) throw new ApiError('branch access denied', '42501', 403);
  return branch;
}

function whereOf(t, table, filters = []) {
  const parts = [], args = [];
  for (const f of filters) {
    const [col, op, val] = f;
    const [type] = colSpec(t, table, col);
    if (op === 'eq') { if (val === null) parts.push(`${col} IS NULL`); else { parts.push(`${col} = ?`); args.push(toDb(type, val)); } }
    else if (op === 'neq') { parts.push(`${col} <> ?`); args.push(toDb(type, val)); }
    else if (op === 'gte') { parts.push(`${col} >= ?`); args.push(toDb(type, val)); }
    else if (op === 'gt') { parts.push(`${col} > ?`); args.push(toDb(type, val)); }
    else if (op === 'lte') { parts.push(`${col} <= ?`); args.push(toDb(type, val)); }
    else if (op === 'lt') { parts.push(`${col} < ?`); args.push(toDb(type, val)); }
    else if (op === 'notnull') parts.push(`${col} IS NOT NULL`);
    else if (op === 'isnull') parts.push(`${col} IS NULL`);
    else if (op === 'in' && Array.isArray(val) && val.length) { parts.push(`${col} IN (${val.map(() => '?').join(', ')})`); args.push(...val.map((v) => toDb(type, v))); }
    else throw new ApiError(`unsupported filter ${op}`, 'PGRST100');
  }
  return { parts, args };
}

function columnsOf(t, table, cols) {
  const raw = String(cols || '*').split(',').map((c) => c.trim()).filter(Boolean);
  const all = Object.keys(t.cols).filter((c) => !(t.hidden || []).includes(c));
  const out = [];
  let blob = false;
  for (const c of raw) {
    if (c === '*') { out.push(...all); if (t.blob) blob = true; continue; }
    if (t.blob && c === t.blob) { blob = true; continue; }
    if ((t.hidden || []).includes(c)) throw new ApiError(`permission denied for column ${c}`, '42501', 403);
    colSpec(t, table, c);
    out.push(c);
  }
  return { cols: [...new Set(out)], blob };
}

// ---------- Select ----------
export async function select(ctx, env, q) {
  const table = q.table;
  if (table === 'members') return selectMembers(ctx, env, q);
  const t = tableOf(table);
  const { cols, blob } = columnsOf(t, table, q.cols);
  const scope = readScope(ctx, table, t);
  const w = whereOf(t, table, q.filters);
  const where = [scope.sql, ...w.parts].filter(Boolean);
  let sql = `SELECT ${[...new Set([...cols, ...(blob ? [t.pk] : [])])].join(', ')} FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  if (q.order) { colSpec(t, table, q.order.col); sql += ` ORDER BY ${q.order.col} ${q.order.asc === false ? 'DESC' : 'ASC'}`; }
  const lim = q.range ? Math.max(0, q.range[1] - q.range[0] + 1) : q.limit;
  const n = Math.min(lim ?? 1000, 1000); // like the server's 1,000-row pages
  sql += ` LIMIT ${n}${q.range ? ` OFFSET ${Math.max(0, +q.range[0] | 0)}` : ''}`;
  const res = await env.DB.prepare(sql).bind(...scope.args, ...w.args).all();
  const rows = res.results.map((r) => fromDb(t, r));
  if (!blob) return { rows };
  // The uploaded data comes from R2 as text and is put in the answer as is (not parsed here).
  const raws = await Promise.all(rows.map(async (r) => (await env.FILES.get(blobKey(table, r[t.pk])))?.text() ?? 'null'));
  return { rows, blob: { col: t.blob, raws } };
}
export const blobKey = (table, id) => `${table}/${id}.json`;

// The app's sign-in reads members with the pharmacy and its branches nested in.
async function selectMembers(ctx, env, q) {
  if (!ctx.user) throw new ApiError('not signed in', '42501', 401);
  const res = await env.DB.prepare('SELECT m.role, p.id, p.name, p.settings FROM members m JOIN pharmacies p ON p.id = m.pharmacy_id WHERE m.user_id = ?').bind(ctx.user.id).all();
  const withBranches = /branches/.test(String(q.cols));
  const out = [];
  for (const r of res.results) {
    const role = r.role;
    const main = await env.DB.prepare('SELECT id FROM branches WHERE pharmacy_id = ? ORDER BY created_at, id LIMIT 1').bind(r.id).first();
    const ph = { id: r.id, name: r.name, settings: JSON.parse(r.settings || '{}'), main_branch_id: main?.id ?? null, branch_scope_version: 1 };
    if (withBranches) {
      let branches = (await env.DB.prepare('SELECT id, name, created_at FROM branches WHERE pharmacy_id = ? ORDER BY created_at, id').bind(r.id).all()).results;
      if (!['owner', 'partner'].includes(role)) {
        const allowed = new Set(ctx.branchScopes?.get(r.id) || []);
        branches = branches.filter((b) => allowed.has(b.id));
      }
      ph.branches = branches;
    }
    out.push({ role: r.role, pharmacies: ph });
  }
  return { rows: out };
}

// ---------- Changes ----------
// Same-pharmacy links: a receipt's customer, a reminder's patient… must be in the same pharmacy.
async function checkRefs(env, t, row) {
  for (const [col, ref] of Object.entries(t.refs || {})) {
    if (row[col] === null || row[col] === undefined) continue;
    const hit = await env.DB.prepare(`SELECT 1 FROM ${ref} WHERE id = ? AND pharmacy_id = ?`).bind(String(row[col]), String(row.pharmacy_id)).first();
    if (!hit) throw new ApiError(col === 'branch_id' ? 'unknown branch' : col === 'employee_id' ? 'unknown employee' : col === 'shift_id' ? 'unknown shift' : `insert or update on table violates foreign key constraint (${col})`, '23503');
  }
}

const auditRow = (ctx, table, op, before, after) => {
  const r = after || before;
  const strip = (x) => { if (!x) return null; const { pin_hash, ...rest } = x; return rest; };
  return { pharmacy_id: r.pharmacy_id, at: nowIso(), user_id: ctx.user?.id ?? null, table_name: table, op, row_id: r.id != null ? String(r.id) : null,
    old_row: JSON.stringify(strip(before)), new_row: JSON.stringify(strip(after)) };
};
const auditStmt = (env, a) => env.DB.prepare('INSERT INTO audit_log (pharmacy_id, at, user_id, table_name, op, row_id, old_row, new_row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .bind(a.pharmacy_id, a.at, a.user_id, a.table_name, a.op, a.row_id, a.old_row, a.new_row);

// Inserts (or upserts with ignoreDuplicates: rows whose id is already there are left alone).
export async function insert(ctx, env, q, hooks = {}) {
  const table = q.table;
  const t = tableOf(table);
  if (!t.insert) throw new ApiError('not allowed', '42501', 403);
  const list = Array.isArray(q.rows) ? q.rows : [q.rows];
  if (!list.length || list.length > 500) throw new ApiError('bad rows');
  const stmts = [];
  const guarded = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') throw new ApiError('bad row');
    for (const k of Object.keys(raw)) colSpec(t, table, k);
    const row = withDefaults(t, raw);
    if ('created_by' in t.cols) row.created_by = ctx.user?.id ?? null;
    requireRole(ctx, row.pharmacy_id, t.insert);
    if (t.cols.branch_id) requireBranch(ctx, row.pharmacy_id, row.branch_id);
    for (const [col, spec] of Object.entries(t.cols)) checkValue(table, col, spec, row[col]);
    if (q.ignoreDuplicates && t.pk && row[t.pk] != null) {
      if (table === 'pos_sales') {
        // A receipt sent again (a retry after a lost answer) is the same receipt: skip it. The same id
        // with different contents is not a retry: refuse it, so it is kept aside on the device with the
        // reason instead of being silently dropped (src/offline.js).
        const had = await env.DB.prepare('SELECT pharmacy_id, kind, number, sold_at, total, lines, return_of FROM pos_sales WHERE id = ?').bind(String(row.id)).first();
        if (had) { if (sameReceipt(had, row)) continue; throw new ApiError('conflicting receipt id', '23505', 409); }
      } else if (await env.DB.prepare(`SELECT 1 FROM ${table} WHERE ${t.pk} = ?`).bind(String(row[t.pk])).first()) continue;
    }
    await checkRefs(env, t, row);
    const found = hooks.beforeInsert ? await hooks.beforeInsert(table, row) : null;
    // A receipt's time of arrival is the server's, never the device's (sold_at is the device's).
    if (table === 'pos_sales') row.created_at = nowIso();
    const cols = Object.keys(row).filter((c) => row[c] !== undefined && t.cols[c][0] !== 'serial');
    if (table === 'pos_sales') {
      guarded.push(row);
      stmts.push(guardedSaleInsert(env, row, cols, !!(q.ignoreDuplicates && t.pk), branchKey(ctx, row), needOf(row)));
      // A return with no receipt is kept in the log of changes, with who made it.
      if (row.kind === 'return' && !row.return_of) stmts.push(auditStmt(env, auditRow(ctx, table, 'insert', null, row)));
      // Times that need a look (checkPosSale): stored, never refused, in the log of changes.
      if (found?.flags?.length) stmts.push(auditStmt(env, auditRow(ctx, table, 'flag', null, { id: row.id, pharmacy_id: row.pharmacy_id, number: row.number, sold_at: row.sold_at, received_at: row.created_at, flags: found.flags })));
    } else stmts.push(env.DB.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})${q.ignoreDuplicates && t.pk ? ` ON CONFLICT(${t.pk}) DO NOTHING` : ''}`)
      .bind(...cols.map((c) => toDb(t.cols[c][0], row[c]))));
    if (t.audit) stmts.push(auditStmt(env, auditRow(ctx, table, 'insert', null, row)));
    // The stock this record moves, in the same atomic batch (stock.js; INSERT OR IGNORE, so a retry adds nothing).
    const ledger = ledgerStmt(env, ctx, table, row);
    if (ledger) stmts.push(ledger);
  }
  if (stmts.length) {
    try { await runBatch(env, stmts); } catch (e) {
      if (guarded.length && /NOT NULL constraint failed: pos_sales\.id/i.test(String(e?.message))) {
        // Which guard refused it: the number already used, or a return of more than is left.
        // (Nothing of this request was stored: the whole batch was rolled back.)
        const inRequest = new Set();
        for (const r of guarded) {
          const k = `${r.pharmacy_id}\n${r.number}`;
          if (inRequest.has(k)) throw new ApiError('receipt number already used', '23505', 409);
          inRequest.add(k);
          if (await env.DB.prepare('SELECT 1 FROM pos_sales WHERE pharmacy_id = ? AND number = ? AND id <> ?').bind(r.pharmacy_id, r.number, r.id).first()) throw new ApiError('receipt number already used', '23505', 409);
        }
        // Not enough stock where the branch blocks selling below zero.
        for (const r of guarded) {
          const short = await shortOf(env, r.pharmacy_id, branchKey(ctx, r), needOf(r));
          if (short) throw new ApiError(`insufficient stock: ${short}`, '23514', 409);
        }
        throw guarded.some((r) => r.kind === 'return' && r.return_of) ? new ApiError('return more than sold') : new ApiError('receipt number already used', '23505', 409);
      }
      throw e;
    }
  }
  return { rows: null };
}

export async function update(ctx, env, q) {
  const table = q.table;
  const t = tableOf(table);
  if (!t.update) throw new ApiError('not allowed', '42501', 403);
  const patch = q.patch || {};
  const keys = Object.keys(patch);
  if (!keys.length) return { rows: null };
  for (const k of keys) {
    colSpec(t, table, k);
    if (!t.updCols.includes(k)) throw new ApiError(`permission denied for column ${k}`, '42501', 403);
    checkValue(table, k, t.cols[k], patch[k]);
  }
  const ids = pharmaciesWith(ctx, t.update);
  if (!ctx.user) throw new ApiError('not signed in', '42501', 401);
  const w = whereOf(t, table, q.filters);
  if (!w.parts.length) throw new ApiError('UPDATE requires a WHERE clause', '21000');
  if (!ids.length) return { rows: null };
  const scope = readScope(ctx, table, t, ids);
  const where = [scope.sql, ...w.parts, ...(t.updWhenNull ? [`${t.updWhenNull} IS NULL`] : [])].join(' AND ');
  const before = (await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where}`).bind(...scope.args, ...w.args).all()).results;
  if (!before.length) return { rows: null };
  if (t.cols.branch_id && 'branch_id' in patch) for (const r of before) requireBranch(ctx, r.pharmacy_id, patch.branch_id);
  const stmts = [env.DB.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${t.pk} IN (${before.map(() => '?').join(', ')})`)
    .bind(...keys.map((k) => toDb(t.cols[k][0], patch[k])), ...before.map((r) => r[t.pk]))];
  if (t.audit) for (const b of before) { const old = fromDb(t, b); stmts.push(auditStmt(env, auditRow(ctx, table, 'update', old, { ...old, ...patch }))); }
  await runBatch(env, stmts);
  return { rows: null };
}

export async function remove(ctx, env, q) {
  const table = q.table;
  const t = tableOf(table);
  if (!t.del) throw new ApiError('not allowed', '42501', 403);
  if (!ctx.user) throw new ApiError('not signed in', '42501', 401);
  const w = whereOf(t, table, q.filters);
  if (!w.parts.length) throw new ApiError('DELETE requires a WHERE clause', '21000');
  const roleIds = t.del === 'owner-or-author' ? pharmaciesWith(ctx, ['owner']) : pharmaciesWith(ctx, t.del);
  const scope = t.del === 'owner-or-author'
    ? { sql: `(pharmacy_id IN (${roleIds.map(() => '?').join(', ') || "''"}) OR (created_by = ? AND pharmacy_id IN (${pharmaciesWith(ctx, ['owner', 'partner']).map(() => '?').join(', ') || "''"})))`, args: [...roleIds, ctx.user.id, ...pharmaciesWith(ctx, ['owner', 'partner'])] }
    : roleIds.length ? { sql: `pharmacy_id IN (${roleIds.map(() => '?').join(', ')})`, args: roleIds } : null;
  if (!scope) return { rows: null };
  const where = [scope.sql, ...w.parts].join(' AND ');
  const gone = (await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where}`).bind(...scope.args, ...w.args).all()).results;
  if (!gone.length) return { rows: null };
  const ids = gone.map((r) => r[t.pk]);
  const marks = ids.map(() => '?').join(', ');
  const stmts = [];
  for (const [child, col] of Object.entries(t.cascade || {})) {
    const ct = TABLES[child];
    if (ct.audit) for (const c of (await env.DB.prepare(`SELECT * FROM ${child} WHERE ${col} IN (${marks})`).bind(...ids).all()).results) stmts.push(auditStmt(env, auditRow(ctx, child, 'delete', fromDb(ct, c), null)));
    stmts.push(env.DB.prepare(`DELETE FROM ${child} WHERE ${col} IN (${marks})`).bind(...ids));
  }
  for (const [child, col] of Object.entries(t.setNull || {})) stmts.push(env.DB.prepare(`UPDATE ${child} SET ${col} = NULL WHERE ${col} IN (${marks})`).bind(...ids));
  // A deleted purchase or stock move: the stock it added or took is undone by new ledger rows (stock.js).
  const reversal = reversalStmt(env, ctx, table, ids);
  if (reversal) stmts.push(reversal);
  stmts.push(env.DB.prepare(`DELETE FROM ${table} WHERE ${t.pk} IN (${marks})`).bind(...ids));
  if (t.audit) for (const g of gone) stmts.push(auditStmt(env, auditRow(ctx, table, 'delete', fromDb(t, g), null)));
  await runBatch(env, stmts);
  return { rows: null };
}

export async function runBatch(env, stmts) {
  try { return await env.DB.batch(stmts); } catch (e) {
    const m = String(e?.message ?? e);
    if (/UNIQUE constraint failed/i.test(m)) throw new ApiError(`duplicate key value violates unique constraint (${m.split('failed:')[1]?.trim() || ''})`, '23505', 409);
    if (/FOREIGN KEY|NOT NULL/i.test(m)) throw new ApiError(m, '23502');
    throw e;
  }
}
