// The server's receipt rules (src/sale-rules.js). Valid receipts are built with the cashier's own
// functions (cartTotals, splitBill, returnableLines, pctOff), so these tests prove the server accepts
// exactly what the cashier screen produces, and refuses what it could not have produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSaleRow, checkReturnAgainst } from '../src/sale-rules.js';
import { cartTotals, returnableLines, pctOff } from '../src/pos.js';
import { splitBill } from '../src/accounts.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const at = (min = 0) => new Date(NOW + min * 60000).toISOString();
const CUST = { id: '11111111-1111-4111-8111-111111111111', kind: 'person' };
const INS = { id: '22222222-2222-4222-8222-222222222222', kind: 'insurance', coverage_pct: 80 };

// A receipt the way src/cashier.js checkout() builds it.
function receipt(cart, { extra = 0, fee = 0, payment = 'cash', customer = null, cashGiven = null, kind = 'sale', return_of, note } = {}) {
  const t = cartTotals(cart, extra);
  const total = Math.round((t.total + (kind === 'sale' ? fee : 0)) * 100) / 100;
  const sp = splitBill(total, customer, payment);
  const cash = payment === 'cash' && kind === 'sale' && sp.now > 0;
  const paid = cash ? (cashGiven ?? sp.now) : sp.now;
  const sign = kind === 'return' ? -1 : 1;
  return {
    kind, sold_at: at(), lines: cart.map((l) => ({ code: l.code, name: l.name, price: l.price, qty: l.qty, discount: +l.discount || 0, ...(l.per ? { per: l.per, unit: l.unit || 'strip' } : {}), ...(l.tax ? { tax: l.tax } : {}) })),
    total: sign * total, discount: t.discount, paid: sign * paid, payment: payment === 'credit' && sp.now ? 'cash' : payment,
    ...(customer ? { customer_id: customer.id, credit: sign * sp.credit } : {}),
    ...(kind === 'sale' && fee ? { delivery_fee: fee } : {}),
    ...(return_of ? { return_of } : {}), ...(note ? { note } : {}),
  };
}
const ok = (row) => assert.doesNotThrow(() => checkSaleRow(row, NOW));
const no = (row, re) => assert.throws(() => checkSaleRow(row, NOW), re);

test('legitimate sales from the cashier are accepted', () => {
  ok(receipt([{ code: 'A', price: 50, qty: 2 }]));
  ok(receipt([{ code: 'A', price: 50, qty: 2 }], { cashGiven: 200 })); // change given
  ok(receipt([{ code: 'A', price: 12.35, qty: 3, discount: 1.05 }, { code: 'B', price: 7.5, qty: 1 }], { extra: 2.2 }));
  ok(receipt([{ code: 'A', price: 33.33, qty: 3 }], { extra: pctOff(99.99, 10) }));
  ok(receipt([{ code: 'A', price: 10, qty: 2, per: 3 }], { fee: 15 })); // strips + delivery
  ok(receipt([{ code: 'A', price: 50, qty: 1 }], { payment: 'card' }));
  ok(receipt([{ code: 'A', price: 50, qty: 1 }], { payment: 'wallet' }));
  ok(receipt([{ code: 'A', price: 50, qty: 1 }], { payment: 'credit', customer: CUST }));
  ok(receipt([{ code: 'A', price: 99.95, qty: 1 }], { payment: 'card', customer: INS })); // insurance share + card
  ok(receipt([{ code: 'A', price: 99.95, qty: 1 }], { payment: 'cash', customer: INS, cashGiven: 50 }));
  ok(receipt([{ code: 'A', price: 0, qty: 1 }])); // a free item
  ok(receipt([{ code: 'A', price: 50, qty: 1 }], { extra: 50 })); // fully discounted
  ok({ ...receipt([{ code: 'A', price: 50, qty: 1 }]), sold_at: '2026-10-01T09:00:00Z' }); // made offline weeks ago
  ok({ ...receipt([{ code: 'A', price: 50, qty: 1 }]), sold_at: at(9) }); // device clock a little ahead
  ok(receipt([{ code: 'A', price: 50, qty: 1, tax: 14 }]));
});

test('every invalid sale found in the audit is refused', () => {
  const base = receipt([{ code: 'A1', price: 100, qty: 1 }]);
  no({ ...base, total: 1, paid: 1 }, /total does not match/);
  no({ ...base, total: -500, paid: -500 }, /must not be negative/);
  no({ ...base, discount: 99999, total: 100 }, /discount more than the items/);
  no({ ...base, lines: [{ foo: 'bar' }], total: 0, paid: 0 }, /bad sale line 1/);
  no({ ...base, sold_at: at(60 * 24) }, /future/);
  no({ ...base, sold_at: 'yesterday' }, /bad sale time/);
});

