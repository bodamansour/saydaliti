import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treasury } from '../src/treasury.js';

const at = (h) => `2026-11-05T${String(h).padStart(2, '0')}:00:00.000Z`;
const until = Date.parse(at(23));

test('treasury: counted balance plus cash in, minus cash out, after the count only', () => {
  const T = treasury({
    moves: [{ kind: 'count', amount: 1000, moved_at: at(8) }, { kind: 'to_bank', amount: 300, moved_at: at(20) }, { kind: 'from_bank', amount: 50, moved_at: at(21) }, { kind: 'adjust', amount: -5, moved_at: at(22) }],
    sales: [
      { kind: 'sale', payment: 'cash', total: 200, credit: 0, sold_at: at(7) }, // before the count: already in it
      { kind: 'sale', payment: 'cash', total: 120, credit: 0, sold_at: at(9) },
      { kind: 'sale', payment: 'cash', total: 100, credit: 70, sold_at: at(10) }, // insurance pays 70 later
      { kind: 'sale', payment: 'card', total: 80, credit: 0, sold_at: at(11) },
      { kind: 'sale', payment: 'credit', total: 60, credit: 60, sold_at: at(11) },
      { kind: 'return', payment: 'cash', total: -40, credit: 0, sold_at: at(12) },
    ],
    customerPayments: [{ amount: 25, created_at: at(13) }],
    expenses: [{ kind: 'electricity', amount: 90, created_at: at(14) }, { kind: 'withdrawal', amount: 100, created_at: at(15) }, { kind: 'rent', amount: 999, created_at: at(6) }],
    supplierPayments: [{ amount: 150, created_at: at(16) }],
    purchases: [{ paid: 30, created_at: at(17) }, { kind: 'return', paid: 10, created_at: at(18) }],
  }, until);
  assert.equal(T.since, at(8)); assert.equal(T.start, 1000);
  assert.deepEqual(T.parts, { sales: 150, refunds: 40, customers: 25, expenses: 90, withdrawals: 100, suppliers: 180, supplierRefunds: 10, toBank: 300, fromBank: 50, adjust: -5, card: 80 });
  assert.equal(T.cashIn, 235); assert.equal(T.cashOut, 710);
  assert.equal(T.balance, 1000 + 235 - 710 - 5);
});

test('treasury: with no count, everything from the start; a later count restarts it', () => {
  const sales = [{ kind: 'sale', payment: 'cash', total: 100, credit: 0, sold_at: at(9) }];
  assert.equal(treasury({ sales }, until).balance, 100);
  assert.equal(treasury({ sales, moves: [{ kind: 'count', amount: 70, moved_at: at(10) }] }, until).balance, 70, 'counted 70: the 100 before it is in the count');
  assert.equal(treasury({ sales, moves: [{ kind: 'count', amount: 70, moved_at: at(10) }] }, Date.parse(at(9) )).balance, 100, 'before the count happened');
});
