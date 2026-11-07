// Server stock vs the app's stock (src/stock-reconcile.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, openingItems } from '../src/stock-reconcile.js';

test('no difference when both agree, including items only one side lists at zero', () => {
  const r = reconcile([{ code: 'A', qty: 5 }, { code: 'Z', qty: 0 }], [{ code: 'A', qty: 5.0000001, name: 'أ' }, { code: 'B', qty: 0 }]);
  assert.deepEqual(r.diffs, []);
  assert.equal(r.checked, 3);
});

test('differences, biggest first, with the item name', () => {
  const r = reconcile([{ code: 'A', qty: 5 }, { code: 'B', qty: -2 }, { code: 'S', qty: 1 }], [{ code: 'A', qty: 4, name: 'بانادول' }, { code: 'B', qty: 3, name: 'ب' }, { code: 'N', qty: 2, name: 'جديد' }]);
  assert.deepEqual(r.diffs.map((d) => [d.code, d.server, d.app, d.diff]), [['B', -2, 3, -5], ['N', 0, 2, -2], ['A', 5, 4, 1], ['S', 1, 0, 1]]);
  assert.equal(r.diffs.find((d) => d.code === 'A').name, 'بانادول');
});

test('opening items: one entry per code, boxes rounded', () => {
  assert.deepEqual(openingItems([{ code: 1, qty: 2.5 }, { code: '1', qty: 0.5 }, { code: 'B', qty: 0 }]), [{ code: '1', qty: 3 }, { code: 'B', qty: 0 }]);
});
