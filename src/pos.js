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
// ---------- Selling by strip or by pill ----------
// An item is priced and stocked by the box. It can also be sold by the strip or the pill when it says
// how many are in a box (strips, pills). A sale line keeps the unit it was sold in: qty strips at the
// strip's price, with per = strips in a box; everything that counts stock uses boxQty().
export const boxQty = (l) => (+l.per > 1 ? +l.qty / +l.per : +l.qty || 0);
export function unitsOf(item) {
  const out = [{ key: 'box', per: 1, label: 'علبة' }];
  if (+item?.strips > 1) out.push({ key: 'strip', per: +item.strips, label: 'شريط' });
  if (+item?.pills > 1 && +item.pills !== +item.strips) out.push({ key: 'pill', per: +item.pills, label: 'حباية' });
  return out;
}
export const unitLabel = (l) => (+l.per > 1 ? (l.unit === 'pill' ? 'حباية' : 'شريط') : 'علبة');
// The price of one strip or pill: the box's price shared, rounded to the piaster.
export const unitPrice = (boxPrice, per) => Math.round(((+boxPrice || 0) / (+per || 1)) * 100) / 100;

// ---------- Old and new price ----------
// The selling prices of the boxes on the shelf when they differ (old boxes keep the old printed
// price after a price change), earliest expiry first: [{ price, qty }]. One price → [].
export function pricesOf(item) {
  const m = new Map();
  const list = [...(item?.batches || [])].filter((b) => b.qty > 0)
    .sort((a, b) => (a.expiry ? +new Date(a.expiry) : Infinity) - (b.expiry ? +new Date(b.expiry) : Infinity));
  for (const b of list) {
    const p = Math.round((+(b.price ?? item.price) || 0) * 100) / 100;
    if (p > 0) m.set(p, Math.round(((m.get(p) || 0) + b.qty) * 1000) / 1000);
  }
  return m.size > 1 ? [...m].map(([price, qty]) => ({ price, qty })) : [];
}

// ---------- Alternatives ----------
// Other items with the same active ingredient, those in stock first (then the cheapest). stockOf(code)
// gives the shelf stock; without it the item's own qty is used.
export function alternativesOf(item, items, stockOf = (c) => items.find((i) => i.code === c)?.qty ?? 0, max = 6) {
  const g = normalize(item?.generic || '');
  if (!g) return [];
  return items.filter((i) => i.code !== item.code && normalize(i.generic || '') === g)
    .map((i) => ({ item: i, qty: stockOf(i.code) }))
    .sort((a, b) => (b.qty > 0) - (a.qty > 0) || (+a.item.price || 0) - (+b.item.price || 0))
    .slice(0, max);
}

// A scanned or typed code as plain digits: Arabic/Persian digits (an Arabic keyboard) become 0-9, and
// what a scanner may add around it (spaces, a prefix letter, a dash) is dropped.
export function scanDigits(s) {
  const t = String(s ?? '').trim().replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 0x6f0);
  const d = t.replace(/\D/g, '');
  return d.length >= 6 && d.length >= t.length - 3 ? d : t;
}
// The same barcode written with or without leading zeros (UPC-A on the box, EAN-13 in the program).
const bcKey = (s) => String(s).replace(/^0+/, '');
const BC_INDEX = new WeakMap();
export function findBarcode(barcodes, query) {
  const q = scanDigits(query);
  const hit = barcodes.get(q) ?? barcodes.get(String(query ?? '').trim());
  if (hit != null || !/^\d{6,}$/.test(q)) return hit ?? null;
  let ix = BC_INDEX.get(barcodes);
  if (!ix || ix.size !== barcodes.size) {
    // m: every barcode; cut: the same without its last digit (the check digit), for a scanner set not
    // to send it, or a program that saved the barcode without it.
    const m = new Map(), cut = new Map();
    for (const [b, c] of barcodes) {
      const k = bcKey(scanDigits(b));
      if (!m.has(k)) m.set(k, c);
      if (k.length >= 7 && !cut.has(k.slice(0, -1))) cut.set(k.slice(0, -1), c);
    }
    ix = { size: barcodes.size, m, cut };
    BC_INDEX.set(barcodes, ix);
  }
  const k = bcKey(q);
  return ix.m.get(k) ?? ix.cut.get(k) ?? (k.length >= 8 ? ix.m.get(k.slice(0, -1)) : null) ?? null;
}

