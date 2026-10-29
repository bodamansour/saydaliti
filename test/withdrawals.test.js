// Owner withdrawals: money or goods the owner (or a partner) took for themselves. Not a cost and not
// a loss; they come out of what is left in the pharmacy, and money taken from the drawer comes out
// of the shift's cash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveData } from '../src/inventory.js';
import { fromExport, ledger } from '../src/core.js';
import { withdrawals, expenseTotals, mergeBranches, OWNER_LABEL } from '../src/branches-expenses.js';
import { shiftSummary, cashDifference } from '../src/shifts.js';

const base = fromExport({
  items: [{ code: 'P1', name: 'بانادول', category: 'دواء', cost: 40, price: 50, qty: 0 }],
  batches: [{ code: 'P1', qty: 5, expiry: '2026-12-01', cost: 38 }, { code: 'P1', qty: 10, expiry: '2027-06-01', cost: 42 }],
  sales: [],
});
const AT = '2026-10-20T08:00:00Z';
const take = { id: 'm1', code: 'P1', qty: -3, kind: 'withdrawal', person: 'أحمد', happened_at: '2026-10-21T10:00:00Z', branch_id: null };

test('goods taken leave the stock at what they cost, and are not counted as a loss', () => {
  const d = liveData(base, AT, { moves: [take] });
  assert.equal(d.items[0].qty, 12);
  assert.equal(d.losses.length, 0);
  assert.equal(d.drawings.length, 1);
  const [g] = d.drawings;
  assert.deepEqual([g.id, g.code, g.name, g.qty, g.person], ['m1', 'P1', 'بانادول', 3, 'أحمد']);
  assert.equal(g.value, 114, 'the earliest-expiry boxes, at 38 each');
  const L = ledger(d, { taxRate: 0, overheadRate: 0 }, null, null);
  assert.equal(L.rows.reduce((a, r) => a + r.lost, 0), 0, 'the profit is not lowered');
});

test('per person: money and goods, in the period and the branch asked for', () => {
  const expenses = [
    { id: 'e1', kind: 'withdrawal', amount: 1000, spent_on: '2026-10-05', person: 'أحمد', branch_id: null },
    { id: 'e2', kind: 'withdrawal', amount: 250.5, spent_on: '2026-10-22', person: '', branch_id: null, shift_id: 'sh1' },
    { id: 'e3', kind: 'rent', amount: 3000, spent_on: '2026-10-01', branch_id: null },
    { id: 'e4', kind: 'withdrawal', amount: 400, spent_on: '2026-09-30', person: 'أحمد', branch_id: null },
    { id: 'e5', kind: 'withdrawal', amount: 99, spent_on: '2026-10-10', person: 'محمود', branch_id: 'b2' },
  ];
  const { drawings } = liveData(base, AT, { moves: [take] });
  const W = withdrawals(expenses, drawings, new Date(2026, 9, 1), new Date(2026, 10, 1), null);
  assert.deepEqual(W.byPerson, [{ person: 'أحمد', cash: 1000, goods: 114, total: 1114 }, { person: OWNER_LABEL, cash: 250.5, goods: 0, total: 250.5 }]);
  assert.equal(W.total, 1364.5);
  assert.deepEqual(W.rows.map((r) => [r.date, r.type, r.fromDrawer || false]), [['2026-10-22', 'cash', true], ['2026-10-21', 'goods', false], ['2026-10-05', 'cash', false]]);
  assert.equal(withdrawals(expenses, drawings, null, null, 'all').byPerson.length, 3, 'every branch and every date');
  // Withdrawals are kept apart from the running costs.
  const T = expenseTotals(expenses, new Date(2026, 9, 1), new Date(2026, 10, 1));
  assert.equal(T.operating, 3000);
});

test('branches merged: the goods taken in each branch add up', () => {
  const a = liveData(base, AT, { moves: [take] });
  const b = liveData(base, AT, { moves: [{ ...take, id: 'm2', qty: -1 }] });
  assert.equal(mergeBranches([a, b]).drawings.length, 2);
});

test('money taken out of the drawer during a shift lowers the cash expected at the end', () => {
  const shift = { id: 's1', opening_cash: 200, outs: [{ id: 'o1', amount: 100, person: 'أحمد' }, { id: 'o2', amount: 50.5 }] };
  const sales = [{ shift_id: 's1', kind: 'sale', total: 500, payment: 'cash', discount: 0 }];
  const s = shiftSummary(shift, sales);
  assert.equal(s.outs, 150.5);
  assert.equal(s.expected, 549.5); // 200 + 500 − 150.5
  assert.equal(cashDifference(s.expected, 549.5), 0);
  assert.equal(shiftSummary({ id: 's1', opening_cash: 200 }, sales).outs, 0);
});
