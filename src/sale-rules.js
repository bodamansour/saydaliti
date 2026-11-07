// What a cashier receipt (pos_sales row) must satisfy before the server stores it. No DOM, no
// network: the Worker runs these checks (worker/src/rpc.js checkPosSale) and the unit tests run them
// directly. They restate the cashier's own arithmetic (src/pos.js cartTotals and returnableLines,
// src/accounts.js splitBill), so the server stores only receipts the cashier screen could have made:
//
//   line gross        = price(in piastres) × qty                     (qty in the unit sold: box/strip/pill)
//   line discount     = 0 … line gross
//   receipt discount  = Σ line discounts + a discount on the whole receipt (0 … what is left)
//   total             = Σ gross − receipt discount + delivery fee     (sale; a return has no fee)
//   a return is stored with total, paid and credit ≤ 0; a sale with them ≥ 0
//   credit (on a customer's account or the insurance share) is 0 … total, and needs a customer;
//   the part paid now is total − credit: card and wallet pay exactly that, cash at least that
//   (paid holds the cash handed over), and a return pays back exactly that.
//
// Money is compared in piastres with a tolerance of 1 piastre (the cashier rounds per line).
// Errors are thrown as Error(message) with stable English messages that the app translates
// (src/supabase-store.js arabicError).

export const SALE_LIMITS = { lines: 300, qty: 100000, price: 9999999, money: 99999999.99, futureMinutes: 10, noteMax: 300 };
const TOL = 1; // piastre

const pt = (egp) => Math.round(+egp * 100 * 1e6) / 1e6; // piastres, keeping fractions from fractional qty
const fin = (v) => typeof v === 'number' ? Number.isFinite(v) : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v));
const bad = (message) => { throw Object.assign(new Error(message), { saleRule: true }); };
const boxQty = (l) => (+l.per > 1 ? +l.qty / +l.per : +l.qty);

// One line of a receipt. Returns its gross and discount in piastres.
function checkLine(l, i) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) bad(`bad sale line ${i + 1}`);
  const code = l.code;
  if (!((typeof code === 'string' && code.trim()) || (typeof code === 'number' && Number.isFinite(code))) || String(code).length > 60) bad(`bad sale line ${i + 1}: code`);
  if (l.name != null && (typeof l.name !== 'string' || l.name.length > 160)) bad(`bad sale line ${i + 1}: name`);
  if (!fin(l.price) || +l.price < 0 || +l.price > SALE_LIMITS.price) bad(`bad sale line ${i + 1}: price`);
  if (!fin(l.qty) || +l.qty <= 0 || +l.qty > SALE_LIMITS.qty) bad(`bad sale line ${i + 1}: qty`);
  if (l.per != null && (!Number.isInteger(+l.per) || +l.per < 1 || +l.per > 10000)) bad(`bad sale line ${i + 1}: per`);
  if (l.unit != null && !['box', 'strip', 'pill'].includes(l.unit)) bad(`bad sale line ${i + 1}: unit`);
  if (l.tax != null && (!fin(l.tax) || +l.tax < 0 || +l.tax > 100)) bad(`bad sale line ${i + 1}: tax`);
  if (l.bp != null && (!fin(l.bp) || +l.bp < 0 || +l.bp > SALE_LIMITS.price)) bad(`bad sale line ${i + 1}: bp`);
  const discount = l.discount == null ? 0 : l.discount;
  if (!fin(discount) || +discount < 0) bad(`bad sale line ${i + 1}: discount`);
  // As the cashier computes it: the price rounded to the piastre, times the quantity.
  const gross = Math.round(+l.price * 100) * +l.qty;
  const off = pt(discount);
  if (off > gross + TOL) bad('line discount more than the line');
  return { gross, off: Math.min(off, gross) };
}

const isTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

// Checks a receipt on its own (no database). now: the server's clock (ms).
export function checkSaleRow(row, now = Date.now()) {
  const kind = row.kind ?? 'sale';
  if (kind !== 'sale' && kind !== 'return') bad('bad sale kind');
  const sign = kind === 'return' ? -1 : 1;
  if (!Array.isArray(row.lines) || !row.lines.length || row.lines.length > SALE_LIMITS.lines) bad('bad sale lines');
  let gross = 0, lineOff = 0;
  row.lines.forEach((l, i) => { const r = checkLine(l, i); gross += r.gross; lineOff += r.off; });

  // Dates: a real time, not in the future (a receipt made offline arrives later, which is fine).
  if (!isTime(row.sold_at)) bad('bad sale time');
  if (Date.parse(row.sold_at) > now + SALE_LIMITS.futureMinutes * 60000) bad('sale time in the future');

  for (const k of ['total', 'paid']) if (!fin(row[k])) bad(`sale ${k} missing`);
  for (const k of ['discount', 'credit', 'delivery_fee']) if (row[k] != null && !fin(row[k])) bad(`bad sale ${k}`);
  for (const k of ['total', 'paid', 'discount', 'credit', 'delivery_fee']) if (row[k] != null && Math.abs(+row[k]) > SALE_LIMITS.money) bad(`bad sale ${k}`);

  const total = pt(row.total), paid = pt(row.paid), discount = pt(row.discount ?? 0), credit = pt(row.credit ?? 0), fee = pt(row.delivery_fee ?? 0);
  if (sign * total < -TOL) bad(kind === 'return' ? 'return total must not be positive' : 'sale total must not be negative');
  if (sign * paid < -TOL) bad(kind === 'return' ? 'return paid must not be positive' : 'sale paid must not be negative');
  if (sign * credit < -TOL) bad('bad sale credit');
  if (fee < 0) bad('bad sale delivery_fee');
  if (kind === 'return' && fee > TOL) bad('a return has no delivery fee');

  // Discount: at least the line discounts, at most what the items cost.
  if (discount < -TOL) bad('bad sale discount');
  if (discount < lineOff - TOL) bad('sale discount less than its line discounts');
  if (discount > gross + TOL) bad('sale discount more than the items');

  // Total = items − discount (+ delivery fee on a sale).
  const expected = gross - discount + fee;
  if (Math.abs(sign * total - expected) > TOL) bad('sale total does not match its lines');

  // Payment: what goes on an account, and what is paid now.
  if (!['cash', 'card', 'wallet', 'credit'].includes(row.payment ?? 'cash')) bad('bad payment');
  if (sign * credit > sign * total + TOL) bad('credit more than the total');
  if (Math.abs(credit) > TOL && !row.customer_id) bad('credit needs a customer');
  if ((row.payment ?? 'cash') === 'credit') {
    if (!row.customer_id) bad('credit needs a customer');
    if (Math.abs(credit - total) > TOL) bad('a credit sale goes fully on the account');
  }
  const nowPart = total - credit; // signed
  const cashSale = (row.payment ?? 'cash') === 'cash' && kind === 'sale';
  if (cashSale) { if (paid < nowPart - TOL) bad('paid less than the amount due'); }
  else if (Math.abs(paid - nowPart) > TOL) bad('paid does not match the amount due');

  // A return with no receipt says why (the cashier asks for the reason).
  if (kind === 'return' && !row.return_of && !(typeof row.note === 'string' && row.note.trim())) bad('a return without a receipt needs a reason');
  if (kind === 'sale' && row.return_of) bad('return_of is only for returns');
  return { gross, discount, total, kind };
}

