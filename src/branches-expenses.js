// Pure helpers for branches and recorded expenses — no DOM, shared by the page and the tests.
import { addDays, startOfDay } from './core.js';

// Merge several branches' data into one view (the "all branches" dashboard).
// Items with the same code are combined: stock and batches add up; cost/price/name come from the first branch that has the item.
export function mergeBranches(list) {
  const parts = list.filter(Boolean);
  if (parts.length === 1) return parts[0];
  const byCode = new Map(); // code -> copies of that item, one per branch
  const out = { items: [], sales: [], purchases: [], losses: [], drawings: [], real: true };
  for (const d of parts) {
    for (const it of d.items) {
      if (!byCode.has(it.code)) byCode.set(it.code, []);
      byCode.get(it.code).push(it);
    }
    out.sales.push(...d.sales);
    out.purchases.push(...(d.purchases || []));
    out.losses.push(...(d.losses || []));
    out.drawings.push(...(d.drawings || []));
    if (d.barcodes) (out.barcodes ||= []).push(...d.barcodes);
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

// ---------- Owner withdrawals ----------
// Money taken out (expenses of kind 'withdrawal') and goods taken (stock moves of kind 'withdrawal',
// at what the boxes cost), in [from, to), per person. Neither is a cost of running the pharmacy:
// they come out of the profit that is left, not out of the profit itself.
export const OWNER_LABEL = 'صاحب الصيدلية';
export function withdrawals(expenses, drawings = [], from = null, to = null, branchId = 'all') {
  const day = (v) => startOfDay(typeof v === 'string' ? new Date(`${String(v).slice(0, 10)}T00:00:00`) : v);
  const inRange = (v) => { const d = day(v); return (!from || d >= from) && (!to || d < to); };
  const rows = [];
  for (const e of expenses) {
    if (e.deleted || e.kind !== 'withdrawal' || !inRange(e.spent_on)) continue;
    if (branchId !== 'all' && e.branch_id !== branchId) continue;
    rows.push({ id: e.id, type: 'cash', date: String(e.spent_on).slice(0, 10), person: (e.person || '').trim() || OWNER_LABEL, amount: Math.round((+e.amount || 0) * 100) / 100, note: e.note || '', fromDrawer: !!e.shift_id, branch_id: e.branch_id ?? null, pending: !!e.pending });
  }
  for (const g of drawings) {
    if (!inRange(g.date)) continue;
    if (branchId !== 'all' && g.branch_id !== branchId) continue;
    const d = g.date instanceof Date ? g.date : day(g.date);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    rows.push({ id: g.id, type: 'goods', date: iso, person: (g.person || '').trim() || OWNER_LABEL, amount: g.value, note: `${g.qty} × ${g.name}`, code: g.code, branch_id: g.branch_id ?? null, pending: !!g.pending });
  }
  rows.sort((a, b) => b.date.localeCompare(a.date));
  const people = new Map();
  for (const r of rows) {
    if (!people.has(r.person)) people.set(r.person, { person: r.person, cash: 0, goods: 0, total: 0 });
    const p = people.get(r.person);
    p[r.type] += r.amount; p.total += r.amount;
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  const byPerson = [...people.values()].map((p) => ({ ...p, cash: r2(p.cash), goods: r2(p.goods), total: r2(p.total) })).sort((a, b) => b.total - a.total);
  const cash = r2(byPerson.reduce((a, p) => a + p.cash, 0)), goods = r2(byPerson.reduce((a, p) => a + p.goods, 0));
  return { rows, byPerson, cash, goods, total: r2(cash + goods) };
}
