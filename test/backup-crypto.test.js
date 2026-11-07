// Encrypted server backups (worker/src/backup.js): the file can be opened only with the right key and
// for the right pharmacy, any change to it is detected, and no backup is made without a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptBackup, decryptBackup, summarize, keyIdOfFile } from '../worker/src/backup.js';

const env = { BACKUP_KEY: 'test-backup-key-0123456789abcdef-0123' };
const plain = JSON.stringify({ app: 'saydaliti', secret: 'اسم المريض ورقم تليفونه 01001234567', n: 42 });

test('round trip with the right key and pharmacy', async () => {
  const file = await encryptBackup(env, 'ph-1', plain);
  assert.equal(new TextDecoder().decode(file.slice(0, 5)), 'SDBK2'); // with the key id
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
  await assert.rejects(decryptBackup({ BACKUP_KEY: 'another-key-0123456789abcdef-0123456' }, 'ph-1', file), /key not available/);
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

test('key rotation: with the old key kept in BACKUP_KEYS_OLD, old backups still open; new ones use the new key', async () => {
  const k1 = 'first-backup-key-0123456789abcdef-01234', k2 = 'second-backup-key-0123456789abcdef-0123';
  const old = await encryptBackup({ BACKUP_KEY: k1 }, 'ph-1', plain);
  const rotated = { BACKUP_KEY: k2, BACKUP_KEYS_OLD: `${k1}` };
  assert.equal(await decryptBackup(rotated, 'ph-1', old), plain, 'an old backup after rotation');
  const fresh = await encryptBackup(rotated, 'ph-1', plain);
  assert.notEqual(await keyIdOfFile(fresh), await keyIdOfFile(old), 'new backups are made with the new key');
  assert.equal(await decryptBackup({ BACKUP_KEY: k2 }, 'ph-1', fresh), plain);
  // Several retired keys, with spaces.
  assert.equal(await decryptBackup({ BACKUP_KEY: k2, BACKUP_KEYS_OLD: ` x , ${k1} ` }, 'ph-1', old), plain);
});

test('key lost (rotation without keeping the old key): old backups are reported unreadable, new ones work', async () => {
  const k1 = 'first-backup-key-0123456789abcdef-01234', k2 = 'second-backup-key-0123456789abcdef-0123';
  const old = await encryptBackup({ BACKUP_KEY: k1 }, 'ph-1', plain);
  await assert.rejects(decryptBackup({ BACKUP_KEY: k2 }, 'ph-1', old), /key not available \(key id [0-9a-f]{16}\)/);
  const fresh = await encryptBackup({ BACKUP_KEY: k2 }, 'ph-1', plain);
  assert.equal(await decryptBackup({ BACKUP_KEY: k2 }, 'ph-1', fresh), plain, 'backups made after the loss are fine');
});

test('older SDBK1 files (before key ids) still open with the key that made them', async () => {
  // Made the way the first version did: "SDBK1" + IV + AES-GCM, same key derivation.
  const enc = new TextEncoder(), key = env.BACKUP_KEY;
  const base = await crypto.subtle.importKey('raw', enc.encode(key), 'HKDF', false, ['deriveKey']);
  const aes = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('ph-1'), info: enc.encode('saydaliti-backup-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('ph-1') }, aes, enc.encode(plain)));
  const v1 = new Uint8Array([...enc.encode('SDBK1'), ...iv, ...ct]);
  assert.equal(await decryptBackup(env, 'ph-1', v1), plain);
  assert.equal(await decryptBackup({ BACKUP_KEY: 'zzzz-0123456789abcdef-0123456789abcdef', BACKUP_KEYS_OLD: key }, 'ph-1', v1), plain);
});

test('a changed key id in the header is caught (the file is not opened with the wrong key)', async () => {
  const file = await encryptBackup(env, 'ph-1', plain);
  const bent = file.slice(); bent[6] ^= 1;
  await assert.rejects(decryptBackup(env, 'ph-1', bent), /key not available/);
});