// A return against a receipt, checked against that receipt and the returns already made from it:
// each item comes back at no more than the box price it was sold at, and the money given back for it is
// no more than what the customer paid for those boxes (its line discount and its share of the
// receipt discount taken off, as returnableLines() offers it). Quantities are checked by the caller
// atomically with the insert (worker/src/db.js guardedReturnInsert).
export function checkReturnAgainst(ret, sale, earlierReturns = []) {
  if (!sale || sale.kind !== 'sale') bad('receipt not found');
  const soldLines = (sale.lines || []).filter((l) => +l.qty > 0);
  const lineNet = (l) => Math.round(+l.price * 100) * +l.qty - pt(l.discount || 0);
  const gross = soldLines.reduce((a, l) => a + lineNet(l), 0);
  const extra = Math.max(0, pt(sale.discount || 0) - soldLines.reduce((a, l) => a + pt(l.discount || 0), 0));
  const sold = new Map();
  for (const l of soldLines) {
    const code = String(l.code);
    const net = lineNet(l);
    const r = sold.get(code) || { boxes: 0, paid: 0, boxPrice: 0 };
    r.boxes += boxQty(l);
    r.paid += net - (gross > 0 ? (extra * net) / gross : 0);
    r.boxPrice = Math.max(r.boxPrice, Math.round(+l.price * 100) * (+l.per > 1 ? +l.per : 1));
    sold.set(code, r);
  }
  const back = new Map();
  for (const e of earlierReturns) for (const l of e.lines || []) back.set(String(l.code), (back.get(String(l.code)) || 0) + boxQty(l));
  const want = new Map();
  for (const l of ret.lines) {
    const code = String(l.code);
    const s = sold.get(code);
    if (!s) bad('return item not on the receipt');
    const per = +l.per > 1 ? +l.per : 1;
    if (Math.round(+l.price * 100) * per > s.boxPrice + TOL * per) bad('return price more than sold');
    const w = want.get(code) || { boxes: 0, refund: 0 };
    w.boxes += boxQty(l);
    w.refund += Math.round(+l.price * 100) * +l.qty - pt(l.discount || 0);
    want.set(code, w);
  }
  for (const [code, w] of want) {
    const s = sold.get(code);
    if (w.boxes > s.boxes - (back.get(code) || 0) + 1e-4) bad('return more than sold');
    const perBox = s.boxes > 0 ? s.paid / s.boxes : 0;
    if (w.refund > perBox * w.boxes + TOL * Math.max(1, ret.lines.length)) bad('refund more than paid');
  }
  // Money owed back to an account goes to the account that bought.
  if (Math.abs(pt(ret.credit ?? 0)) > TOL && ret.customer_id !== sale.customer_id) bad('return credit to another customer');
}

// A void cancels a whole receipt: it is a return of everything still left on it (nothing more, nothing
// less), so after it the receipt has nothing left to return. The approval is checked by the server.
export function checkVoid(ret, sale, earlierReturns = []) {
  if (ret.kind !== 'return' || !ret.return_of) bad('a void must be a return of a receipt');
  const left = new Map();
  for (const l of (sale.lines || []).filter((x) => +x.qty > 0)) left.set(String(l.code), (left.get(String(l.code)) || 0) + boxQty(l));
  for (const e of earlierReturns) for (const l of e.lines || []) left.set(String(l.code), (left.get(String(l.code)) || 0) - boxQty(l));
  const back = new Map();
  for (const l of ret.lines) back.set(String(l.code), (back.get(String(l.code)) || 0) + boxQty(l));
  for (const [code, q] of left) if (q > 1e-4 && Math.abs((back.get(code) || 0) - q) > 1e-4) bad('a void must return everything left on the receipt');
  for (const code of back.keys()) if (!left.has(code)) bad('return item not on the receipt');
}
