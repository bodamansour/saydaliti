import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveData, purchaseTotal, supplierBalances, newItemCode } from '../src/inventory.js';
import { fromExport, analyze } from '../src/core.js';

const base = fromExport({
  items: [
    { code: 'P1', name: 'بانادول', category: 'دواء', cost: 40, price: 50, qty: 0 },
    { code: 'Z0', name: 'صنف رصيده صفر', category: 'دواء', cost: 10, price: 12, qty: 0 },
  ],
  batches: [
    { code: 'P1', qty: 5, expiry: '2026-12-01' },
    { code: 'P1', qty: 10, expiry: '2027-06-01' },
  ],
  sales: [{ code: 'P1', date: '2026-10-01', qty: 3, amount: 150 }],
});
const AT = '2026-10-20T08:00:00Z';

test('with nothing new, the stock is the uploaded file', () => {
  const d = liveData(base, AT);
  assert.equal(d.items.find((i) => i.code === 'P1').qty, 15);
  assert.equal(d.items.find((i) => i.code === 'Z0').qty, 0, 'items with no stock stay in the list');
  assert.equal(d.sales.length, 1);
});

test('a received purchase adds stock with its expiry, and bonus lowers the cost per box', () => {
  const d = liveData(base, AT, { purchases: [{ created_at: '2026-10-21T10:00:00Z', received_on: '2026-10-21', lines: [{ code: 'Z0', qty: 10, bonus: 2, cost: 12, price: 15, expiry: '2027-03-01' }] }] });
  const z = d.items.find((i) => i.code === 'Z0');
  assert.equal(z.qty, 12);
  assert.equal(z.cost, 10);   // 10 × 12 ÷ 12 boxes
  assert.equal(z.price, 15);
  assert.equal(z.expiry.getFullYear(), 2027);
  assert.deepEqual(d.purchases.map((p) => [p.code, p.qty, p.cost]), [['Z0', 12, 10]]);
});

test('purchases from before the upload are already in it and are not added twice', () => {
  const d = liveData(base, AT, { purchases: [{ created_at: '2026-10-19T10:00:00Z', received_on: '2026-10-19', lines: [{ code: 'P1', qty: 50, cost: 40 }] }] });
  assert.equal(d.items.find((i) => i.code === 'P1').qty, 15);
});

test('cashier sales take stock out from the earliest expiry first; returns put it back', () => {
  const d = liveData(base, AT, { sales: [
    { sold_at: '2026-10-21T12:00:00Z', kind: 'sale', lines: [{ code: 'P1', qty: 7, price: 50, discount: 0 }] },
    { sold_at: '2026-10-21T13:00:00Z', kind: 'return', lines: [{ code: 'P1', qty: 1, price: 50 }] },
  ] });
  const p = d.items.find((i) => i.code === 'P1');
  assert.equal(p.qty, 9);
  assert.equal(p.batches.length, 2, 'the 5 expiring first sold out; the returned box comes back on its own');
  assert.equal(p.expiry.getFullYear(), 2027);
  assert.deepEqual(d.sales.slice(1).map((s) => s.qty), [7, -1]);
  assert.equal(analyze(d, {}, new Date(2026, 9, 22)).rows.find((r) => r.code === 'P1').sold, 9);
});

test('selling something with no stock entered shows a negative balance that the next delivery fills', () => {
  const d = liveData(base, AT, {
    sales: [{ sold_at: '2026-10-21T12:00:00Z', kind: 'sale', lines: [{ code: 'Z0', qty: 2, price: 12 }] }],
    purchases: [{ created_at: '2026-10-22T10:00:00Z', received_on: '2026-10-22', lines: [{ code: 'Z0', qty: 5, cost: 10 }] }],
  });
  assert.equal(d.items.find((i) => i.code === 'Z0').qty, 3);
  const only = liveData(base, AT, { sales: [{ sold_at: '2026-10-21T12:00:00Z', kind: 'sale', lines: [{ code: 'Z0', qty: 2, price: 12 }] }] });
  assert.equal(only.items.find((i) => i.code === 'Z0').qty, -2);
});

