import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, lookup, cartTotals, changeDue, receiptNumber, stockLeft, expiryWarning, daySummary } from '../src/pos.js';

const d = (s) => new Date(`${s}T00:00:00`);
const ITEMS = [
  { code: '101', name: 'باراسيتامول 500 مجم', price: 32, qty: 10 },
  { code: '102', name: 'بانادول إكسترا', price: 51, qty: 4 },
  { code: '201', name: 'كريم مرطب', price: 320, qty: 2 },
];

test('Arabic search text', () => {
  assert.equal(normalize('إكسترا  أقراص'), 'اكسترا اقراص');
  assert.equal(normalize('مُرَطِّب'), 'مرطب');
  assert.equal(normalize('فيتامين ٥٠'), 'فيتامين 50');
});

test('barcode, code, then name search', () => {
  const bc = new Map([['6223000123456', '102']]);
  assert.equal(lookup('6223000123456', ITEMS, bc).item.code, '102');
  assert.equal(lookup('201', ITEMS, bc).item.code, '201');
  assert.deepEqual(lookup('بانادول', ITEMS).matches.map((i) => i.code), ['102']);
  assert.deepEqual(lookup('اكسترا بانادول', ITEMS).matches.map((i) => i.code), ['102'], 'words in any order');
  const unknown = lookup('6223999999999', ITEMS, bc);
  assert.equal(unknown.unknownCode, true);
  assert.equal(unknown.matches.length, 0);
});

test('cart totals in exact piastres', () => {
  const t = cartTotals([{ price: 32.1, qty: 3, discount: 0 }, { price: 0.1, qty: 7, discount: 0 }]);
  assert.equal(t.subtotal, 97); // 96.3 + 0.7, no floating-point drift
  const d2 = cartTotals([{ price: 320, qty: 1, discount: 20 }, { price: 51, qty: 2, discount: 0 }], 2);
  assert.deepEqual(d2, { subtotal: 422, discount: 22, total: 400 });
  assert.equal(cartTotals([{ price: 10, qty: 1, discount: 50 }], 5).total, 0, 'discount never makes it negative');
});

test('change due', () => {
  assert.equal(changeDue(97.5, 100), 2.5);
  assert.equal(changeDue(97.5, 97.5), 0);
  assert.equal(changeDue(97.5, 50), null);
});

test('receipt numbers', () => {
  assert.equal(receiptNumber(d('2026-10-27'), 'K1', 7), '261027-K1-007');
});

test('stock left after cashier sales since the last upload', () => {
  const sales = [
    { sold_at: '2026-10-27T08:00:00Z', kind: 'sale', lines: [{ code: '101', qty: 3 }] },  // before the upload
    { sold_at: '2026-10-27T10:00:00Z', kind: 'sale', lines: [{ code: '101', qty: 2 }, { code: '102', qty: 1 }] },
    { sold_at: '2026-10-27T11:00:00Z', kind: 'return', lines: [{ code: '101', qty: 1 }] },
  ];
  assert.equal(stockLeft(ITEMS[0], sales, '2026-10-27T09:00:00Z'), 9);
  assert.equal(stockLeft(ITEMS[1], sales, '2026-10-27T09:00:00Z'), 3);
});

test('expiry warning at the till', () => {
  const today = d('2026-10-27');
  assert.equal(expiryWarning({ qty: 5, expiry: d('2026-10-01') }, today).level, 'expired');
  assert.equal(expiryWarning({ qty: 5, expiry: d('2026-11-10') }, today).level, 'soon');
  assert.equal(expiryWarning({ qty: 5, expiry: d('2027-06-01') }, today), null);
  assert.equal(expiryWarning({ qty: 5 }, today), null);
});

test('end of day', () => {
  const s = daySummary([
    { kind: 'sale', total: 100, discount: 5, payment: 'cash' },
    { kind: 'sale', total: 50.5, discount: 0, payment: 'card' },
    { kind: 'return', total: -20, discount: 0, payment: 'cash' },
  ]);
  assert.deepEqual([s.receipts, s.returns, s.sales, s.returned, s.discount, s.net], [2, 1, 150.5, 20, 5, 130.5]);
  assert.deepEqual(s.byPayment, { cash: 80, card: 50.5 });
});
