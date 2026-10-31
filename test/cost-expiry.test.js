import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costHistory } from '../src/inventory.js';
import { expiryBands, inBand } from '../src/core.js';

test('cost history: each purchase with the real cost per box, the supplier, and the change', () => {
  const rows = costHistory('A1', {
    basePurchases: [{ code: 'A1', date: new Date('2026-08-01'), qty: 10, cost: 40 }, { code: 'B', date: new Date('2026-08-02'), qty: 1, cost: 9 }],
    purchases: [
      { id: 'p1', supplier_name: 'مخزن النور', invoice_no: '77', received_on: '2026-09-01', lines: [{ code: 'A1', qty: 10, bonus: 0, cost: 44 }] },
      { id: 'p2', supplier_name: 'مخزن الأمل', received_on: '2026-10-01', lines: [{ code: 'A1', qty: 10, bonus: 1, cost: 44 }, { code: 'B', qty: 1, cost: 5 }] },
      { id: 'r1', kind: 'return', received_on: '2026-10-05', lines: [{ code: 'A1', qty: 2, cost: 44 }] },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.at, r.cost, r.box, r.supplier, r.change, r.pct]), [
    ['2026-10-01', 44, 40, 'مخزن الأمل', -4, -9.1],
    ['2026-09-01', 44, 44, 'مخزن النور', 4, 10],
    ['2026-08-01', 40, 40, '', null, null],
  ]);
  assert.equal(rows[1].invoice, '77');
  assert.deepEqual(costHistory('Z', {}), []);
});

test('expiry bands: expired, then 30/60/90 within a 90-day window, with counts and money', () => {
  const rows = [{ expDays: -3, atRisk: 2, riskValue: 20 }, { expDays: 0, atRisk: 1, riskValue: 10 }, { expDays: 12, atRisk: 5, riskValue: 50 }, { expDays: 45, atRisk: 1, riskValue: 7 }, { expDays: 90, atRisk: 4, riskValue: 8 }];
  const b = expiryBands(rows, 90);
  assert.deepEqual(b.map((x) => [x.label, x.items, x.atRisk, x.value]), [['منتهي', 2, 3, 30], ['خلال 30 يوم', 1, 5, 50], ['31–60 يوم', 1, 1, 7], ['61–90 يوم', 1, 4, 8]]);
  assert.ok(inBand(b[2], { expDays: 31 }) && !inBand(b[2], { expDays: 61 }));
  assert.deepEqual(expiryBands([], 120).map((x) => x.label), ['منتهي', 'خلال 30 يوم', '31–60 يوم', '61–90 يوم', '91–120 يوم']);
  assert.deepEqual(expiryBands([], 180).map((x) => x.label).at(-1), '91–180 يوم');
  assert.deepEqual(expiryBands([], 20).map((x) => x.label), ['منتهي', 'خلال 20 يوم']);
});
