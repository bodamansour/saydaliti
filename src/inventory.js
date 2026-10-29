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
const round4 = (n) => Math.round(n * 1e4) / 1e4;

export const EMPTY_DATA = () => ({ items: [], sales: [], purchases: [], losses: [], real: true });

// Each batch keeps what one box of it cost, so a sale is costed at the batch it came out of, not at
// today's buying price. Batches from the uploaded file with no cost of their own take the item's.
function copyItem(it) {
  const list = it.batches || (it.qty > 0 ? [{ qty: it.qty, expiry: it.expiry ?? null }] : null);
  return { ...it, ...(list ? { batches: list.map((b) => ({ ...b, cost: b.cost ?? it.cost })) } : {}) };
}

// Stock as batches (earliest expiry first), so stock can be taken out and put back per batch.
function batchesFor(it) {
  if (!it.batches) it.batches = it.qty ? [{ qty: it.qty, expiry: it.expiry ?? null, cost: it.cost }] : [];
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

// Takes stock off the shelf: from the batch with the given expiry first (a correction of one
// batch), then from the earliest expiry. Returns what the boxes taken out cost; `parts`, when given,
// collects which batches they came from ({ qty, expiry, cost }), so a return can put them back there.
function takeOut(it, qty, expiry, parts = null) {
  const list = sortBatches(batchesFor(it));
  let left = qty, cost = 0;
  // Same day: dates from a file and dates typed here can differ by the time zone (a few hours).
  const sameDay = (x, y) => (x && y ? Math.abs(x.getTime() - y.getTime()) < 12 * 3600000 : !x && !y);
  const first = expiry === undefined ? [] : list.filter((b) => sameDay(b.expiry, expiry));
  for (const b of [...first, ...list.filter((x) => !first.includes(x))]) {
    const n = Math.min(b.qty, left);
    b.qty -= n; left -= n; cost += n * (b.cost ?? it.cost);
    if (n > 0 && parts) parts.push({ qty: n, expiry: b.expiry, cost: b.cost ?? it.cost });
    if (!left) break;
  }
  if (left > 0) { it.short = (it.short || 0) + left; cost += left * it.cost; } // no stock recorded: today's price
  return cost;
}

function putBack(it, qty, expiry = null, cost = it.cost) {
  const list = batchesFor(it);
  let n = qty;
  if (it.short) { const pay = Math.min(it.short, n); it.short -= pay; n -= pay; }
  if (!n) return;
  const same = list.find((b) => (b.expiry && expiry ? Math.abs(b.expiry.getTime() - expiry.getTime()) < 12 * 3600000 : !b.expiry && !expiry));
  if (!same) { list.push({ qty: n, expiry, cost }); return; }
  // Same expiry bought at another price: one batch at the average cost.
  const was = Math.max(0, same.qty);
  same.cost = was + n ? round2(((same.cost ?? it.cost) * was + cost * n) / (was + n)) : cost;
  same.qty += n;
}

// What the boxes on the shelf cost, batch by batch.
export function stockValue(it) {
  if (!it.batches?.length) return (it.qty || 0) * (it.cost || 0);
  return round2(it.batches.reduce((a, b) => a + (b.qty > 0 ? b.qty * (b.cost ?? it.cost ?? 0) : 0), 0));
}

function newItem(code, row = {}) {
  return { code, name: row.name || code, category: row.category || 'غير محدد', owner: UNASSIGNED, cost: +row.cost || 0, price: +row.price || 0, qty: 0, expiry: null };
}

export const LOSS_REASON = { damaged: 'تالف', expired: 'منتهي الصلاحية' };

export function liveData(base, baseAt, { catalog = [], purchases = [], sales = [], moves = [] } = {}) {
  const out = base ? { ...base, items: base.items.map(copyItem), sales: [...base.sales], purchases: [...(base.purchases || [])], losses: [...(base.losses || [])] } : EMPTY_DATA();
  // Goods the owner or a partner took for themselves: out of the stock at what they cost, not a loss.
  out.drawings = [];
  const since = time(baseAt);
  const byCode = new Map(out.items.map((i) => [i.code, i]));
  const get = (code, row) => {
    let it = byCode.get(code);
    if (!it) { it = newItem(code, row); byCode.set(code, it); out.items.push(it); }
    return it;
  };

  const taken = new Map(); // `${receipt id}|${code}` -> the batches that receipt's boxes came out of
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
        const box = round2(((+l.cost || 0) * qty) / (qty + bonus)); // free units lower the cost of each box
        putBack(it, qty + bonus, fromIsoDay(l.expiry), +l.cost > 0 ? box : it.cost);
        if (+l.cost > 0) it.cost = box;
        if (+l.price > 0) it.price = +l.price;
        out.purchases.push({ date, code, qty: qty + bonus, cost: box });
      }
    } else if (kind === 'move') {
      const it = get(String(row.code), row);
      const qty = +row.qty || 0;
      let cost = 0;
      if (qty > 0) putBack(it, qty, fromIsoDay(row.expiry), +row.cost > 0 ? +row.cost : it.cost);
      else if (qty < 0) cost = takeOut(it, -qty, row.expiry === undefined ? undefined : fromIsoDay(row.expiry));
      if (LOSS_REASON[row.kind] && qty < 0) out.losses.push({ date: dayOf(row.happened_at), code: it.code, qty: -qty, reason: LOSS_REASON[row.kind], cost: round4(cost / -qty) });
      if (row.kind === 'withdrawal' && qty < 0) out.drawings.push({ id: row.id, date: dayOf(row.happened_at), code: it.code, name: it.name, qty: -qty, value: round2(cost), person: row.person || null, branch_id: row.branch_id ?? null, pending: !!row.pending });
    } else {
      const sign = row.kind === 'return' ? -1 : 1;
      const lines = (row.lines || []).filter((l) => +l.qty);
      // A discount on the whole receipt is shared over its lines by their value, so reports see it.
      const gross = lines.reduce((a, l) => a + (+l.price || 0) * +l.qty - (+l.discount || 0), 0);
      const extra = Math.max(0, (+row.discount || 0) - lines.reduce((a, l) => a + (+l.discount || 0), 0));
      for (const l of lines) {
        const code = String(l.code);
        const it = get(code, l);
        const qty = +l.qty;
        // The cost of what was sold is the cost of the boxes it came out of. A return of a receipt
        // made here puts the boxes back on the batches (expiry and cost) they were sold from; one with
        // no receipt (or a receipt from before the upload) goes back at the item's buying price.
        let unitCost;
        if (sign > 0) {
          const parts = [];
          unitCost = round4(takeOut(it, qty, undefined, parts) / qty);
          const k = `${row.id}|${code}`;
          taken.set(k, [...(taken.get(k) || []), ...parts]);
        } else {
          let left = qty, cost = 0;
          for (const p of (row.return_of && taken.get(`${row.return_of}|${code}`)) || []) {
            const n = Math.min(p.qty, left);
            if (n <= 0) continue;
            putBack(it, n, p.expiry, p.cost);
            p.qty -= n; left -= n; cost += n * p.cost;
          }
          if (left > 0) { putBack(it, left); cost += left * it.cost; }
          unitCost = round4(cost / qty);
        }
        const net = (+l.price || 0) * qty - (+l.discount || 0);
        const off = round2((+l.discount || 0) + (gross > 0 ? (extra * net) / gross : 0));
        out.sales.push({ date: dayOf(row.sold_at), code, qty: sign * qty, price: +l.price || 0, cost: unitCost, ...(off ? { discount: sign * off } : {}) });
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

// ---------- Stock count and write-offs ----------
export const MOVE_KINDS = [
  ['count', 'جرد'],
  ['damaged', 'تالف / مكسور'],
  ['expired', 'منتهي الصلاحية'],
  ['supplier_return', 'مرتجع للمورد'],
  ['transfer', 'تحويل بين الفروع'],
  ['withdrawal', 'مسحوبات بضاعة'],
];
export const moveLabel = (k) => MOVE_KINDS.find(([v]) => v === k)?.[1] ?? k;

// What was counted on the shelf → the adjustment for each item whose count differs from the record.
export function countDifferences(counts, items) {
  const byCode = new Map(items.map((i) => [String(i.code), i]));
  const out = [];
  for (const [code, v] of Object.entries(counts)) {
    if (v === '' || v === null || v === undefined || !Number.isFinite(+v) || +v < 0) continue;
    const it = byCode.get(String(code));
    const now = it ? it.qty : 0;
    const diff = round2(+v - now);
    if (diff) out.push({ code: String(code), name: it?.name ?? code, was: now, counted: +v, qty: diff });
  }
  return out;
}

// Boxes still on the shelf whose expiry date has passed, per item.
export function expiredOnShelf(items, today) {
  const t = today.getTime();
  const out = [];
  for (const it of items) {
    const list = it.batches?.length ? it.batches : [{ qty: it.qty, expiry: it.expiry ?? null }];
    const gone = list.filter((b) => b.expiry && b.qty > 0 && b.expiry.getTime() < t);
    const qty = gone.reduce((a, b) => a + b.qty, 0);
    const value = round2(gone.reduce((a, b) => a + b.qty * (b.cost ?? it.cost ?? 0), 0));
    if (qty > 0) out.push({ code: it.code, name: it.name, qty, cost: it.cost, value, expiry: gone.sort((a, b) => a.expiry - b.expiry)[0].expiry });
  }
  return out.sort((a, b) => b.value - a.value);
}

// ---------- Editing an item's stock by hand ----------
// Before: the item's batches [{ qty, expiry: Date|null }]. After: what the owner typed
// [{ qty, expiry: 'yyyy-mm-dd'|null }]. Returns the adjustments that turn one into the other.
export function stockEdits(before, after) {
  const day = (d) => (d ? (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10)) : null);
  const total = new Map(); // expiry -> change
  const add = (e, q) => { if (q) total.set(e, round2((total.get(e) || 0) + q)); };
  for (const b of before) add(day(b.expiry), -(+b.qty || 0));
  for (const b of after) add(day(b.expiry), +b.qty || 0);
  return [...total].filter(([, q]) => q).map(([expiry, qty]) => ({ qty, expiry })).sort((a, b) => a.qty - b.qty);
}
