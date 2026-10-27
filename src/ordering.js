// Pure helpers: suppliers and orders, price changes between uploads, monthly fixed expenses.
// No DOM, no network — shared by the page and the tests.
import { startOfDay } from './core.js';

// ---------- Suppliers ----------
// A supplier: { id, name, phone, discounts: { all, medicine, cosmetics, supplies } } — extra discount %
// on top of the purchase price. Suppliers live in the pharmacy settings (shared with partners).
export function itemKind(category) {
  const c = String(category ?? '').toLowerCase();
  if (/دواء|ادوية|أدوية|medicine|drug|pharma/.test(c)) return 'medicine';
  if (/تجميل|cosmetic|beauty|skin/.test(c)) return 'cosmetics';
  if (/مستلزم|supplies|device|medical/.test(c)) return 'supplies';
  return 'other';
}

export function discountFor(supplier, row) {
  const d = supplier?.discounts || {};
  const k = itemKind(row.category);
  const v = d[k] !== undefined && d[k] !== '' && d[k] !== null ? d[k] : d.all;
  return Math.max(0, Math.min(100, +v || 0));
}

// The supplier to order an item from: the one picked by hand for that item, else the biggest discount.
export function pickSupplier(row, suppliers, chosen = {}) {
  if (!suppliers?.length) return null;
  const manual = chosen[row.code] && suppliers.find((s) => s.id === chosen[row.code]);
  if (manual) return { supplier: manual, pct: discountFor(manual, row), manual: true };
  let best = null;
  for (const s of suppliers) {
    const pct = discountFor(s, row);
    if (!best || pct > best.pct) best = { supplier: s, pct, manual: false };
  }
  return best;
}

// Reorder list grouped by supplier, with the cost after each supplier's discount.
export function ordersBySupplier(reorder, suppliers, chosen = {}) {
  const groups = new Map();
  for (const r of reorder) {
    if (!(r.order > 0)) continue;
    const p = pickSupplier(r, suppliers, chosen);
    const id = p?.supplier.id ?? '';
    if (!groups.has(id)) groups.set(id, { supplier: p?.supplier ?? null, lines: [], cost: 0, saved: 0 });
    const g = groups.get(id);
    const unit = r.cost * (1 - (p?.pct ?? 0) / 100);
    g.lines.push({ code: r.code, name: r.name, qty: r.order, unit, pct: p?.pct ?? 0 });
    g.cost += unit * r.order;
    g.saved += (r.cost - unit) * r.order;
  }
  // Suppliers first (biggest order first), items with no supplier last.
  return [...groups.values()].sort((a, b) => (!a.supplier) - (!b.supplier) || b.cost - a.cost);
}

export function orderMessage(group, { pharmacyName = 'الصيدلية', branchName = '' } = {}) {
  const head = `طلبية من ${pharmacyName}${branchName ? ` (${branchName})` : ''}`;
  const lines = group.lines.map((l) => `• ${l.name}: ${l.qty}`);
  return `${head}\n\n${lines.join('\n')}\n\nمن فضلك أكد المتاح والسعر وميعاد التوصيل. شكراً.`;
}

// ---------- Price changes between the last two uploads ----------
export function priceChanges(prevItems, curItems) {
  const prev = new Map(prevItems.map((i) => [i.code, i]));
  const out = [];
  for (const c of curItems) {
    const p = prev.get(c.code);
    if (!p) continue;
    const priceMoved = Math.abs((+c.price || 0) - (+p.price || 0)) > 0.009;
    const costMoved = Math.abs((+c.cost || 0) - (+p.cost || 0)) > 0.009;
    if (!priceMoved && !costMoved) continue;
    out.push({
      code: c.code, name: c.name, category: c.category, owner: c.owner, qty: c.qty,
      oldPrice: +p.price || 0, newPrice: +c.price || 0, oldCost: +p.cost || 0, newCost: +c.cost || 0,
      priceMoved, costMoved,
      pct: p.price > 0 ? ((c.price - p.price) / p.price) * 100 : 0,
      oldMargin: (+p.price || 0) - (+p.cost || 0), newMargin: (+c.price || 0) - (+c.cost || 0),
    });
  }
  return out.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct) || b.qty - a.qty);
}

// ---------- Monthly fixed expenses ----------
// Last month's fixed costs (rent, salaries) that aren't recorded yet this month, to add in one tap.
export const FIXED_KINDS = ['rent', 'salaries'];
export function recurringSuggestions(expenses, today = startOfDay()) {
  const t = startOfDay(today);
  const thisMonth = new Date(t.getFullYear(), t.getMonth(), 1);
  const lastMonth = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  const day = (v) => startOfDay(typeof v === 'string' ? new Date(`${v.slice(0, 10)}T00:00:00`) : v);
  const keyOf = (e) => `${e.kind}|${e.branch_id ?? ''}|${(e.note || '').trim()}`;
  const live = expenses.filter((e) => !e.deleted && FIXED_KINDS.includes(e.kind));
  const done = new Set(live.filter((e) => day(e.spent_on) >= thisMonth).map(keyOf));
  const seen = new Set();
  const out = [];
  for (const e of live.filter((x) => day(x.spent_on) >= lastMonth && day(x.spent_on) < thisMonth)) {
    const k = keyOf(e);
    if (done.has(k) || seen.has(k)) continue;
    seen.add(k);
    // Same day of the month as last time, but never in the future.
    const d = day(e.spent_on);
    const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    let on = new Date(t.getFullYear(), t.getMonth(), Math.min(d.getDate(), last));
    if (on > t) on = t;
    out.push({ kind: e.kind, amount: +e.amount, branch_id: e.branch_id ?? null, note: e.note ?? null, spent_on: on });
  }
  return out;
}
