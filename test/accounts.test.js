import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBill, customerBalances, statement, claims, profitByPeriod } from '../src/accounts.js';
import { daySummary } from '../src/pos.js';

const person = { id: 'c1', name: 'أستاذ سامي', kind: 'person', coverage_pct: 0 };
const ins = { id: 'c2', name: 'شركة الأمل للتأمين', kind: 'insurance', coverage_pct: 80 };

test('who pays what: credit, insurance share, or all now', () => {
  assert.deepEqual(splitBill(150, person, 'credit'), { credit: 150, now: 0 });
  assert.deepEqual(splitBill(150, person, 'cash'), { credit: 0, now: 150 });
  assert.deepEqual(splitBill(150, ins, 'cash'), { credit: 120, now: 30 });
  assert.deepEqual(splitBill(150, null, 'credit'), { credit: 0, now: 150 }, 'credit needs a customer');
  assert.deepEqual(splitBill(99.99, { kind: 'insurance', coverage_pct: 70 }, 'card'), { credit: 69.99, now: 30 });
});

const sales = [
  { id: 's1', number: 'A-1', sold_at: '2026-10-01T10:00:00Z', kind: 'sale', customer_id: 'c1', total: 200, credit: 200 },
  { id: 's2', number: 'A-2', sold_at: '2026-10-05T10:00:00Z', kind: 'return', customer_id: 'c1', total: -50, credit: -50 },
  { id: 's3', number: 'A-3', sold_at: '2026-10-06T10:00:00Z', kind: 'sale', customer_id: 'c2', total: 100, credit: 80, claim_no: 'APP-77' },
  { id: 's4', number: 'A-4', sold_at: '2026-11-02T10:00:00Z', kind: 'sale', customer_id: 'c2', total: 50, credit: 40 },
  { id: 's5', number: 'A-5', sold_at: '2026-10-06T11:00:00Z', kind: 'sale', total: 30, credit: 0 },
];
const payments = [{ id: 'p1', customer_id: 'c1', amount: 100, paid_on: '2026-10-10' }];

test('what each customer owes', () => {
  const b = customerBalances([person, ins], sales, payments);
  assert.deepEqual(b.map((x) => [x.id, x.onAccount, x.paid, x.owed, x.bills]), [['c2', 120, 0, 120, 2], ['c1', 150, 100, 50, 2]]);
});

test("a customer's statement with the running balance", () => {
  const st = statement('c1', sales, payments);
  assert.deepEqual(st.map((r) => [r.kind, r.amount, r.balance]), [['sale', 200, 200], ['return', -50, 150], ['payment', -100, 50]]);
});

test('insurance claims for one month', () => {
  const c = claims([person, ins], sales, new Date('2026-10-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'));
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].customer.id, c[0].bills.length, c[0].total, c[0].share, c[0].bills[0].claim_no], ['c2', 1, 100, 80, 'APP-77']);
});

test('the day summary puts the part on account under «آجل»', () => {
  const s = daySummary([
    { kind: 'sale', total: 100, discount: 0, payment: 'cash', credit: 80 },
    { kind: 'sale', total: 50, discount: 0, payment: 'credit', credit: 50 },
    { kind: 'sale', total: 20, discount: 0, payment: 'cash' },
  ]);
  assert.deepEqual(s.byPayment, { cash: 40, credit: 130 });
  assert.equal(s.net, 170);
});

test('profit by month and by day', () => {
  const data = {
    items: [{ code: 'A', cost: 6, price: 10 }, { code: 'B', cost: 30, price: 40 }],
    sales: [
      { date: new Date(2026, 9, 1), code: 'A', qty: 10, price: 10 },
      { date: new Date(2026, 9, 2), code: 'B', qty: 2, price: 40, discount: 5 },
      { date: new Date(2026, 8, 30), code: 'A', qty: 1 },
    ],
    losses: [{ date: new Date(2026, 9, 3), code: 'A', qty: 2 }],
  };
  const m = profitByPeriod(data, 'month');
  assert.deepEqual(m.map((r) => [r.key, r.sales, r.cogs, r.gross, r.lost]), [['2026-10', 175, 120, 55, 12], ['2026-09', 10, 6, 4, 0]]);
  const d = profitByPeriod(data, 'day', new Date(2026, 9, 1), new Date(2026, 9, 3));
  assert.deepEqual(d.map((r) => r.key), ['2026-10-02', '2026-10-01']);
});
