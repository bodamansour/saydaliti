// The cashier PIN hash needs the server secret PIN_PEPPER; without it the server refuses, instead of
// hashing with a value anyone can read in the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPin } from '../worker/src/auth.js';

test('no PIN secret: refused with a configuration error', async () => {
  for (const env of [{}, { PIN_PEPPER: '' }, { PIN_PEPPER: null }, undefined]) {
    await assert.rejects(hashPin(env, 'p1', '1234'), (e) => e.status === 503 && /PIN secret missing/.test(e.message));
  }
});

test('with the secret: stable, and different per secret, pharmacy and PIN', async () => {
  const a = await hashPin({ PIN_PEPPER: 's1' }, 'p1', '1234');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(await hashPin({ PIN_PEPPER: 's1' }, 'p1', '1234'), a);
  assert.notEqual(await hashPin({ PIN_PEPPER: 's2' }, 'p1', '1234'), a);
  assert.notEqual(await hashPin({ PIN_PEPPER: 's1' }, 'p2', '1234'), a);
  assert.notEqual(await hashPin({ PIN_PEPPER: 's1' }, 'p1', '1235'), a);
  // The old fallback value is no longer used.
  assert.notEqual(await hashPin({ PIN_PEPPER: 's1' }, 'p1', '1234'), await hashPin({ PIN_PEPPER: 'saydaliti' }, 'p1', '1234'));
});