test('lines, discounts and money fields are checked one by one', () => {
  const base = receipt([{ code: 'A', price: 10, qty: 1 }]);
  no({ ...base, lines: [] }, /bad sale lines/);
  no({ ...base, lines: 'x' }, /bad sale lines/);
  no({ ...base, lines: [{ code: '', price: 10, qty: 1 }] }, /code/);
  no({ ...base, lines: [{ code: 'A', price: -1, qty: 1 }] }, /price/);
  no({ ...base, lines: [{ code: 'A', price: 10, qty: 0 }] }, /qty/);
  no({ ...base, lines: [{ code: 'A', price: 10, qty: -1 }] }, /qty/);
  no({ ...base, lines: [{ code: 'A', price: 'NaN', qty: 1 }] }, /price/);
  no({ ...base, lines: [{ code: 'A', price: 10, qty: 1, discount: -5 }] }, /discount/);
  no({ ...base, lines: [{ code: 'A', price: 10, qty: 1, discount: 11 }], discount: 11, total: -1, paid: 0 }, /line discount more than the line/);
  no({ ...base, lines: [{ code: 'A', price: 10, qty: 1, discount: 5 }], discount: 0, total: 10 }, /less than its line discounts/);
  no({ ...base, lines: [{ code: 'A', price: 10, qty: 1, per: 0.5 }] }, /per/);
  no({ ...base, lines: [{ code: 'A', price: 10, qty: 1, unit: 'kg' }] }, /unit/);
  no({ ...base, total: undefined }, /total missing/);
  no({ ...base, paid: undefined }, /paid missing/);
  no({ ...base, paid: null }, /paid missing/);
  no({ ...base, total: Infinity }, /total missing/);
  no({ ...base, kind: 'gift' }, /kind/);
  no({ ...base, payment: 'bitcoin' }, /bad payment/);
});

test('payments: what is paid now, what goes on an account, and to whom', () => {
  const base = receipt([{ code: 'A', price: 100, qty: 1 }]);
  no({ ...base, paid: 50 }, /paid less than the amount due/);
  no({ ...base, payment: 'card', paid: 150 }, /paid does not match/);
  no({ ...base, payment: 'card', paid: 50 }, /paid does not match/);
  no({ ...base, credit: 100, paid: 0 }, /credit needs a customer/);
  no({ ...base, payment: 'credit', paid: 0, credit: 0 }, /credit needs a customer/);
  no({ ...base, payment: 'credit', customer_id: CUST.id, credit: 40, paid: 60 }, /fully on the account/);
  no({ ...base, customer_id: CUST.id, credit: 150, paid: 0 }, /credit more than the total/);
  no({ ...base, customer_id: CUST.id, credit: -10, paid: 110 }, /bad sale credit/);
});

test('returns: signs, no delivery fee, a reason when there is no receipt', () => {
  const r = receipt([{ code: 'A', price: 50, qty: 1 }], { kind: 'return', return_of: 'x' });
  ok(r);
  no({ ...r, total: 50, paid: 50 }, /return total must not be positive/);
  no({ ...r, paid: 50 }, /return paid must not be positive/);
  no({ ...r, delivery_fee: 5 }, /no delivery fee/);
  const noReceipt = receipt([{ code: 'ANY', price: 100, qty: 50 }], { kind: 'return' });
  no(noReceipt, /needs a reason/);
  no({ ...noReceipt, note: '   ' }, /needs a reason/);
  ok({ ...noReceipt, note: 'مرتجع من غير فاتورة: العميل نسي الفاتورة' });
  no({ ...receipt([{ code: 'A', price: 50, qty: 1 }]), return_of: 'x' }, /only for returns/);
});

// Returns against a receipt, built the way findReceipt() and checkout() build them.
function sale(cart, opts) { return { id: 's1', ...receipt(cart, opts) }; }
function returnOf(s, pick, earlier = [], opts = {}) {
  const lines = returnableLines(s, earlier).filter((l) => pick[l.code] != null).map((l) => {
    const qty = pick[l.code];
    return { code: l.code, name: l.name, price: l.price, qty, discount: Math.round(l.unitOff * qty * 100) / 100, ...(l.per ? { per: l.per, unit: l.unit } : {}) };
  });
  return { ...receipt(lines, { ...opts, kind: 'return', return_of: s.id }), lines: lines.map((l) => ({ ...l })) };
}

