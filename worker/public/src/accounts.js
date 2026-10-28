// Customer accounts (credit sales, insurance) and profit reports — no DOM, no network.
const round2 = (n) => Math.round(n * 100) / 100;
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const CUSTOMER_KINDS = [['person', 'عميل'], ['insurance', 'شركة تأمين / تعاقد']];

// How a bill is paid when a customer is chosen.
//   insurance: the company's share goes on its account, the patient pays the rest now.
//   credit (آجل): the whole bill goes on the customer's account.
// Returns { credit, now }: on account, and paid now with the chosen payment method.
export function splitBill(total, customer, payment) {
  const t = round2(+total || 0);
  if (customer?.kind === 'insurance') {
    const credit = round2((t * (+customer.coverage_pct || 0)) / 100);
    return { credit, now: round2(t - credit) };
  }
  if (payment === 'credit') return customer ? { credit: t, now: 0 } : { credit: 0, now: t };
  return { credit: 0, now: t };
}

// What each customer owes: bills on account minus what they paid. Returns are negative credit.
export function customerBalances(customers, sales, payments) {
  const m = new Map(customers.map((c) => [c.id, { ...c, onAccount: 0, paid: 0, owed: 0, bills: 0, last: null }]));
  for (const s of sales) {
    const r = s.customer_id && m.get(s.customer_id);
    if (!r) continue;
    r.onAccount += +s.credit || 0;
    r.bills += 1;
    if (!r.last || s.sold_at > r.last) r.last = s.sold_at;
  }
  for (const p of payments) { const r = m.get(p.customer_id); if (r) r.paid += +p.amount || 0; }
  for (const r of m.values()) { r.onAccount = round2(r.onAccount); r.paid = round2(r.paid); r.owed = round2(r.onAccount - r.paid); }
  return [...m.values()].sort((a, b) => b.owed - a.owed || a.name.localeCompare(b.name, 'ar'));
}

// One customer's account, oldest first, with the balance after each line.
export function statement(customerId, sales, payments) {
  const rows = [
    ...sales.filter((s) => s.customer_id === customerId && +s.credit).map((s) => ({ at: s.sold_at, kind: s.kind === 'return' ? 'return' : 'sale', ref: s.number, claim: s.claim_no || '', amount: +s.credit, total: +s.total })),
    ...payments.filter((p) => p.customer_id === customerId).map((p) => ({ at: `${p.paid_on}T23:59:59`, kind: 'payment', ref: p.note || '', amount: -(+p.amount), id: p.id })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  let bal = 0;
  for (const r of rows) { bal = round2(bal + r.amount); r.balance = bal; }
  return rows;
}

// Insurance claims for a period: each company's bills (receipt, approval number, its share).
export function claims(customers, sales, from, to) {
  const ins = new Map(customers.filter((c) => c.kind === 'insurance').map((c) => [c.id, { customer: c, bills: [], total: 0, share: 0 }]));
  for (const s of sales) {
    const g = s.customer_id && ins.get(s.customer_id);
    if (!g) continue;
    const t = new Date(s.sold_at);
    if ((from && t < from) || (to && t >= to)) continue;
    g.bills.push(s);
    g.total = round2(g.total + (+s.total || 0));
    g.share = round2(g.share + (+s.credit || 0));
  }
  for (const g of ins.values()) g.bills.sort((a, b) => String(a.sold_at).localeCompare(String(b.sold_at)));
  return [...ins.values()].filter((g) => g.bills.length).sort((a, b) => b.share - a.share);
}

// ---------- Profit by day or by month ----------
// Sales (price − discounts) minus what the goods cost, and losses from damaged/expired boxes.
export function profitByPeriod(data, by = 'month', from = null, to = null) {
  const cost = new Map(data.items.map((i) => [i.code, +i.cost || 0]));
  const list = new Map(data.items.map((i) => [i.code, +i.price || 0]));
  const keyOf = (d) => (by === 'day' ? dayKey(d) : dayKey(d).slice(0, 7));
  const rows = new Map();
  const row = (k) => { if (!rows.has(k)) rows.set(k, { key: k, sales: 0, cogs: 0, gross: 0, lost: 0, qty: 0 }); return rows.get(k); };
  const inRange = (d) => (!from || d >= from) && (!to || d < to);
  for (const s of data.sales) {
    if (!inRange(s.date)) continue;
    const r = row(keyOf(s.date));
    r.sales += s.qty * (s.price ?? list.get(s.code) ?? 0) - (s.discount || 0);
    r.cogs += s.qty * (s.cost ?? cost.get(s.code) ?? 0); // the cost of the boxes sold, when known
    r.qty += s.qty;
  }
  for (const l of data.losses || []) if (inRange(l.date)) row(keyOf(l.date)).lost += l.qty * (l.cost ?? cost.get(l.code) ?? 0);
  return [...rows.values()].map((r) => {
    for (const k of ['sales', 'cogs', 'lost']) r[k] = round2(r[k]);
    r.gross = round2(r.sales - r.cogs);
    r.margin = r.sales ? round2((r.gross / r.sales) * 100) : 0;
    return r;
  }).sort((a, b) => b.key.localeCompare(a.key));
}