export function lookup(query, items, barcodes = new Map()) {
  const q = scanDigits(query);
  if (!q) return { matches: [] };
  const byCode = new Map(items.map((i) => [String(i.code), i]));
  const code = findBarcode(barcodes, q) ?? (byCode.has(q) ? q : null);
  if (code && byCode.has(code)) return { item: byCode.get(code) };
  const n = normalize(q);
  const words = n.split(' ');
  const scored = [];
  for (const it of items) {
    const name = normalize([it.name, it.en, it.generic].filter(Boolean).join(' | '));
    if (!words.every((w) => name.includes(w))) continue;
    scored.push([name.startsWith(n) || name.includes(`| ${n}`) ? 0 : name.includes(n) ? 1 : 2, it]);
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

// A discount given as a percent of an amount, in pounds (rounded to the piastre). 0–100%.
export function pctOff(amount, pct) {
  const p = Math.min(100, Math.max(0, +pct || 0));
  return toEgp(Math.round((toPt(amount) * p) / 100));
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
    for (const l of s.lines) if (String(l.code) === String(item.code)) sold += sign * boxQty(l);
  }
  return (+item.qty || 0) - sold;
}

// Warning for the cashier: the nearest batch has expired, or expires within `days`.
// Every box on the shelf has expired (there is stock, and none of it is still good).
export function allExpired(item, today = startOfDay()) {
  const list = batchesOf(item).filter((x) => x.qty > 0);
  return list.length > 0 && list.every((x) => x.expiry && startOfDay(x.expiry) < startOfDay(today));
}

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
  // Counted in boxes (a line may be in strips), then given back in the unit the receipt sold it in.
  const back = new Map();
  for (const r of returns) {
    if (r.kind !== 'return' || r.return_of !== sale.id) continue;
    for (const l of r.lines || []) back.set(String(l.code), (back.get(String(l.code)) || 0) + boxQty(l));
  }
  const lines = (sale.lines || []).filter((l) => +l.qty > 0);
  const gross = lines.reduce((a, l) => a + (+l.price || 0) * +l.qty - (+l.discount || 0), 0);
  const extra = Math.max(0, (+sale.discount || 0) - lines.reduce((a, l) => a + (+l.discount || 0), 0));
  const by = new Map();
  for (const l of lines) {
    const code = String(l.code);
    const net = (+l.price || 0) * +l.qty - (+l.discount || 0);
    const paid = net - (gross > 0 ? (extra * net) / gross : 0);
    const per = +l.per > 1 ? +l.per : 1;
    const r = by.get(code) || { code, name: l.name || code, boxPrice: 0, sold: 0, paid: 0, pers: new Set(), unit: l.unit };
    r.sold += boxQty(l); r.paid += paid; r.boxPrice = Math.max(r.boxPrice, (+l.price || 0) * per); r.pers.add(per);
    by.set(code, r);
  }
  return [...by.values()].map((r) => {
    const leftBoxes = Math.max(0, r.sold - (back.get(r.code) || 0));
    const per = r.pers.size === 1 ? [...r.pers][0] : 1;
    const boxOff = Math.max(0, r.boxPrice - r.paid / r.sold);
    const out = { code: r.code, name: r.name, price: Math.round((r.boxPrice / per) * 10000) / 10000, sold: Math.round(r.sold * per * 1000) / 1000, left: Math.round(leftBoxes * per * 1000) / 1000, unitOff: Math.max(0, Math.round((boxOff / per) * 10000) / 10000) };
    if (per > 1) Object.assign(out, { per, unit: r.unit || 'strip' });
    return out;
  }).filter((r) => r.left > 0.0005);
}

// ---------- VAT ----------
// Prices include VAT. The VAT inside a bill: each line's net (after its discount and its share of the
// bill discount) × tax/(100+tax). Lines with no tax (most medicines) add nothing.
export function vatOf(lines, billDiscount = 0) {
  const ls = (lines || []).filter((l) => +l.qty);
  const nets = ls.map((l) => toPt(l.price) * +l.qty - toPt(l.discount));
  const gross = nets.reduce((a, x) => a + x, 0);
  const extra = Math.max(0, toPt(billDiscount) - ls.reduce((a, l) => a + toPt(l.discount), 0));
  let v = 0;
  ls.forEach((l, i) => { const t = +l.tax || 0; if (t > 0) { const net = nets[i] - (gross > 0 ? (extra * nets[i]) / gross : 0); v += (net * t) / (100 + t); } });
  return toEgp(Math.round(v));
}
