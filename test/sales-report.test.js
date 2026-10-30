// The day's receipts: finding one, what was sold (with a discount on the whole receipt shared over
// its lines), the hours, and the profit when the buying price is known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSale, itemsSold, byHour, salesReport, hourLabel } from '../src/sales-report.js';

const at = (h, m = 0) => new Date(2026, 9, 29, h, m).toISOString();
const sales = [
  { id: 'a', number: '261029-K1-001', sold_at: at(9, 15), kind: 'sale', payment: 'cash', total: 180, discount: 20,
    lines: [{ code: 'P1', name: 'بانادول إكسترا', price: 50, qty: 2, discount: 0 }, { code: 'S1', name: 'كريم شمس', price: 100, qty: 1, discount: 0 }] },
  { id: 'b', number: '261029-K1-002', sold_at: at(9, 40), kind: 'sale', payment: 'card', total: 45, discount: 5, employee_name: 'سارة',
    lines: [{ code: 'P1', name: 'بانادول إكسترا', price: 50, qty: 1, discount: 5 }] },
  { id: 'c', number: '261029-K1-003', sold_at: at(14, 5), kind: 'return', payment: 'cash', total: -45, discount: 0, return_of: 'a',
    lines: [{ code: 'P1', name: 'بانادول إكسترا', price: 45, qty: 1, discount: 0 }] },
];

test('finding a receipt by its number, an item, the customer or the cashier', () => {
  assert.equal(matchSale(sales[0], '002'), false);
  assert.equal(matchSale(sales[1], '002'), true);
  assert.equal(matchSale(sales[0], 'بنادول'), false);
  assert.equal(matchSale(sales[0], 'بانادول'), true);
  assert.equal(matchSale(sales[0], 'كريم شمس'), true);
  assert.equal(matchSale(sales[1], 'ساره'), true, 'ة and ه are the same when searching');
  assert.equal(matchSale(sales[0], 'عم أحمد', 'عم احمد'), true);
  assert.equal(matchSale(sales[0], ''), true);
});

test('what was sold: the receipt discount shared by value, returns taken off, profit from the buying price', () => {
  const costs = { P1: 40, S1: 70 };
  const items = itemsSold(sales, (c) => costs[c]);
  // Receipt a: 20 off 200 → بانادول 100 − 10 = 90, cream 100 − 10 = 90. Receipt b: 45. Return: −45.
  assert.deepEqual(items.map((i) => [i.code, i.qty, i.value, i.cost, i.profit]), [['P1', 2, 90, 80, 10], ['S1', 1, 90, 70, 20]]);
  assert.equal(itemsSold(sales).every((i) => i.cost === null && i.profit === null), true, 'no cost known, no profit guessed');
});

test('per hour, and the whole report', () => {
  assert.deepEqual(byHour(sales), [{ hour: 9, receipts: 2, net: 225 }, { hour: 14, receipts: 0, net: -45 }]);
  const r = salesReport(sales, (c) => ({ P1: 40 })[c]);
  assert.equal(r.summary.net, 180);
  assert.equal(r.summary.receipts, 2);
  assert.equal(r.profit, 10);
  assert.equal(r.costMissing, 1);
  assert.equal(hourLabel(0), '12 ص'); assert.equal(hourLabel(9), '9 ص'); assert.equal(hourLabel(12), '12 م'); assert.equal(hourLabel(15), '3 م');
});

test('per cashier: receipts, money, discounts and returns', async () => {
  const { byEmployee, salesReport } = await import('../src/sales-report.js');
  const rows = byEmployee([
    { kind: 'sale', total: 100, discount: 5, employee_name: 'سارة' },
    { kind: 'sale', total: 50, discount: 0, employee_name: 'سارة' },
    { kind: 'return', total: -20, discount: 0, employee_name: 'سارة' },
    { kind: 'sale', total: 30, discount: 0, employee_name: 'أحمد', delivery_fee: 10 },
  ]);
  assert.deepEqual(rows[0], { name: 'سارة', receipts: 2, sales: 150, discount: 5, returns: 1, returned: 20, avg: 75 });
  assert.equal(rows[1].name, 'أحمد');
  const r = salesReport([{ kind: 'sale', total: 30, discount: 0, lines: [], sold_at: '2026-10-30T10:00:00Z', delivery_fee: 10, delivery_to: 'x' }]);
  assert.deepEqual(r.delivery, { count: 1, fees: 10 });
});
