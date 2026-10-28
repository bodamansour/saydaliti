// Pure helpers for branches and recorded expenses — no DOM, shared by the page and the tests.
import { addDays, startOfDay } from './core.js';

// Merge several branches' data into one view (the "all branches" dashboard).
// Items with the same code are combined: stock and batches add up; cost/price/name come from the first branch that has the item.
export function mergeBranches(list) {
  const parts = list.filter(Boolean);
  if (parts.length === 1) return parts[0];
  const byCode = new Map(); // code -> copies of that item, one per branch
  const out = { items: [], sales: [], purchases: [], losses: [], real: true };
  for (const d of parts) {
    for (const it of d.items) {
      if (!byCode.has(it.code)) byCode.set(it.code, []);
      byCode.get(it.code).push(it);
    }
    out.sales.push(...d.sales);
    out.purchases.push(...(d.purchases || []));
    out.losses.push(...(d.losses || []));
  }
  for (const copies of byCode.values()) {
    const [first] = copies;
    if (copies.length === 1) { out.items.push(first); continue; }
    const qty = copies.reduce((a, x) => a + x.qty, 0);
    const expiries = copies.map((x) => x.expiry).filter(Boolean);
    const expiry = expiries.length ? new Date(Math.min(...expiries.map((x) => x.getTime()))) : null;
    const merged = { ...first, qty, expiry };
    delete merged.batches;
    // Keep expiry detail: a branch without batch rows counts as one batch with its own expiry.
    if (copies.some((x) => x.batches)) merged.batches = copies.flatMap((x) => x.batches ?? (x.qty ? [{ qty: x.qty, expiry: x.expiry ?? null }] : []));
    out.items.push(merged);
  }
  return out;
}

export const EXPENSE_KINDS = [
  ['electricity', 'كهربا'],
  ['water', 'مية'],
  ['rent', 'إيجار'],
  ['salaries', 'مرتبات'],
  ['maintenance', 'صيانة وتصليحات'],
  ['supplies', 'أدوات ومستلزمات تشغيل'],
  ['other', 'مصاريف تانية'],
  ['withdrawal', 'مسحوبات (فلوس خرجت لصاحب الصيدلية أو شريك)'],
];
export const kindLabel = (k) => (EXPENSE_KINDS.find(([id]) => id === k) || [, k])[1];

// Expenses in [from, to) — dates are yyyy-mm-dd strings or Dates. Withdrawals are cash taken out, not a running cost,
// so they are kept apart from operating expenses and never reduce profit.
export function expenseTotals(expenses, from = null, to = null, branchId = 'all') {
  const day = (v) => startOfDay(typeof v === 'string' ? new Date(`${v}T00:00:00`) : v);
  const byKind = {};
  let operating = 0, withdrawals = 0, count = 0;
  for (const e of expenses) {
    if (e.deleted) continue;
    if (branchId !== 'all' && e.branch_id !== branchId) continue;
    const d = day(e.spent_on);
    if ((from && d < from) || (to && d >= to)) continue;
    const a = +e.amount || 0;
    byKind[e.kind] = (byKind[e.kind] || 0) + a;
    if (e.kind === 'withdrawal') withdrawals += a; else operating += a;
    count += 1;
  }
  return { byKind, operating, withdrawals, count };
}

// Average monthly running cost from what was recorded in the last `days` days (null if nothing recorded).
// Used for the per-item profit calculator instead of the typed-in monthly estimate once real entries exist.
export function monthlyFromRecorded(expenses, today = startOfDay(), days = 90, branchId = 'all') {
  const t = expenseTotals(expenses, addDays(today, -days), addDays(today, 1), branchId);
  if (!t.operating) return null;
  const dated = expenses.filter((e) => !e.deleted && e.kind !== 'withdrawal' && (branchId === 'all' || e.branch_id === branchId))
    .map((e) => startOfDay(typeof e.spent_on === 'string' ? new Date(`${e.spent_on}T00:00:00`) : e.spent_on))
    .filter((d) => d >= addDays(today, -days));
  const first = Math.min(...dated.map((d) => d.getTime()));
  const span = Math.max(30, Math.round((today - first) / 86400000) + 1);
  return (t.operating / span) * 30;
}
