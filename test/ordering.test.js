import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemKind, discountFor, pickSupplier, ordersBySupplier, orderMessage, priceChanges, recurringSuggestions } from '../src/ordering.js';

const d = (s) => new Date(`${s}T00:00:00`);
const S = [
  { id: 's1', name: 'مخزن الأمل', phone: '201011111111', discounts: { all: 5, cosmetics: 15 } },
  { id: 's2', name: 'مخزن النور', phone: '', discounts: { all: 8, medicine: 7 } },
];

test('item kinds from Arabic or English categories', () => {
  assert.equal(itemKind('دواء'), 'medicine');
  assert.equal(itemKind('Cosmetics'), 'cosmetics');
  assert.equal(itemKind('مستلزمات'), 'supplies');
  assert.equal(itemKind(''), 'other');
});

test('discount by kind falls back to the general discount', () => {
  assert.equal(discountFor(S[0], { category: 'تجميل' }), 15);
  assert.equal(discountFor(S[0], { category: 'دواء' }), 5);
  assert.equal(discountFor(S[1], { category: 'دواء' }), 7);
  assert.equal(discountFor({ discounts: { all: 150 } }, {}), 100);
});

test('best supplier, unless one was picked by hand', () => {
  assert.equal(pickSupplier({ code: 'A', category: 'دواء' }, S).supplier.id, 's2');
  assert.equal(pickSupplier({ code: 'C', category: 'تجميل' }, S).supplier.id, 's1');
  const manual = pickSupplier({ code: 'A', category: 'دواء' }, S, { A: 's1' });
  assert.deepEqual([manual.supplier.id, manual.pct, manual.manual], ['s1', 5, true]);
  assert.equal(pickSupplier({ code: 'A' }, []), null);
});

test('orders grouped by supplier with the cost after discount', () => {
  const reorder = [
    { code: 'A', name: 'باراسيتامول', category: 'دواء', cost: 100, order: 10 },
    { code: 'C', name: 'واقي شمس', category: 'تجميل', cost: 200, order: 2 },
    { code: 'Z', name: 'صفر', category: 'دواء', cost: 10, order: 0 },
  ];
  const g = ordersBySupplier(reorder, S);
  assert.deepEqual(g.map((x) => x.supplier.id), ['s2', 's1']);
  assert.equal(g[0].cost, 930);
  assert.equal(g[0].saved, 70);
  assert.equal(g[1].lines[0].unit, 170);
  const none = ordersBySupplier(reorder, []);
  assert.equal(none.length, 1);
  assert.equal(none[0].supplier, null);
  const msg = orderMessage(g[0], { pharmacyName: 'صيدلية أحمد منصور', branchName: 'الفرع الرئيسي' });
  assert.match(msg, /طلبية من صيدلية أحمد منصور \(الفرع الرئيسي\)/);
  assert.match(msg, /• باراسيتامول: 10/);
  assert.doesNotMatch(msg, /صفر/);
});

test('price changes between two uploads', () => {
  const prev = [{ code: 'A', name: 'a', price: 50, cost: 40, qty: 9 }, { code: 'B', name: 'b', price: 20, cost: 15 }, { code: 'C', name: 'c', price: 10, cost: 8 }];
  const cur = [{ code: 'A', name: 'a', price: 60, cost: 40, qty: 5 }, { code: 'B', name: 'b', price: 20, cost: 16 }, { code: 'C', name: 'c', price: 10, cost: 8 }, { code: 'N', name: 'new', price: 5, cost: 4 }];
  const ch = priceChanges(prev, cur);
  assert.deepEqual(ch.map((x) => x.code), ['A', 'B']);
  assert.equal(ch[0].pct, 20);
  assert.deepEqual([ch[0].oldMargin, ch[0].newMargin], [10, 20]);
  assert.deepEqual([ch[1].priceMoved, ch[1].costMoved], [false, true]);
});

test('fixed monthly expenses suggested from last month, once', () => {
  const ex = [
    { kind: 'rent', amount: 5000, spent_on: '2026-09-01', branch_id: 'b1' },
    { kind: 'salaries', amount: 9000, spent_on: '2026-09-30', branch_id: 'b1', note: 'أحمد' },
    { kind: 'salaries', amount: 7000, spent_on: '2026-09-30', branch_id: 'b1', note: 'منى' },
    { kind: 'electricity', amount: 1200, spent_on: '2026-09-10', branch_id: 'b1' },
    { kind: 'rent', amount: 5000, spent_on: '2026-10-01', branch_id: 'b1' },
    { kind: 'rent', amount: 3000, spent_on: '2026-08-01', branch_id: 'b2' },
  ];
  const s = recurringSuggestions(ex, d('2026-10-27'));
  assert.deepEqual(s.map((x) => `${x.kind}:${x.note ?? ''}`), ['salaries:أحمد', 'salaries:منى'], 'rent already paid, electricity varies');
  assert.equal(s[0].spent_on.getTime(), d('2026-10-27').getTime(), 'day 30 is still ahead, so today');
  const nov = recurringSuggestions([{ kind: 'rent', amount: 5000, spent_on: '2026-10-31' }], d('2026-11-30'));
  assert.equal(nov[0].spent_on.getTime(), d('2026-11-30').getTime(), 'short month');
});
