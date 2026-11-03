// Encrypted server backups (worker/src/backup.js): the file can be opened only with the right key and
// for the right pharmacy, any change to it is detected, and no backup is made without a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptBackup, decryptBackup, summarize } from '../worker/src/backup.js';

const env = { BACKUP_KEY: 'test-backup-key-0123456789abcdef-0123' };
const plain = JSON.stringify({ app: 'saydaliti', secret: 'اسم المريض ورقم تليفونه 01001234567', n: 42 });

test('round trip with the right key and pharmacy', async () => {
  const file = await encryptBackup(env, 'ph-1', plain);
  assert.equal(new TextDecoder().decode(file.slice(0, 5)), 'SDBK1');
  assert.equal(await decryptBackup(env, 'ph-1', file), plain);
});

test('the file does not contain the data in the clear', async () => {
  const file = await encryptBackup(env, 'ph-1', plain);
  const asText = new TextDecoder('utf-8', { fatal: false }).decode(file);
  for (const s of ['saydaliti', '01001234567', 'المريض']) assert.ok(!asText.includes(s), `"${s}" is not readable in the file`);
  // Two backups of the same data differ (a new IV each time).
  assert.notDeepEqual(file, await encryptBackup(env, 'ph-1', plain));
});

test('wrong key, another pharmacy, a changed byte, or a cut file: refused', async () => {
  const file = await encryptBackup(env, 'ph-1', plain);
  await assert.rejects(decryptBackup({ BACKUP_KEY: 'another-key-0123456789abcdef-0123456' }, 'ph-1', file), /cannot be opened/);
  await assert.rejects(decryptBackup(env, 'ph-2', file), /cannot be opened/);
  const bent = file.slice(); bent[bent.length - 20] ^= 1;
  await assert.rejects(decryptBackup(env, 'ph-1', bent), /cannot be opened/);
  await assert.rejects(decryptBackup(env, 'ph-1', file.slice(0, 30)), /cannot be opened|not a backup/);
  await assert.rejects(decryptBackup(env, 'ph-1', new TextEncoder().encode('{"plain":"json"}')), /not a backup/);
});

test('no key (or a short one): no backup is made', async () => {
  for (const e of [{}, { BACKUP_KEY: '' }, { BACKUP_KEY: 'short' }]) await assert.rejects(encryptBackup(e, 'ph-1', plain), (err) => err.status === 503);
});

test('the summary counts rows, money and stock, and its checksums ignore row order', async () => {
  const t = (rows) => ({ tables: { pos_sales: rows, purchases: [{ id: 'p', total: 50, kind: 'buy' }], stock_ledger: [{ branch_id: 'b', code: 'A', applied: 5 }, { branch_id: 'b', code: 'A', applied: -2 }] }, blobs: {} });
  const a = await summarize(t([{ id: '1', kind: 'sale', total: 10, credit: 0 }, { id: '2', kind: 'return', total: -4, credit: 0 }]));
  const b = await summarize(t([{ id: '2', kind: 'return', total: -4, credit: 0 }, { id: '1', kind: 'sale', total: 10, credit: 0 }]));
  assert.equal(a.hashes.pos_sales, b.hashes.pos_sales);
  assert.deepEqual(a.money, b.money);
  assert.equal(a.money.sales, 10);
  assert.equal(a.money.returns, -4);
  assert.deepEqual(a.stock, { 'b|A': 3 });
  const c = await summarize(t([{ id: '1', kind: 'sale', total: 11, credit: 0 }, { id: '2', kind: 'return', total: -4, credit: 0 }]));
  assert.notEqual(c.hashes.pos_sales, a.hashes.pos_sales, 'a changed amount changes the checksum');
});
