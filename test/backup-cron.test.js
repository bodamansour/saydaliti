import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated } from './helpers/d1-fake.js';
import { backupAll } from '../worker/src/backup.js';

function setup(count, staging) {
  const DB = migrated(), objects = new Map();
  const ins = DB.raw.prepare('INSERT INTO pharmacies (id, name, timezone, settings, created_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < count; i++) ins.run(`p-${String(i).padStart(2, '0')}`, `Pharmacy ${i}`, 'Africa/Cairo', '{}', new Date(1_800_000_000_000 + i * 1000).toISOString());
  const FILES = {
    async put(key, value) { objects.set(key, value); },
    async get(key) { const value = objects.get(key); return value ? { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) } : null; },
    async delete(keys) { for (const key of keys) objects.delete(key); },
  };
  return { DB, FILES, BACKUP_KEY: 'test-backup-key-0123456789abcdef', ...(staging ? { DEPLOY_ENV: 'staging' } : {}) };
}

test('staging backs up five oldest due pharmacies per run; production still backs up all', async () => {
  const e = setup(8, true);
  const first = await backupAll(e);
  assert.equal(first.ok, 5); assert.equal(first.failed, 0); assert.equal(first.problems, 3);
  const second = await backupAll(e);
  assert.equal(second.ok, 3); assert.equal(second.failed, 0); assert.equal(second.problems, 0);
  assert.equal((await backupAll(e)).ok, 0, 'recent good backups are not repeated');
  assert.equal(e.DB.raw.prepare("SELECT count(*) AS n FROM backups WHERE status = 'ok'").get().n, 8);

  const prod = setup(8, false);
  assert.equal((await backupAll(prod)).ok, 8);
});

test('a failed staging pharmacy does not block the next pharmacies', async () => {
  const e = setup(8, true), put = e.FILES.put;
  let fail = true;
  e.FILES.put = async (key, value) => {
    if (fail && key.includes('/p-00/')) { fail = false; throw new Error('test write failure'); }
    return put(key, value);
  };
  const first = await backupAll(e);
  assert.equal(first.ok, 4); assert.equal(first.failed, 1);
  const second = await backupAll(e);
  assert.equal(second.ok, 4); assert.equal(second.failed, 0);
  assert.equal(e.DB.raw.prepare("SELECT count(*) AS n FROM backups WHERE status = 'ok'").get().n, 8);
});
