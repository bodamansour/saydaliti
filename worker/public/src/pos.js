// Cashier (point of sale) calculations — no DOM, no network. Money is handled in piastres (integers)
// so totals never drift by a fraction of a pound.
import { startOfDay, batchesOf } from './core.js';

export const toPt = (egp) => Math.round((+egp || 0) * 100);
export const toEgp = (pt) => pt / 100;

// Arabic-friendly search text: no diacritics, one form of alef / ya / ta marbuta, lower case.
export function normalize(s) {
  return String(s ?? '').toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c))
    .replace(/\s+/g, ' ').trim();
}

// Scanner input or typed text → { item } for an exact barcode/code, else { matches } by name.
export function lookup(query, items, barcodes = new Map()) {
  const q = String(query ?? '').trim();
  if (!q) return { matches: [] };
  const byCode = new Map(items.map((i) => [String(i.code), i]));
  const code = barcodes.get(q) ?? (byCode.has(q) ? q : null);
  if (code && byCode.has(code)) return { item: byCode.get(code) };
  const n = normalize(q);
  const words = n.split(' ');
  const scored = [];
  for (const it of items) {
    const name = normalize(it.name);
    if (!words.every((w) => name.includes(w))) continue;
    scored.push([name.startsWith(n) ? 0 : name.includes(n) ? 1 : 2, it]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'ar'));
  return { matches: scored.slice(0, 20).map(([, it]) => it), unknownCode: /^\d{6,}$/.test(q) && !code };
}

// Cart: [{ code, name, price, qty, discount }] — qty > 0, price in pounds, discount in pounds for the
// whole line. A return receipt uses the same cart and is stored with a negative total.
export function cartTotals(lines, extraDiscount = 0) {
  let subtotal = 0, lineDiscounts = 0;
  for (const l of lines) {
    const gross = toPt(l.price) * l.qty;
    subtotal += gross;
    lineDiscounts += Math.min(Math.max(0, toPt(l.discount)), gross);
  }
  const extra = Math.min(Math.max(0, toPt(extraDiscount)), subtotal - lineDiscounts);
  return { subtotal: toEgp(subtotal), discount: toEgp(lineDiscounts + extra), total: toEgp(subtotal - lineDiscounts - extra) };
}

export function changeDue(total, paid) {
  const c = toPt(paid) - toPt(total);
  return c >= 0 ? toEgp(c) : null; // null = not enough paid
}

// Receipt number: date, this device's short tag, and a counter that restarts each day.
export function receiptNumber(date, tag, counter) {
  const d = new Date(date);
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${ymd}-${tag}-${String(counter).padStart(3, '0')}`;
}

// Shelf stock = last upload from the pharmacy program, minus what this cashier sold since then
// (returns put stock back). The pharmacy program stays the main record while both run side by side.
export function stockLeft(item, sales, uploadedAt) {
  const since = uploadedAt ? new Date(uploadedAt) : null;
  let sold = 0;
  for (const s of sales) {
    if (since && new Date(s.sold_at) <= since) continue;
    const sign = s.kind === 'return' ? -1 : 1;
    for (const l of s.lines) if (String(l.code) === String(item.code)) sold += sign * l.qty;
  }
  return (+item.qty || 0) - sold;
}

// Warning for the cashier: the nearest batch has expired, or expires within `days`.
export function expiryWarning(item, today = startOfDay(), days = 30) {
  const b = batchesOf(item).filter((x) => x.expiry && x.qty > 0).sort((a, c) => a.expiry - c.expiry)[0];
  if (!b) return null;
  const left = Math.round((startOfDay(b.expiry) - startOfDay(today)) / 86400000);
  if (left < 0) return { level: 'expired', days: left };
  if (left <= days) return { level: 'soon', days: left };
  return null;
}

// End-of-day summary for a set of receipts.
export function daySummary(sales) {
  const out = { receipts: 0, returns: 0, sales: 0, returned: 0, discount: 0, net: 0, byPayment: {} };
  for (const s of sales) {
    const t = toPt(s.total);
    if (s.kind === 'return') { out.returns += 1; out.returned += -t; } else { out.receipts += 1; out.sales += t; }
    out.discount += toPt(s.discount);
    out.net += t;
    // The part on a customer's account (credit, or the insurance share) is not cash in the drawer.
    const credit = toPt(s.credit);
    if (credit) out.byPayment.credit = (out.byPayment.credit || 0) + credit;
    if (t - credit) out.byPayment[s.payment] = (out.byPayment[s.payment] || 0) + t - credit;
  }
  for (const k of ['sales', 'returned', 'discount', 'net']) out[k] = toEgp(out[k]);
  for (const k of Object.keys(out.byPayment)) out.byPayment[k] = toEgp(out.byPayment[k]);
  return out;
}

export const PAYMENTS = [['cash', 'كاش'], ['card', 'فيزا'], ['wallet', 'محفظة / إنستاباي'], ['credit', 'آجل']];

// ---------- Returns against a receipt ----------
// What can still come back from a sale receipt: for each item, how many boxes (sold minus what earlier
// returns of this receipt already took back), at the price actually paid per box (the line discount
// and its share of a discount on the whole receipt taken off).
export function returnableLines(sale, returns = []) {
  const back = new Map();
  for (const r of returns) {
    if (r.kind !== 'return' || r.return_of !== sale.id) continue;
    for (const l of r.lines || []) back.set(String(l.code), (back.get(String(l.code)) || 0) + (+l.qty || 0));
  }
  const lines = (sale.lines || []).filter((l) => +l.qty > 0);
  const gross = lines.reduce((a, l) => a + (+l.price || 0) * +l.qty - (+l.discount || 0), 0);
  const extra = Math.max(0, (+sale.discount || 0) - lines.reduce((a, l) => a + (+l.discount || 0), 0));
  const by = new Map();
  for (const l of lines) {
    const code = String(l.code);
    const net = (+l.price || 0) * +l.qty - (+l.discount || 0);
    const paid = net - (gross > 0 ? (extra * net) / gross : 0);
    const r = by.get(code) || { code, name: l.name || code, price: +l.price || 0, sold: 0, paid: 0 };
    r.sold += +l.qty; r.paid += paid;
    by.set(code, r);
  }
  return [...by.values()].map((r) => {
    const left = Math.max(0, Math.round((r.sold - (back.get(r.code) || 0)) * 1000) / 1000);
    return { code: r.code, name: r.name, price: r.price, sold: r.sold, left, unitOff: Math.max(0, Math.round((r.price - r.paid / r.sold) * 10000) / 10000) };
  }).filter((r) => r.left > 0);
}
