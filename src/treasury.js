// The treasury: all the pharmacy's cash (the cashier drawers and the money kept outside them), as one
// balance. It starts from the last time the owner counted it ('count' move), or from zero, and adds every
// cash movement recorded after that moment:
//   + cash part of cashier sales (total − what went on an account; card and wallet go to the bank, not here)
//   − cash given back on returns
//   + what customers paid on their accounts
//   − expenses and withdrawals (money only; goods taken are stock, not cash)
//   − what was paid to suppliers (on delivery and later), + cash a supplier gave back on a return
//   − money taken to the bank, + money brought from it, ± corrections
// Each record counts by when the money really moved, not when it reached the server:
//   - receipts and treasury moves by their moment (sold_at, moved_at);
//   - expenses, payments and deliveries by their own day (spent_on, paid_on, received_on): a day before the
//     count's day is already in the count, a day after it is not; on the count's own day the time it was
//     recorded decides (created_at). So an expense edited later (saved again with a new created_at) or a
//     payment uploaded late after a day offline still lands on its own day.
const r2 = (n) => Math.round(n * 100) / 100;
const t = (v) => (v ? Date.parse(v) : NaN);
// The local day (YYYY-MM-DD) of a moment, like the dates the app writes (spent_on and the rest).
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export const CASH_KINDS = { count: 'عدّ الخزينة', to_bank: 'وديت البنك', from_bank: 'جبت من البنك', adjust: 'تصحيح' };

export function treasury({ moves = [], sales = [], customerPayments = [], expenses = [], supplierPayments = [], purchases = [] } = {}, until = Date.now()) {
  const counts = moves.filter((m) => m.kind === 'count' && t(m.moved_at) <= until).sort((a, b) => t(a.moved_at) - t(b.moved_at));
  const last = counts.at(-1) || null;
  const from = last ? t(last.moved_at) : -Infinity;
  const inRange = (v) => { const x = t(v); return Number.isFinite(x) ? x > from && x <= until : !last; };
  const fromDay = last ? localDay(from) : null, untilDay = localDay(until);
  // A record with its own day: after the count, and not after `until`.
  const dayInRange = (day, recorded) => {
    const d = String(day || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return inRange(recorded);
    if (d > untilDay) return false;
    if (!last || d > fromDay) return d < untilDay || !Number.isFinite(t(recorded)) || t(recorded) <= until;
    if (d < fromDay) return false;
    return inRange(recorded); // the count's own day: which came first
  };
  const p = { sales: 0, refunds: 0, customers: 0, expenses: 0, withdrawals: 0, suppliers: 0, supplierRefunds: 0, toBank: 0, fromBank: 0, adjust: 0, card: 0 };
  for (const s of sales) {
    if (!inRange(s.sold_at)) continue;
    const now = (+s.total || 0) - (+s.credit || 0); // the part paid at the till (negative on a return)
    if (s.payment === 'cash') { if (s.kind === 'return') p.refunds -= now; else p.sales += now; } else if (s.payment !== 'credit') p.card += now;
  }
  for (const c of customerPayments) if (dayInRange(c.paid_on, c.created_at)) p.customers += +c.amount || 0;
  for (const e of expenses) if (dayInRange(e.spent_on, e.created_at)) { if (e.kind === 'withdrawal') p.withdrawals += +e.amount || 0; else p.expenses += +e.amount || 0; }
  for (const x of supplierPayments) if (dayInRange(x.paid_on, x.created_at)) p.suppliers += +x.amount || 0;
  for (const x of purchases) {
    if (!dayInRange(x.received_on, x.created_at)) continue;
    if (x.kind === 'return') p.supplierRefunds += +x.paid || 0; else p.suppliers += +x.paid || 0;
  }
  for (const m of moves) {
    if (m.kind === 'count' || !inRange(m.moved_at)) continue;
    if (m.kind === 'to_bank') p.toBank += +m.amount || 0;
    else if (m.kind === 'from_bank') p.fromBank += +m.amount || 0;
    else if (m.kind === 'adjust') p.adjust += +m.amount || 0;
  }
  for (const k of Object.keys(p)) p[k] = r2(p[k]);
  const start = last ? +last.amount || 0 : 0;
  const cashIn = r2(p.sales + p.customers + p.supplierRefunds + p.fromBank);
  const cashOut = r2(p.refunds + p.expenses + p.withdrawals + p.suppliers + p.toBank);
  return { since: last?.moved_at ?? null, start, parts: p, cashIn, cashOut, balance: r2(start + cashIn - cashOut + p.adjust) };
}
