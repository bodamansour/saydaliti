import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated } from './helpers/d1-fake.js';
import { signUp, signIn, changePassword, sourceOf, PASSWORD_LIMITS } from '../worker/src/auth.js';

const env = (DB) => ({ DB, PBKDF2_ITER: '10000', SIGNUP_PER_HOUR: '1000' });

test('password attempt counts use the existing index for both account and source prefixes', async () => {
  const DB = migrated(), prepare = DB.prepare, queries = [];
  DB.prepare = (sql) => { if (sql.includes('auth_attempts') && sql.includes('k >= ?')) queries.push(sql); return prepare(sql); };
  await signIn(env(DB), { email: 'index@test.local', password: 'wrong' }, 'ip').catch(() => {});
  const insert = queries.find((sql) => sql.startsWith('INSERT INTO auth_attempts'));
  const count = queries.find((sql) => sql.startsWith('SELECT count(*)'));
  assert.ok(insert && count);
  const insertPlan = DB.raw.prepare(`EXPLAIN QUERY PLAN ${insert}`).all('at', 'a', 'b', 'c', 'a:', 'a;', 'at', 50, 'b:', 'b;', 'at', 10, 'c:', 'c;', 'at', 100);
  const countPlan = DB.raw.prepare(`EXPLAIN QUERY PLAN ${count}`).all('a:', 'a;', 'at');
  assert.ok(insertPlan.filter((row) => /SEARCH auth_attempts USING COVERING INDEX ix_auth_attempts_k_at/.test(row.detail)).length >= 3);
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
  const n = PASSWORD_LIMITS.account + 1;
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => signIn(e, { email, password: 'wrong-password' }, `source-${i}`)));
  const invalid = results.filter((r) => r.status === 'rejected' && r.reason.code === 'invalid_credentials');
  const limited = results.filter((r) => r.status === 'rejected' && r.reason.code === 'over_request_rate_limit');
  assert.equal(invalid.length, PASSWORD_LIMITS.account);
  assert.equal(limited.length, 1, 'parallel requests from many sources cannot exceed the account limit');

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

const count = (rs, code) => rs.filter((r) => r.status === 'rejected' && r.reason.code === code).length;

test('one source cannot lock the owner out: 60 wrong passwords from one address, then the owner signs in from hers', async () => {
  const DB = migrated(), e = env(DB), email = 'owner@test.local';
  await signUp(e, { email, password: 'password123' }, 'signup-ip');
  const rs = await Promise.allSettled(Array.from({ length: 60 }, () => signIn(e, { email, password: 'wrong-password' }, '203.0.113.9')));
  assert.equal(count(rs, 'invalid_credentials'), PASSWORD_LIMITS.accountSource, 'at most 10 checked from that source');
  assert.equal(count(rs, 'over_request_rate_limit'), 60 - PASSWORD_LIMITS.accountSource);
  const start = performance.now();
  const owner = await signIn(e, { email, password: 'password123' }, '198.51.100.7');
  assert.ok(owner.access_token, 'the owner gets in from another address');
  assert.ok(performance.now() - start < 2000, 'and is not made to wait for the attacker\'s tries');
  await assert.rejects(signIn(e, { email, password: 'password123' }, '203.0.113.9'), (x) => x.code === 'over_request_rate_limit', 'only the attacking source waits');
});

test('IPv6: one /64 network is one source (30 addresses in it, at most 10 checked)', async () => {
  const DB = migrated(), e = env(DB), email = 'v6@test.local';
  await signUp(e, { email, password: 'password123' }, 'signup-ip');
  const ips = Array.from({ length: 30 }, (_, i) => `2001:db8:1234:5678:${(i + 1).toString(16)}::${i + 1}`);
  const rs = await Promise.allSettled(ips.map((ip) => signIn(e, { email, password: 'wrong-password' }, ip)));
  assert.equal(count(rs, 'invalid_credentials'), PASSWORD_LIMITS.accountSource);
  assert.equal(sourceOf('2001:db8:1234:5678::1'), sourceOf('2001:0db8:1234:5678:ffff:1:2:3'));
  assert.notEqual(sourceOf('2001:db8:1234:5678::1'), sourceOf('2001:db8:1234:5679::1'));
  assert.equal(sourceOf('203.0.113.5'), '203.0.113.5');
  assert.ok((await signIn(e, { email, password: 'password123' }, '2001:db8:9999::1')).access_token, 'another network signs in');
});

test('the same email written with other letter case or spaces is the same account', async () => {
  const DB = migrated(), e = env(DB);
  await signUp(e, { email: 'case@test.local', password: 'password123' }, 'signup-ip');
  const variants = Array.from({ length: 30 }, (_, i) => [' CASE@TEST.LOCAL ', 'Case@Test.Local', 'case@test.local'][i % 3]);
  const rs = await Promise.allSettled(variants.map((email) => signIn(e, { email, password: 'wrong-password' }, '192.0.2.9')));
  assert.equal(count(rs, 'invalid_credentials'), PASSWORD_LIMITS.accountSource);
});

test('colleagues behind one router: mistyping and signing in all day never lock anyone', async () => {
  const DB = migrated(), e = env(DB), shared = '192.0.2.50';
  const people = Array.from({ length: 25 }, (_, i) => `staff${i}@test.local`);
  for (const p of people) await signUp(e, { email: p, password: 'password123' }, 'signup-ip');
  for (const p of people) for (let k = 0; k < 3; k++) await signIn(e, { email: p, password: 'typo' }, shared).catch(() => {}); // 75 wrong
  for (const p of people) assert.ok((await signIn(e, { email: p, password: 'password123' }, shared)).access_token, `${p} signs in`);
  for (let i = 0; i < 40; i++) assert.ok((await signIn(e, { email: people[0], password: 'password123' }, shared)).access_token, 'right passwords are taken back out of the counts');
});

test('changing the password goes through the same limits', async () => {
  const DB = migrated(), e = env(DB);
  const s = await signUp(e, { email: 'change@test.local', password: 'password123' }, 'signup-ip');
  const user = { id: s.user.id, email: 'change@test.local' };
  const rs = await Promise.allSettled(Array.from({ length: 30 }, () => changePassword(e, user, { password: 'new-password1', current_password: 'wrong' }, '192.0.2.77')));
  assert.equal(count(rs, 'invalid_credentials'), PASSWORD_LIMITS.accountSource);
  await changePassword(e, user, { password: 'new-password1', current_password: 'password123' }, '192.0.2.78');
});
