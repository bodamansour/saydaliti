// Stock kept in Saydaliti itself — no DOM, no network.
// The last file uploaded from the pharmacy program is the starting stock. On top of it, in time order:
//   • items added or edited here (catalog_items): new items, new names and prices
//   • purchase invoices received after the upload: stock in, with expiry; the new buying price
//   • cashier receipts after the upload: stock out (earliest expiry first); returns put stock back
//   • adjustments after the upload: stock count, damaged/expired, returns to supplier, transfers
// The result has the same shape as an uploaded file, so every report keeps working unchanged.
import { UNASSIGNED } from './core.js';

const time = (v) => (v ? new Date(v).getTime() : 0);
const dayOf = (v) => { const d = new Date(v); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const fromIsoDay = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`) : null);
const round2 = (n) => Math.round(n * 100) / 100;

export const EMPTY_DATA = () => ({ items: [], sales: [], purchases: [], losses: [], real: true });

function copyItem(it) {
  return { ...it, ...(it.batches ? { batches: it.batches.map((b) => ({ ...b })) } : {}) };
}

// Stock as batches (earliest expiry first), so stock can be taken out and put back per batch.
function batchesFor(it) {
  if (!it.batches) it.batches = it.qty ? [{ qty: it.qty, expiry: it.expiry ?? null }] : [];
  return it.batches;
}
const sortBatches = (list) => list.sort((a, b) => (a.expiry ? a.expiry.getTime() : Infinity) - (b.expiry ? b.expiry.getTime() : Infinity));

function settle(it) {
  if (!it.batches) return;
  const owed = it.short || 0; // sold with no stock recorded (stock wasn't entered yet)
  it.batches = it.batches.filter((b) => b.qty > 0);
  it.qty = it.batches.reduce((a, b) => a + b.qty, 0) - owed;
  if (!it.batches.length) delete it.batches;
  it.expiry = it.batches?.find((b) => b.expiry)?.expiry ?? null;
  delete it.short;
}

function takeOut(it, qty) {
  const list = sortBatches(batchesFor(it));
  let left = qty;
  for (const b of list) {
    const n = Math.min(b.qty, left);
    b.qty -= n; left -= n;
    if (!left) break;
  }
  if (left > 0) it.short = (it.short || 0) + left;
}

function putBack(it, qty, expiry = null) {
  const list = batchesFor(it);
  let n = qty;
  if (it.short) { const pay = Math.min(it.short, n); it.short -= pay; n -= pay; }
  if (!n) return;
  const same = list.find((b) => (b.expiry?.getTime() ?? null) === (expiry?.getTime() ?? null));
  if (same) same.qty += n; else list.push({ qty: n, expiry });
}

function newItem(code, row = {}) {
  return { code, name: row.name || code, category: row.category || 'غير محدد', owner: UNASSIGNED, cost: +row.cost || 0, price: +row.price || 0, qty: 0, expiry: null };
}

export const LOSS_REASON = { damaged: 'تالف', expired: 'منتهي الصلاحية' };

export function liveData(base, baseAt, { catalog = [], purchases = [], sales = [], moves = [] } = {}) {
  const out = base ? { ...base, items: base.items.map(copyItem), sales: [...base.sales], purchases: [...(base.purchases || [])], losses: [...(base.losses || [])] } : EMPTY_DATA();
  const since = time(baseAt);
  const byCode = new Map(out.items.map((i) => [i.code, i]));
  const get = (code, row) => {
    let it = byCode.get(code);
    if (!it) { it = newItem(code, row); byCode.set(code, it); out.items.push(it); }
    return it;
  };

  const events = [];
  // Items added here always exist; their name and prices count only if set after the upload.
  for (const c of catalog) events.push({ t: time(c.updated_at || c.created_at), kind: 'item', row: c });
  for (const p of purchases) if (time(p.created_at) > since) events.push({ t: time(p.created_at), kind: 'buy', row: p });
  for (const s of sales) if (time(s.sold_at) > since) events.push({ t: time(s.sold_at), kind: 'sale', row: s });
  for (const m of moves) if (time(m.happened_at) > since) events.push({ t: time(m.happened_at), kind: 'move', row: m });
  events.sort((a, b) => a.t - b.t);

  for (const { t, kind, row } of events) {
    if (kind === 'item') {
      const fresh = !byCode.has(String(row.code));
      const it = get(String(row.code), row);
      if (fresh || t > since) {
        if (row.name) it.name = row.name;
        if (row.category) it.category = row.category;
        if (+row.price > 0) it.price = +row.price;
        if (+row.cost > 0) it.cost = +row.cost;
      }
    } else if (kind === 'buy') {
      const date = fromIsoDay(row.received_on) || dayOf(row.created_at);
      for (const l of row.lines || []) {
        const code = String(l.code);
        const it = get(code, l);
        const qty = +l.qty || 0, bonus = +l.bonus || 0;
        if (qty + bonus <= 0) continue;
        putBack(it, qty + bonus, fromIsoDay(l.expiry));
        if (+l.cost > 0) it.cost = round2((+l.cost * qty) / (qty + bonus)); // free units lower the cost of each box
        if (+l.price > 0) it.price = +l.price;
        out.purchases.push({ date, code, qty: qty + bonus, cost: qty + bonus ? round2((+l.cost * qty) / (qty + bonus)) : 0 });
      }
    } else if (kind === 'move') {
      const it = get(String(row.code), row);
      const qty = +row.qty || 0;
      if (qty > 0) putBack(it, qty, fromIsoDay(row.expiry));
      else if (qty < 0) takeOut(it, -qty);
      if (LOSS_REASON[row.kind] && qty < 0) out.losses.push({ date: dayOf(row.happened_at), code: it.code, qty: -qty, reason: LOSS_REASON[row.kind] });
    } else {
      const sign = row.kind === 'return' ? -1 : 1;
      for (const l of row.lines || []) {
        const code = String(l.code);
        const it = get(code, l);
        const qty = +l.qty || 0;
        if (!qty) continue;
        if (sign > 0) takeOut(it, qty); else putBack(it, qty);
        const each = qty ? (+l.price || 0) - (+l.discount || 0) / qty : 0;
        out.sales.push({ date: dayOf(row.sold_at), code, qty: sign * qty, price: round2(each), ...(+l.discount ? { discount: sign * +l.discount } : {}) });
      }
    }
  }
  for (const it of out.items) settle(it);
  return out;
}

// ---------- Purchase invoices ----------
// Line: { code, name, qty, bonus, cost, price, expiry }. cost = buying price per box (before bonus).
export function purchaseTotal(lines) {
  return round2(lines.reduce((a, l) => a + (+l.qty || 0) * (+l.cost || 0), 0));
}

// What each supplier is owed: invoices minus what was paid on them (and payments made later).
export function supplierBalances(purchases, payments = []) {
  const m = new Map();
  const row = (id, name) => {
    const k = id || `name:${name}`;
    if (!m.has(k)) m.set(k, { id: id || null, name: name || 'من غير مورد', invoices: 0, bought: 0, paid: 0, due: 0, last: null });
    return m.get(k);
  };
  for (const p of purchases) {
    const r = row(p.supplier_id, p.supplier_name);
    r.invoices += 1; r.bought += +p.total || 0; r.paid += +p.paid || 0;
    if (!r.last || String(p.received_on) > r.last) r.last = String(p.received_on);
  }
  for (const x of payments) row(x.supplier_id, x.supplier_name).paid += +x.amount || 0;
  for (const r of m.values()) { r.bought = round2(r.bought); r.paid = round2(r.paid); r.due = round2(r.bought - r.paid); }
  return [...m.values()].sort((a, b) => b.due - a.due || a.name.localeCompare(b.name, 'ar'));
}

// Code for an item added here: its barcode when it has one, else a short unique code.
export function newItemCode(barcode, taken = new Set()) {
  const b = String(barcode ?? '').trim();
  if (b && !taken.has(b)) return b;
  let c;
  do { c = `S${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 36).toString(36).toUpperCase()}`; } while (taken.has(c));
  return c;
}
