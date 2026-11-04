// Stock kept by the server (Phase 2 M1; tables in migrations/0013_stock_ledger.sql).
//
// Every sale, return, purchase, supplier return and stock move adds rows to stock_ledger in the same
// atomic batch as the record itself (one statement per record, built from a JSON list, so a big
// receipt stays one query). A trigger keeps stock_levels = the sum of each row's `applied`. The
// quantities follow the app's own rules (src/inventory.js liveData):
//   sale −qty/per · return +qty/per · purchase +(qty+bonus) · supplier return −qty · stock move ±qty
// and a movement dated at or before the branch's base (the uploaded pharmacy-program file the levels
// start from) changes nothing, because that file already holds it — EXCEPT in a branch that blocks
// selling below zero and has opened its levels: there the server is the stock authority, so every
// movement it receives counts (a device clock set back before the base can't make a sale take nothing;
// such receipts are also flagged 'before_base', rpc.js timeFlags).
import { ApiError, nowIso, uuid } from './db.js';

const boxes = (l) => (+l.qty || 0) / (+l.per > 1 ? +l.per : 1);
const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : nowIso(); };
export const branchKey = (ctx, row) => row.branch_id ?? ctx.mainBranches?.get(String(row.pharmacy_id)) ?? null;

// The movements one record makes: [{ code, qty }] in boxes, one entry per line, kind, and its time.
export function movementsOf(table, row) {
  if (table === 'pos_sales') {
    const sign = row.kind === 'return' ? 1 : -1;
    return { kind: row.kind === 'return' ? 'return' : 'sale', at: row.sold_at, lines: (row.lines || []).map((l) => ({ code: String(l.code), qty: sign * boxes(l) })) };
  }
  if (table === 'purchases') {
    const back = row.kind === 'return';
    return { kind: back ? 'supplier_return' : 'purchase', at: row.created_at, lines: (row.lines || []).map((l) => ({ code: String(l.code), qty: back ? -(+l.qty || 0) : (+l.qty || 0) + (+l.bonus || 0) })) };
  }
  if (table === 'stock_moves') return { kind: `move:${row.kind}`, at: row.happened_at, lines: [{ code: String(row.code), qty: +row.qty || 0 }] };
  return null;
}

// The one statement that writes a record's ledger rows (ids "<table>:<record id>:<line>", so a retry
// of the same record adds nothing: INSERT OR IGNORE).
export function ledgerStmt(env, ctx, table, row) {
  const m = movementsOf(table, row);
  if (!m) return null;
  const branch = branchKey(ctx, row);
  if (!branch) return null; // a pharmacy with no branch yet: nothing to keep levels for
  const lines = m.lines.map((l, i) => ({ i, code: l.code, qty: Math.round(l.qty * 1e6) / 1e6 })).filter((l) => l.qty !== 0 && Number.isFinite(l.qty));
  if (!lines.length) return null;
  const at = iso(m.at);
  return env.DB.prepare(`INSERT OR IGNORE INTO stock_ledger (id, pharmacy_id, branch_id, code, qty, applied, kind, source_table, source_id, effective_at, received_at, created_by)
    SELECT ? || ':' || ? || ':' || json_extract(j.value, '$.i'), ?, ?, json_extract(j.value, '$.code'), json_extract(j.value, '$.qty'),
      CASE WHEN ? > COALESCE((SELECT base_at FROM stock_bases WHERE pharmacy_id = ? AND branch_id = ?), '')
        OR EXISTS (SELECT 1 FROM stock_bases WHERE pharmacy_id = ? AND branch_id = ? AND block_negative = 1 AND stale = 0 AND opened_at IS NOT NULL)
        THEN json_extract(j.value, '$.qty') ELSE 0 END,
      ?, ?, ?, ?, ?, ?
    FROM json_each(?) j`)
    .bind(table, String(row.id), row.pharmacy_id, branch, at, row.pharmacy_id, branch, row.pharmacy_id, branch, m.kind, table, String(row.id), at, nowIso(), ctx.user?.id ?? null, JSON.stringify(lines));
}

// Deleting a purchase or a stock move adds rows that undo exactly what it had added (history stays).
export function reversalStmt(env, ctx, table, ids) {
  if (!['purchases', 'stock_moves'].includes(table) || !ids.length) return null;
  return env.DB.prepare(`INSERT OR IGNORE INTO stock_ledger (id, pharmacy_id, branch_id, code, qty, applied, kind, source_table, source_id, effective_at, received_at, created_by)
    SELECT 'rev:' || id, pharmacy_id, branch_id, code, -qty, -applied, 'reversal', source_table, source_id, effective_at, ?, ?
    FROM stock_ledger WHERE source_table = ? AND source_id IN (${ids.map(() => '?').join(', ')}) AND kind NOT IN ('reversal', 'opening')`)
    .bind(nowIso(), ctx.user?.id ?? null, table, ...ids.map(String));
}

// For a sale: what it takes out, per item, in boxes — checked against the levels when the branch blocks
// selling below zero (db.js guardedSaleInsert).
export function needOf(row) {
  if (row.kind === 'return') return [];
  const m = new Map();
  for (const l of row.lines || []) m.set(String(l.code), (m.get(String(l.code)) || 0) + boxes(l));
  return [...m].map(([code, qty]) => ({ code, qty: Math.round(qty * 1e6) / 1e6 }));
}

