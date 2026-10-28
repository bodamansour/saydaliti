import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinVerifier, matchPin, shiftSummary, cashDifference } from '../src/shifts.js';

test('a cashier is found by PIN with no connection, and only by the right PIN', async () => {
  const staff = [
    { id: 'e1', name: 'سارة', verifier: await pinVerifier('ph1', 'e1', '1234') },
    { id: 'e2', name: 'محمد', verifier: await pinVerifier('ph1', 'e2', '5678') },
  ];
  assert.equal((await matchPin('ph1', staff, '5678')).name, 'محمد');
  assert.equal(await matchPin('ph1', staff, '0000'), null);
  assert.equal(await matchPin('ph2', staff, '1234'), null, 'tied to the pharmacy');
  assert.notEqual(staff[0].verifier, '1234');
});

test('closing a shift: cash expected in the drawer, and the difference with the count', () => {
  const shift = { id: 's1', opening_cash: 200 };
  const sales = [
    { shift_id: 's1', kind: 'sale', total: 150, payment: 'cash', discount: 0 },
    { shift_id: 's1', kind: 'sale', total: 300, payment: 'card', discount: 0 },
    { shift_id: 's1', kind: 'return', total: -50, payment: 'cash', discount: 0 },
    { shift_id: 's1', kind: 'sale', total: 100, payment: 'credit', credit: 100, discount: 0 },
    { shift_id: 'other', kind: 'sale', total: 999, payment: 'cash', discount: 0 },
  ];
  const s = shiftSummary(shift, sales);
  assert.equal(s.receipts, 3);
  assert.equal(s.returns, 1);
  assert.equal(s.cash, 100);
  assert.equal(s.expected, 300); // 200 at the start + 150 − 50
  assert.equal(cashDifference(s.expected, 290), -10);
  assert.equal(cashDifference(s.expected, 300.5), 0.5);
});
