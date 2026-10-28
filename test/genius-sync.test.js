import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geniusCorrections, batchList } from '../src/genius-sync.js';
import { fromExport } from '../src/core.js';
import { liveData } from '../src/inventory.js';

const AT = '2026-10-25T10:00:00Z';
const base = fromExport({
  items: [
    { code: '5001', name: 'بانادول', cost: 40, price: 50 },
    { code: '5002', name: 'كريم', cost: 290, price: 420 },
    { code: '5003', name: 'شاش', cost: 5, price: 8 },
  ],
  batches: [{ code: '5001', qty: 10, expiry: '2027-06-01' }, { code: '5001', qty: 2, expiry: '2026-12-01' }, { code: '5002', qty: 3, expiry: '2027-02-01' }, { code: '5003', qty: 7, expiry: null }],
});

test('only what was fixed here goes to United: counts, expiry, prices, names, new items', () => {
  const changes = {
    catalog: [
      { code: '5002', name: 'كريم شمس 50', price: 450, created_at: '2026-10-26T09:00:00Z' },
      { code: 'NEW1', name: 'صنف جديد', price: 30, cost: 20, created_at: '2026-10-26T09:00:00Z' },
      { code: '5003', price: 9, created_at: '2026-10-01T09:00:00Z' }, // before the upload: United already has it
    ],
    moves: [
      { code: '5001', qty: -2, kind: 'count', expiry: '2026-12-01', happened_at: '2026-10-26T10:00:00Z' }, // the 2 short-dated boxes aren't there
      { code: '5001', qty: 2, kind: 'count', expiry: '2028-01-01', happened_at: '2026-10-26T10:01:00Z' }, // 2 boxes of a later date are
      { code: 'NEW1', qty: 5, kind: 'count', happened_at: '2026-10-26T10:02:00Z' },
    ],
  };
  const live = liveData(base, AT, changes);
  const c = geniusCorrections({ base, live, since: AT, changes, barcodes: new Map([['NEW1', '6221111111111']]) });
  assert.deepEqual(c.items.map((x) => x.code), ['5001', '5002']);
  const p = c.items.find((x) => x.code === '5001');
  assert.deepEqual(p.oldBatches, [{ qty: 2, expiry: '2026-12-01' }, { qty: 10, expiry: '2027-06-01' }]);
  assert.deepEqual(p.batches, [{ qty: 10, expiry: '2027-06-01' }, { qty: 2, expiry: '2028-01-01' }]);
  assert.equal(p.price, undefined, 'unchanged prices are not sent');
  const k = c.items.find((x) => x.code === '5002');
  assert.deepEqual([k.newName, k.oldName, k.price, k.oldPrice, k.batches], ['كريم شمس 50', 'كريم', 450, 420, undefined]);
  assert.deepEqual(c.added, [{ code: 'NEW1', name: 'صنف جديد', barcode: '6221111111111', cost: 20, price: 30, batches: [{ qty: 5, expiry: null }] }]);
});

test('batches of the same expiry month are one line', () => {
  assert.deepEqual(batchList({ batches: [{ qty: 1, expiry: new Date(2027, 5, 1) }, { qty: 2, expiry: new Date(2027, 5, 15) }, { qty: 0, expiry: null }] }), [{ qty: 3, expiry: '2027-06-01' }]);
});