test('items added here appear everywhere; edits after the upload change name and price', () => {
  const d = liveData(base, AT, { catalog: [
    { code: 'N1', name: 'صنف جديد', category: 'مستلزمات', price: 30, cost: 20, created_at: '2026-10-21T09:00:00Z' },
    { code: 'P1', name: 'بانادول إكسترا', price: 55, created_at: '2026-10-21T09:00:00Z' },
    { code: 'Z0', price: 99, created_at: '2026-10-01T09:00:00Z' }, // older than the upload: the upload wins
  ] });
  const n = d.items.find((i) => i.code === 'N1');
  assert.deepEqual([n.name, n.qty, n.price, n.cost], ['صنف جديد', 0, 30, 20]);
  assert.equal(d.items.find((i) => i.code === 'P1').price, 55);
  assert.equal(d.items.find((i) => i.code === 'Z0').price, 12);
});

test('works with no upload at all (stock entered only here)', () => {
  const d = liveData(null, null, {
    catalog: [{ code: 'N1', name: 'شاش', price: 10, created_at: '2026-10-21T09:00:00Z' }],
    purchases: [{ created_at: '2026-10-21T10:00:00Z', received_on: '2026-10-21', lines: [{ code: 'N1', qty: 20, cost: 6 }] }],
    sales: [{ sold_at: '2026-10-21T12:00:00Z', kind: 'sale', lines: [{ code: 'N1', qty: 4, price: 10 }] }],
  });
  assert.deepEqual(d.items.map((i) => [i.code, i.qty, i.cost]), [['N1', 16, 6]]);
});

test('does not change the uploaded data it was given', () => {
  liveData(base, AT, { sales: [{ sold_at: '2026-10-21T12:00:00Z', kind: 'sale', lines: [{ code: 'P1', qty: 7, price: 50 }] }] });
  assert.equal(base.items.find((i) => i.code === 'P1').batches[0].qty, 5);
});

test('purchase totals and what each supplier is owed', () => {
  assert.equal(purchaseTotal([{ qty: 10, cost: 12.5 }, { qty: 3, cost: 4 }]), 137);
  const b = supplierBalances([
    { supplier_id: 's1', supplier_name: 'مخزن الأمل', total: 1000, paid: 400, received_on: '2026-10-20' },
    { supplier_id: 's1', supplier_name: 'مخزن الأمل', total: 500, paid: 500, received_on: '2026-10-22' },
    { supplier_id: null, supplier_name: 'مندوب', total: 200, paid: 0, received_on: '2026-10-21' },
  ], [{ supplier_id: 's1', amount: 100 }]);
  assert.deepEqual(b.map((x) => [x.name, x.bought, x.paid, x.due, x.invoices]), [['مخزن الأمل', 1500, 1000, 500, 2], ['مندوب', 200, 0, 200, 1]]);
  assert.equal(b[0].last, '2026-10-22');
});

test('a new item uses its barcode as the code, or gets a unique one', () => {
  assert.equal(newItemCode('6221234567890'), '6221234567890');
  const c = newItemCode('', new Set());
  assert.match(c, /^S[0-9A-Z]+$/);
  assert.notEqual(newItemCode('6221234567890', new Set(['6221234567890'])), '6221234567890');
});

test('adjustments: a count fixes the shelf, damaged and expired count as losses', () => {
  const d = liveData(base, AT, { moves: [
    { happened_at: '2026-10-21T09:00:00Z', code: 'P1', qty: -2, kind: 'expired' },
    { happened_at: '2026-10-21T10:00:00Z', code: 'P1', qty: 1, kind: 'count' },
    { happened_at: '2026-10-21T11:00:00Z', code: 'Z0', qty: 4, kind: 'transfer', expiry: '2027-01-01' },
  ] });
  assert.equal(d.items.find((i) => i.code === 'P1').qty, 14);
  assert.equal(d.items.find((i) => i.code === 'Z0').qty, 4);
  assert.deepEqual(d.losses.map((l) => [l.code, l.qty, l.reason]), [['P1', 2, 'منتهي الصلاحية']]);
});

