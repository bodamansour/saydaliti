// The treasury: all the pharmacy's cash (the cashier drawers and the money kept outside them), as one
// balance. It starts from the last time the owner counted it ('count' move), or from zero, and adds every
// cash movement recorded after that moment:
//   + cash part of cashier sales (total − what went on an account; card and wallet go to the bank, not here)
//   − cash given back on returns
//   + what customers paid on their accounts
//   − expenses and withdrawals (money only; goods taken are stock, not cash)
//   − what was paid to suppliers (on delivery and later), + cash a supplier gave back on a return
//   − money taken to the bank, + money brought from it, ± corrections
// Each record counts by the moment it was recorded (sold_at for receipts, created_at for the rest), so a
// record made the same day before the count is not counted twice.
const r2 = (n) => Math.round(n * 100) / 100;
const t = (v) => (v ? Date.parse(v) : NaN);

export const CASH_KINDS = { count: 'عدّ الخزينة', to_bank: 'وديت البنك', from_bank: 'جبت من البنك', adjust: 'تصحيح' };

export function treasury({ moves = [], sales = [], customerPayments = [], expenses = [], supplierPayments = [], purchases = [] } = {}, until = Date.now()) {
  const counts = moves.filter((m) => m.kind === 'count' && t(m.moved_at) <= until).sort((a, b) => t(a.moved_at) - t(b.moved_at));
  const last = counts.at(-1) || null;
  const from = last ? t(last.moved_at) : -Infinity;
  const inRange = (v) => { const x = t(v); return Number.isFinite(x) ? x > from && x <= until : !last; };
  const p = { sales: 0, refunds: 0, customers: 0, expenses: 0, withdrawals: 0, suppliers: 0, supplierRefunds: 0, toBank: 0, fromBank: 0, adjust: 0, card: 0 };
  for (const s of sales) {
    if (!inRange(s.sold_at)) continue;
    const now = (+s.total || 0) - (+s.credit || 0); // the part paid at the till (negative on a return)
    if (s.payment === 'cash') { if (s.kind === 'return') p.refunds -= now; else p.sales += now; } else if (s.payment !== 'credit') p.card += now;
  }
  for (const c of customerPayments) if (inRange(c.created_at)) p.customers += +c.amount || 0;
  for (const e of expenses) if (inRange(e.created_at)) { if (e.kind === 'withdrawal') p.withdrawals += +e.amount || 0; else p.expenses += +e.amount || 0; }
  for (const x of supplierPayments) if (inRange(x.created_at)) p.suppliers += +x.amount || 0;
  for (const x of purchases) {
    if (!inRange(x.created_at)) continue;
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
