import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated } from './helpers/d1-fake.js';
import { signUp, signIn } from '../worker/src/auth.js';

const env = (DB) => ({ DB, PBKDF2_ITER: '10000', SIGNUP_PER_HOUR: '1000' });

test('password attempt counts use the existing index for both account and source prefixes', async () => {
  const DB = migrated(), prepare = DB.prepare, queries = [];
  DB.prepare = (sql) => { if (sql.includes('auth_attempts') && sql.includes('k >= ?')) queries.push(sql); return prepare(sql); };
  await signIn(env(DB), { email: 'index@test.local', password: 'wrong' }, 'ip').catch(() => {});
  const insert = queries.find((sql) => sql.startsWith('INSERT INTO auth_attempts'));
  const count = queries.find((sql) => sql.startsWith('SELECT count(*)'));
  assert.ok(insert && count);
  const insertPlan = DB.raw.prepare(`EXPLAIN QUERY PLAN ${insert}`).all('at', 'a', 'b', 'a:', 'a;', 'at', 10, 'b:', 'b;', 'at', 100);
  const countPlan = DB.raw.prepare(`EXPLAIN QUERY PLAN ${count}`).all('a:', 'a;', 'at');
  assert.ok(insertPlan.filter((row) => /SEARCH auth_attempts USING COVERING INDEX ix_auth_attempts_k_at/.test(row.detail)).length >= 2);
  assert.ok(!insertPlan.some((row) => /SCAN auth_attempts/.test(row.detail)));
  assert.ok(countPlan.some((row) => /SEARCH auth_attempts USING COVERING INDEX ix_auth_attempts_k_at/.test(row.detail)));
  for (const { k } of DB.raw.prepare('SELECT k FROM auth_attempts').all()) {
    const prefix = k.slice(0, -32), end = `${prefix.slice(0, -1)};`;
    assert.ok(k >= prefix && k < end, 'the range contains generated hexadecimal suffixes');
  }
});

test('password guesses are reserved atomically per account, with generic failures and a temporary window', async () => {
  const DB = migrated(), e = env(DB), email = 'account@test.local';
  await signUp(e, { email, password: 'password123' }, 'signup-ip');
  const results = await Promise.allSettled(Array.from({ length: 11 }, (_, i) => signIn(e, { email, password: 'wrong-password' }, `source-${i}`)));
  const invalid = results.filter((r) => r.status === 'rejected' && r.reason.code === 'invalid_credentials');
  const limited = results.filter((r) => r.status === 'rejected' && r.reason.code === 'over_request_rate_limit');
  assert.equal(invalid.length, 10);
  assert.equal(limited.length, 1, 'parallel requests cannot exceed the account limit');

  DB.raw.prepare("UPDATE auth_attempts SET at = '2000-01-01T00:00:00.000Z'").run();
  const known = await signIn(e, { email, password: 'wrong-password' }, 'fresh-source').catch((x) => x);
  const unknown = await signIn(e, { email: 'missing@test.local', password: 'wrong-password' }, 'other-source').catch((x) => x);
  assert.equal(known.message, unknown.message);
  assert.equal(known.code, unknown.code);
  assert.equal(known.code, 'invalid_credentials');
});

test('a busy shared source is capped without an account lockout', async () => {
  const DB = migrated(), e = env(DB), ip = 'shared-source';
  const results = await Promise.allSettled(Array.from({ length: 101 }, (_, i) => signIn(e, { email: `missing-${i}@test.local`, password: 'wrong-password' }, ip)));
  const invalid = results.filter((r) => r.status === 'rejected' && r.reason.code === 'invalid_credentials');
  const limited = results.filter((r) => r.status === 'rejected' && r.reason.code === 'over_request_rate_limit');
  assert.equal(invalid.length, 100);
  assert.equal(limited.length, 1, 'parallel requests cannot exceed the source limit');

  await signUp(e, { email: 'other-user@test.local', password: 'password123' }, 'different-source');
  const signedIn = await signIn(e, { email: 'other-user@test.local', password: 'password123' }, 'different-source');
  assert.ok(signedIn.access_token, 'a shared source limit does not lock another account');
});

test('repeated wrong passwords get an enforced progressive response delay capped at eight seconds', async () => {
  const e = env(migrated()), email = 'delay@test.local';
  await signUp(e, { email, password: 'password123' }, 'signup-ip');
  await signIn(e, { email, password: 'wrong-password' }, 'ip').catch(() => {});
  const start = performance.now();
  await signIn(e, { email, password: 'wrong-password' }, 'ip').catch(() => {});
  assert.ok(performance.now() - start >= 200, 'the second failed attempt waits before returning');
});
