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

test('a return can take back only what the receipt sold, at the price paid', async () => {
  const { returnableLines } = await import('../src/pos.js');
  // 2 × 50 with 10 off the line, 1 × 100, and 20 off the whole receipt (spread by value: 9 and 11).
  const sale = { id: 'S1', kind: 'sale', discount: 30, lines: [{ code: 'A', name: 'أ', price: 50, qty: 2, discount: 10 }, { code: 'B', name: 'ب', price: 100, qty: 1, discount: 0 }] };
  const all = returnableLines(sale);
  assert.deepEqual(all.map((l) => [l.code, l.left]), [['A', 2], ['B', 1]]);
  const a = all.find((l) => l.code === 'A');
  assert.equal(Math.round((a.price - a.unitOff) * 100) / 100, 40.26); // (90 − 90 × 20 ÷ 190) ÷ 2
  const after = returnableLines(sale, [{ kind: 'return', return_of: 'S1', lines: [{ code: 'A', qty: 1 }, { code: 'B', qty: 1 }] }, { kind: 'return', return_of: 'OTHER', lines: [{ code: 'A', qty: 1 }] }]);
  assert.deepEqual(after.map((l) => [l.code, l.left]), [['A', 1]], 'what was already returned can\'t come back twice');
});

test('a discount as a percent: of the price × quantity, rounded to the piastre, never over 100%', async () => {
  const { pctOff, cartTotals } = await import('../src/pos.js');
  assert.equal(pctOff(150, 10), 15);
  assert.equal(pctOff(33.33, 12.5), 4.17);
  assert.equal(pctOff(80, 150), 80);
  assert.equal(pctOff(80, -5), 0);
  // 10% on the receipt is taken from what is left after the items' own discounts.
  const lines = [{ price: 100, qty: 2, discount: 20 }];
  const after = cartTotals(lines, 0).total;
  assert.equal(cartTotals(lines, pctOff(after, 10)).total, 162);
});

test('a barcode scanned with an Arabic keyboard, or with or without its leading zero, finds the item', async () => {
  const { lookup, scanDigits } = await import('../src/pos.js');
  const items = [{ code: '501', name: 'بانادول', price: 30 }];
  const barcodes = new Map([['6221032120058', '501'], ['012345678905', '501']]);
  assert.equal(lookup('٦٢٢١٠٣٢١٢٠٠٥٨', items, barcodes).item?.code, '501');
  assert.equal(lookup('۶۲۲۱۰۳۲۱۲۰۰۵۸', items, barcodes).item?.code, '501');
  assert.equal(lookup(' 6221032120058\r', items, barcodes).item?.code, '501');
  assert.equal(lookup('0012345678905', items, barcodes).item?.code, '501', 'EAN-13 of a UPC-A');
  assert.equal(lookup('06221032120058', items, barcodes).item?.code, '501');
  assert.equal(lookup('٦٢٢٩٩٩٩٩٩٩٩٩٩', items, barcodes).unknownCode, true);
  assert.equal(scanDigits('٦٢٢٩٩٩٩٩٩٩٩٩٩'), '6229999999999');
  assert.equal(scanDigits('بانادول'), 'بانادول');
  assert.ok(lookup('بانادول', items, barcodes).matches.length);
});