// ---------- Opening the levels, and the policy ----------
// The owner (or stock manager) sets the levels from the numbers the app shows now, for one branch:
//   p_base_at   the time of the uploaded file the app's numbers start from (null if none)
//   p_watermark the server time (stock_status.server_now) taken BEFORE the app loaded its data:
//               movements the server received after it were not in the app's numbers, so they are
//               added on top (a sale made while the owner was opening is not lost)
//   p_items     [{ code, qty }] the app's stock per item for that branch (every item, zeros too)
// It writes one 'opening' ledger row per item (the difference to the target), so it is auditable,
// and items with a level that are not in the list go to 0.
export async function openStock(env, ctx, { p_pharmacy, p_branch, p_base_at = null, p_watermark, p_items }) {
  const branch = p_branch ?? ctx.mainBranches?.get(String(p_pharmacy)) ?? null;
  if (!branch) throw new ApiError('unknown branch');
  if (!Array.isArray(p_items) || p_items.length > 100000) throw new ApiError('bad items');
  const seen = new Map();
  for (const it of p_items) {
    const code = String(it?.code ?? '');
    if (!code || code.length > 60 || !Number.isFinite(+it.qty) || Math.abs(+it.qty) > 9999999) throw new ApiError('bad items');
    seen.set(code, Math.round(+it.qty * 1e6) / 1e6);
  }
  const wm = Date.parse(p_watermark);
  if (!Number.isFinite(wm) || wm > Date.now() + 60000) throw new ApiError('bad watermark');
  const base = p_base_at == null ? null : Date.parse(p_base_at);
  if (p_base_at != null && !Number.isFinite(base)) throw new ApiError('bad base time');
  const baseIso = base == null ? '' : new Date(base).toISOString();
  const now = nowIso(), id = uuid(), wmIso = new Date(wm).toISOString();
  const items = JSON.stringify([...seen].map(([code, qty]) => ({ code, qty })));
  // What arrived after the app loaded (and is after the base): kept on top of the app's numbers.
  const after = `COALESCE((SELECT SUM(CASE WHEN g.effective_at > ? THEN g.qty ELSE 0 END) FROM stock_ledger g
      WHERE g.pharmacy_id = ? AND g.branch_id = ? AND g.code = X.code AND g.received_at > ? AND g.kind <> 'opening'), 0)`;
  const level = `COALESCE((SELECT qty FROM stock_levels v WHERE v.pharmacy_id = ? AND v.branch_id = ? AND v.code = X.code), 0)`;
  const cols = 'id, pharmacy_id, branch_id, code, qty, applied, kind, source_table, source_id, effective_at, received_at, created_by';
  const stmtListed = env.DB.prepare(`INSERT INTO stock_ledger (${cols})
    SELECT 'open:' || ? || ':' || X.code, ?, ?, X.code, X.target + ${after} - ${level}, X.target + ${after} - ${level}, 'opening', 'stock_openings', ?, ?, ?, ?
    FROM (SELECT json_extract(value, '$.code') AS code, json_extract(value, '$.qty') AS target FROM json_each(?)) X`)
    .bind(id, p_pharmacy, branch,
      baseIso, p_pharmacy, branch, wmIso, p_pharmacy, branch,
      baseIso, p_pharmacy, branch, wmIso, p_pharmacy, branch,
      id, now, now, ctx.user?.id ?? null, items);
  // Items with a level that the app no longer lists: to zero (plus what arrived after the app loaded).
  const stmtRest = env.DB.prepare(`INSERT INTO stock_ledger (${cols})
    SELECT 'open:' || ? || ':' || X.code, ?, ?, X.code, ${after} - X.qty, ${after} - X.qty, 'opening', 'stock_openings', ?, ?, ?, ?
    FROM stock_levels X WHERE X.pharmacy_id = ? AND X.branch_id = ? AND X.code NOT IN (SELECT json_extract(value, '$.code') FROM json_each(?))`)
    .bind(id, p_pharmacy, branch, baseIso, p_pharmacy, branch, wmIso, baseIso, p_pharmacy, branch, wmIso, id, now, now, ctx.user?.id ?? null, p_pharmacy, branch, items);
  const stmtBase = env.DB.prepare(`INSERT INTO stock_bases (pharmacy_id, branch_id, base_at, opened_at, stale, block_negative, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?)
    ON CONFLICT (pharmacy_id, branch_id) DO UPDATE SET base_at = excluded.base_at, opened_at = excluded.opened_at, stale = 0, updated_at = excluded.updated_at`)
    .bind(p_pharmacy, branch, baseIso || null, now, now);
  const audit = env.DB.prepare('INSERT INTO audit_log (pharmacy_id, at, user_id, table_name, op, row_id, old_row, new_row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(p_pharmacy, now, ctx.user?.id ?? null, 'stock_openings', 'insert', id, null, JSON.stringify({ id, branch_id: branch, base_at: baseIso || null, watermark: wmIso, items: seen.size }));
  await env.DB.batch([stmtListed, stmtRest, stmtBase, audit]);
  return { opening_id: id, items: seen.size, opened_at: now };
}
