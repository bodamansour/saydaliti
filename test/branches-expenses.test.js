import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBranches, expenseTotals, monthlyFromRecorded, kindLabel } from '../src/branches-expenses.js';

const d = (s) => new Date(`${s}T00:00:00`);

test('one branch is returned as is', () => {
  const a = { items: [{ code: 'A', qty: 1 }], sales: [], purchases: [], losses: [] };
  assert.equal(mergeBranches([a]), a);
});

test('same item in two branches: stock adds up, earliest expiry wins, sales are combined', () => {
  const a = { items: [{ code: 'A', name: 'باراسيتامول', cost: 10, price: 12, qty: 5, expiry: d('2027-05-01') }], sales: [{ code: 'A', date: d('2026-10-01'), qty: 2 }] };
  const b = { items: [{ code: 'A', name: 'باراسيتامول', cost: 10, price: 12, qty: 3, expiry: d('2027-01-01') }, { code: 'B', qty: 4 }], sales: [{ code: 'A', date: d('2026-10-02'), qty: 1 }] };
  const m = mergeBranches([a, b]);
  const A = m.items.find((i) => i.code === 'A');
  assert.equal(A.qty, 8);
  assert.equal(A.expiry.getTime(), d('2027-01-01').getTime());
  assert.equal(A.batches, undefined);
  assert.equal(m.items.length, 2);
  assert.equal(m.sales.length, 2);
});

test('batch detail is kept when merging', () => {
  const a = { items: [{ code: 'A', qty: 5, batches: [{ qty: 2, expiry: d('2027-01-01') }, { qty: 3, expiry: d('2027-06-01') }] }], sales: [] };
  const b = { items: [{ code: 'A', qty: 4, expiry: d('2026-12-01') }], sales: [] };
  const A = mergeBranches([a, b]).items[0];
  assert.equal(A.qty, 9);
  assert.equal(A.batches.length, 3);
  assert.equal(A.batches.reduce((s, x) => s + x.qty, 0), 9);
});

const EX = [
  { kind: 'electricity', amount: 1200, spent_on: '2026-10-05', branch_id: 'b1' },
  { kind: 'rent', amount: 5000, spent_on: '2026-10-01', branch_id: 'b1' },
  { kind: 'withdrawal', amount: 3000, spent_on: '2026-10-10', branch_id: 'b1' },
  { kind: 'electricity', amount: 800, spent_on: '2026-10-07', branch_id: 'b2' },
  { kind: 'water', amount: 200, spent_on: '2026-09-20', branch_id: 'b2' },
  { kind: 'rent', amount: 999, spent_on: '2026-10-03', branch_id: 'b1', deleted: true },
];

test('withdrawals are kept apart from running costs', () => {
  const t = expenseTotals(EX, d('2026-10-01'), d('2026-11-01'));
  assert.equal(t.operating, 7000);
  assert.equal(t.withdrawals, 3000);
  assert.equal(t.byKind.electricity, 2000);
  assert.equal(t.count, 4);
});

test('expense totals for one branch', () => {
  const t = expenseTotals(EX, null, null, 'b2');
  assert.equal(t.operating, 1000);
  assert.equal(t.withdrawals, 0);
});

test('monthly running cost from recorded entries', () => {
  assert.equal(monthlyFromRecorded([], d('2026-10-27')), null);
  // 7200 recorded between 2026-09-20 and 2026-10-27 (38 days) → per 30 days
  const m = monthlyFromRecorded(EX, d('2026-10-27'));
  assert.ok(Math.abs(m - (7200 / 38) * 30) < 0.01);
});

test('labels', () => {
  assert.equal(kindLabel('electricity'), 'كهربا');
});
