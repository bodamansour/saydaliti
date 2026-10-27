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