test('a shelf count gives one adjustment per item that differs', async () => {
  const { countDifferences } = await import('../src/inventory.js');
  const d = liveData(base, AT);
  const out = countDifferences({ P1: '12', Z0: '0', X9: '', NEW: '3' }, d.items);
  assert.deepEqual(out.map((x) => [x.code, x.was, x.counted, x.qty]), [['P1', 15, 12, -3], ['NEW', 0, 3, 3]]);
});

test('expired boxes still on the shelf are listed with their cost', async () => {
  const { expiredOnShelf } = await import('../src/inventory.js');
  const d = liveData(base, AT);
  const out = expiredOnShelf(d.items, new Date(2026, 11, 15));
  assert.deepEqual(out.map((x) => [x.code, x.qty]), [['P1', 5]]);
  assert.equal(expiredOnShelf(d.items, new Date(2026, 9, 1)).length, 0);
});

test('a supplier return taken off the shelf', () => {
  const d = liveData(base, AT, { moves: [{ happened_at: '2026-10-21T09:00:00Z', code: 'P1', qty: -4, kind: 'supplier_return', cost: 40 }] });
  assert.equal(d.items.find((i) => i.code === 'P1').qty, 11);
  assert.equal(d.losses.length, 0, 'a return is not a loss');
});

test('cashier discounts reach the books once, including a discount on the whole receipt', async () => {
  const { ledger } = await import('../src/core.js');
  const d = liveData(base, AT, { sales: [{ sold_at: '2026-10-21T12:00:00Z', kind: 'sale', discount: 15, lines: [
    { code: 'P1', qty: 2, price: 50, discount: 5 }, { code: 'Z0', qty: 5, price: 12, discount: 0 }] }] });
  const L = ledger(d, { taxRate: 0, overheadRate: 0 }, new Date(2026, 9, 21), new Date(2026, 9, 22));
  assert.equal(Math.round(L.totals.revenue * 100) / 100, 145); // 100 + 60 − 15
});

test('editing stock by hand: quantities and expiry dates become adjustments', async () => {
  const { stockEdits } = await import('../src/inventory.js');
  const before = [{ qty: 5, expiry: new Date(2026, 11, 1) }, { qty: 10, expiry: new Date(2027, 5, 1) }];
  // 5 → 3, and the 10 really expire in 2027-08, plus 4 new boxes with no date.
  const moves = stockEdits(before, [{ qty: 3, expiry: '2026-12-01' }, { qty: 10, expiry: '2027-08-01' }, { qty: 4, expiry: null }]);
  assert.deepEqual(moves, [{ qty: -10, expiry: '2027-06-01' }, { qty: -2, expiry: '2026-12-01' }, { qty: 4, expiry: null }, { qty: 10, expiry: '2027-08-01' }]);
  assert.deepEqual(stockEdits(before, [{ qty: 5, expiry: '2026-12-01' }, { qty: 10, expiry: '2027-06-01' }]), [], 'nothing changed');
  // Applied to the stock, a correction takes from the batch it names, not the earliest one.
  const d = liveData(base, AT, { moves: moves.map((m, i) => ({ ...m, code: 'P1', kind: 'count', happened_at: `2026-10-21T09:0${i}:00Z` })) });
  const p = d.items.find((i) => i.code === 'P1');
  assert.deepEqual(p.batches.map((b) => [b.qty, b.expiry ? `${b.expiry.getFullYear()}-${String(b.expiry.getMonth() + 1).padStart(2, '0')}` : null]).sort(), [[10, '2027-08'], [3, '2026-12'], [4, null]].sort());
});