test('legitimate returns against a receipt: full, partial, after earlier returns, with discounts and strips', () => {
  const s = sale([{ code: 'A', price: 50, qty: 2, discount: 4 }, { code: 'B', price: 10, qty: 3, per: 3 }, { code: 'C', price: 33.33, qty: 3 }], { extra: 7.5 });
  const full = returnOf(s, { A: 2, B: 3, C: 3 });
  ok(full); assert.doesNotThrow(() => checkReturnAgainst(full, s, []));
  const part = returnOf(s, { A: 1, B: 1 });
  ok(part); assert.doesNotThrow(() => checkReturnAgainst(part, s, []));
  const rest = returnOf(s, { A: 1, B: 2, C: 3 }, [{ ...part, kind: 'return' }]);
  ok(rest); assert.doesNotThrow(() => checkReturnAgainst(rest, s, [part]));
  // A credit sale comes back to the same customer's account.
  const cs = sale([{ code: 'A', price: 80, qty: 1 }], { payment: 'credit', customer: CUST });
  const cr = returnOf(cs, { A: 1 }, [], { payment: 'credit', customer: CUST });
  ok(cr); assert.doesNotThrow(() => checkReturnAgainst(cr, cs, []));
  // Insurance: the company's share back on its account, the patient's share in cash.
  const is = sale([{ code: 'A', price: 99.95, qty: 2 }], { payment: 'cash', customer: INS });
  const ir = returnOf(is, { A: 1 }, [], { payment: 'cash', customer: INS });
  ok(ir); assert.doesNotThrow(() => checkReturnAgainst(ir, is, []));
});

test('returns refused against the receipt: price, refund, quantity, items, and account', () => {
  const s = sale([{ code: 'A1', price: 10, qty: 1 }]);
  const inflated = { ...receipt([{ code: 'A1', price: 9999, qty: 1 }], { kind: 'return', return_of: 's1' }) };
  ok(inflated); // consistent on its own…
  assert.throws(() => checkReturnAgainst(inflated, s, []), /return price more than sold/); // …but not against the receipt
  const ds = sale([{ code: 'A', price: 100, qty: 1 }], { extra: 40 }); // paid 60
  const fullPrice = receipt([{ code: 'A', price: 100, qty: 1 }], { kind: 'return', return_of: 's1' });
  assert.throws(() => checkReturnAgainst(fullPrice, ds, []), /refund more than paid/);
  assert.doesNotThrow(() => checkReturnAgainst(returnOf(ds, { A: 1 }), ds, []));
  const two = receipt([{ code: 'A1', price: 10, qty: 2 }], { kind: 'return', return_of: 's1' });
  assert.throws(() => checkReturnAgainst(two, s, []), /return more than sold/);
  const one = receipt([{ code: 'A1', price: 10, qty: 1 }], { kind: 'return', return_of: 's1' });
  assert.throws(() => checkReturnAgainst(one, s, [one]), /return more than sold/);
  const other = receipt([{ code: 'ZZ', price: 1, qty: 1 }], { kind: 'return', return_of: 's1' });
  assert.throws(() => checkReturnAgainst(other, s, []), /not on the receipt/);
  const toOther = receipt([{ code: 'A1', price: 10, qty: 1 }], { kind: 'return', return_of: 's1', payment: 'credit', customer: CUST });
  assert.throws(() => checkReturnAgainst(toOther, s, []), /another customer/);
  assert.throws(() => checkReturnAgainst(one, { ...s, kind: 'return' }, []), /receipt not found/);
});

test('2,000 random cashier receipts (sales and returns of them) are all accepted', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let n = 0; n < 2000; n++) {
    const cart = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => {
      const per = rnd() < 0.3 ? 2 + Math.floor(rnd() * 4) : 0;
      const price = Math.round(rnd() * 50000) / 100;
      const qty = 1 + Math.floor(rnd() * 5);
      const discount = rnd() < 0.3 ? Math.round(rnd() * price * qty * 100) / 100 : 0;
      return { code: `C${i}`, price, qty, discount, ...(per ? { per } : {}) };
    });
    const sub = cartTotals(cart).total;
    const pay = ['cash', 'card', 'wallet', 'credit'][Math.floor(rnd() * 4)];
    const customer = pay === 'credit' ? CUST : rnd() < 0.2 ? INS : null;
    const s = sale(cart, { extra: rnd() < 0.3 ? pctOff(sub, Math.floor(rnd() * 30)) : 0, fee: rnd() < 0.2 ? Math.round(rnd() * 3000) / 100 : 0, payment: pay, customer });
    assert.doesNotThrow(() => checkSaleRow(s, NOW), `sale ${n}: ${JSON.stringify(s)}`);
    const pick = Object.fromEntries(returnableLines(s, []).filter(() => rnd() < 0.7).map((l) => [l.code, Math.max(1, Math.floor(rnd() * l.left) + 1)].map((v, k) => (k ? Math.min(v, l.left) : v))));
    if (!Object.keys(pick).length) continue;
    const r = returnOf(s, pick, [], { payment: s.payment === 'credit' ? 'credit' : s.payment, customer });
    assert.doesNotThrow(() => { checkSaleRow(r, NOW); checkReturnAgainst(r, s, []); }, `return ${n}: ${JSON.stringify({ s, r })}`);
  }
});
