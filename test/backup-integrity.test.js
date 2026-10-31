import test from 'node:test';
import assert from 'node:assert/strict';
import { backupFingerprint } from '../src/local-db.js';

test('backup fingerprints are stable and detect removed table data', async () => {
  const tables = { pharmacies: [{ id: 'p1' }], purchases: [{ id: 1, total: 25 }] };
  const fingerprint = await backupFingerprint(tables);

  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await backupFingerprint(JSON.parse(JSON.stringify(tables))), fingerprint);
  assert.notEqual(await backupFingerprint({ pharmacies: tables.pharmacies }), fingerprint);
});