test('cost of sales: each box sold is costed at the batch it came out of, not today\'s price', async () => {
  const { ledger } = await import('../src/core.js');
  const { stockValue } = await import('../src/inventory.js');
  // 10 boxes at 60 that expire first, on top of the uploaded 15 at 40; then 12 sold.
  const d = liveData(base, AT, {
    purchases: [{ created_at: '2026-10-21T10:00:00Z', received_on: '2026-10-21', lines: [{ code: 'P1', qty: 10, cost: 60, expiry: '2026-11-01' }] }],
    sales: [{ sold_at: '2026-10-22T12:00:00Z', kind: 'sale', lines: [{ code: 'P1', qty: 12, price: 70 }] }],
  });
  const p = d.items.find((i) => i.code === 'P1');
  assert.equal(p.cost, 60, 'the latest buying price is still the item\'s price');
  const L = ledger(d, { taxRate: 0, overheadRate: 0 }, new Date(2026, 9, 22), new Date(2026, 9, 23));
  assert.equal(Math.round(L.totals.cogs), 680); // 10 × 60 + 2 × 40
  assert.equal(stockValue(p), 520, 'the 13 left on the shelf are the ones bought at 40');
});

test('expired boxes written off cost what that batch cost; one expiry bought at two prices averages', () => {
  const d = liveData(base, AT, {
    purchases: [{ created_at: '2026-10-21T10:00:00Z', received_on: '2026-10-21', lines: [{ code: 'P1', qty: 5, cost: 60, expiry: '2026-12-01' }] }],
    moves: [{ happened_at: '2026-10-22T09:00:00Z', code: 'P1', qty: -10, kind: 'expired' }],
  });
  const p = d.items.find((i) => i.code === 'P1');
  assert.deepEqual(d.losses.map((l) => [l.qty, l.cost]), [[10, 50]]); // 5 at 40 + 5 at 60, same expiry
  assert.equal(p.qty, 10);
});

test('a batch cost survives saving and loading the stock', async () => {
  const { toExport } = await import('../src/core.js');
  const d = liveData(base, AT, { purchases: [{ created_at: '2026-10-21T10:00:00Z', received_on: '2026-10-21', lines: [{ code: 'P1', qty: 4, cost: 60, expiry: '2028-01-01' }] }] });
  const again = fromExport(toExport(d));
  const p = again.items.find((i) => i.code === 'P1');
  assert.deepEqual(p.batches.map((b) => b.cost ?? p.cost).sort(), [40, 40, 60]);
});

test('a return of a receipt puts the boxes back on the batches they were sold from, at their cost', async () => {
  const { ledger } = await import('../src/core.js');
  const d = liveData(base, AT, { sales: [
    { id: 'R1', sold_at: '2026-10-21T12:00:00Z', kind: 'sale', lines: [{ code: 'P1', qty: 7, price: 50 }] }, // 5 of 2026-12 + 2 of 2027-06
    { id: 'R2', return_of: 'R1', sold_at: '2026-10-21T13:00:00Z', kind: 'return', lines: [{ code: 'P1', qty: 6, price: 50 }] },
  ] });
  const p = d.items.find((i) => i.code === 'P1');
  const by = Object.fromEntries(p.batches.map((b) => [b.expiry.getFullYear(), b.qty]));
  assert.deepEqual(by, { 2026: 5, 2027: 9 }, 'the 5 short-dated boxes went back to their batch, not a batch with no date');
  const L = ledger(d, { taxRate: 0, overheadRate: 0 }, new Date(2026, 9, 21), new Date(2026, 9, 22));
  assert.equal(Math.round(L.totals.cogs), 40); // 7 × 40 sold − 6 × 40 back
});

test('a strip sold at the cashier takes a third of a box off, and a catalog row can set strips', () => {
  const d = liveData(base, AT, {
    catalog: [{ code: 'P1', strips: 3, generic: 'paracetamol', created_at: '2026-10-21T09:00:00Z' }],
    sales: [{ id: 'x', kind: 'sale', sold_at: '2026-10-21T10:00:00Z', discount: 0, lines: [{ code: 'P1', price: 16.67, qty: 1, per: 3, unit: 'strip', discount: 0 }] }],
  });
  const p = d.items.find((i) => i.code === 'P1');
  assert.equal(p.strips, 3);
  assert.equal(p.generic, 'paracetamol');
  assert.ok(Math.abs(p.qty - (15 - 1 / 3)) < 0.001);
  const s = d.sales.at(-1);
  assert.equal(s.qty, 0.3333);
  assert.equal(s.price, 50.01);
});
