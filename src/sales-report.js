// Receipts of a day (or any period): finding one fast, what was sold, and the day's report.
// Pure functions, no DOM: shared by the dashboard, the cashier and the tests.
import { normalize, daySummary, toPt, toEgp, boxQty } from './pos.js';

// A receipt matches when its number, one of its items, its customer or its cashier contains the text.
export function matchSale(sale, q, customerName = '') {
  const n = normalize(q);
  if (!n) return true;
  if (String(sale.number || '').toLowerCase().includes(n)) return true;
  const hay = [customerName, sale.employee_name, sale.claim_no, sale.delivery_to, ...(sale.lines || []).map((l) => `${l.name} ${l.code}`)].map(normalize).join(' | ');
  return n.split(' ').every((w) => hay.includes(w));
}

// Each line's share of the money actually paid: its own discount off, and its part of a discount
// on the whole receipt (shared by the lines' value).
function lineValues(sale) {
  const lines = (sale.lines || []).filter((l) => +l.qty);
  const nets = lines.map((l) => toPt(l.price) * +l.qty - toPt(l.discount));
  const gross = nets.reduce((a, x) => a + x, 0);
  const extra = Math.max(0, toPt(sale.discount) - lines.reduce((a, l) => a + toPt(l.discount), 0));
  return lines.map((l, i) => ({ line: l, pt: nets[i] - (gross > 0 ? Math.round((extra * nets[i]) / gross) : 0) }));
}

// What was sold in these receipts, per item (returns taken off): boxes, money, and — when the
// buying price is known (costOf(code) → price per box) — the cost and the profit.
export function itemsSold(sales, costOf = () => null) {
  const m = new Map();
  for (const s of sales) {
    const sign = s.kind === 'return' ? -1 : 1;
    for (const { line, pt } of lineValues(s)) {
      const code = String(line.code);
      const o = m.get(code) || { code, name: line.name || code, qty: 0, valuePt: 0, receipts: 0 };
      o.qty += sign * boxQty(line);
      o.valuePt += sign * pt;
      o.receipts += 1;
      m.set(code, o);
    }
  }
  return [...m.values()].map((o) => {
    const c = costOf(o.code);
    const value = toEgp(o.valuePt);
    const cost = Number.isFinite(c) && c > 0 ? Math.round(c * o.qty * 100) / 100 : null;
    return { code: o.code, name: o.name, qty: Math.round(o.qty * 1000) / 1000, value, receipts: o.receipts, cost, profit: cost === null ? null : Math.round((value - cost) * 100) / 100 };
  }).filter((o) => o.qty || o.value).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, 'ar'));
}

// Receipts and money per hour of the day (local time), for the hours that had any.
export function byHour(sales) {
  const h = new Map();
  for (const s of sales) {
    const k = new Date(s.sold_at).getHours();
    const o = h.get(k) || { hour: k, receipts: 0, netPt: 0 };
    if (s.kind !== 'return') o.receipts += 1;
    o.netPt += toPt(s.total);
    h.set(k, o);
  }
  return [...h.values()].sort((a, b) => a.hour - b.hour).map((o) => ({ hour: o.hour, receipts: o.receipts, net: toEgp(o.netPt) }));
}

// Per cashier: receipts, money, discounts given, returns, and the average receipt.
export function byEmployee(sales) {
  const m = new Map();
  for (const s of sales) {
    const k = s.employee_name || 'من غير اسم';
    const o = m.get(k) || { name: k, receipts: 0, salesPt: 0, discountPt: 0, returns: 0, returnedPt: 0 };
    if (s.kind === 'return') { o.returns += 1; o.returnedPt += -toPt(s.total); } else { o.receipts += 1; o.salesPt += toPt(s.total); o.discountPt += toPt(s.discount); }
    m.set(k, o);
  }
  return [...m.values()].map((o) => ({ name: o.name, receipts: o.receipts, sales: toEgp(o.salesPt), discount: toEgp(o.discountPt), returns: o.returns, returned: toEgp(o.returnedPt), avg: o.receipts ? toEgp(Math.round(o.salesPt / o.receipts)) : 0 }))
    .sort((a, b) => b.sales - a.sales);
}

// The whole report: totals by payment, the items, the hours, and the profit when costs are known.
export function salesReport(sales, costOf) {
  const items = itemsSold(sales, costOf);
  const known = items.filter((i) => i.cost !== null);
  const profit = known.length ? Math.round(known.reduce((a, i) => a + i.profit, 0) * 100) / 100 : null;
  const deliveries = sales.filter((s) => s.kind !== 'return' && (+s.delivery_fee || s.delivery_to));
  return { summary: daySummary(sales), items, hours: byHour(sales), employees: byEmployee(sales), profit, costMissing: items.length - known.length,
    delivery: { count: deliveries.length, fees: Math.round(deliveries.reduce((a, s) => a + (+s.delivery_fee || 0), 0) * 100) / 100 } };
}

// "10 ص" / "3 م" for an hour of the day.
export const hourLabel = (h) => `${h % 12 || 12} ${h < 12 ? 'ص' : 'م'}`;
