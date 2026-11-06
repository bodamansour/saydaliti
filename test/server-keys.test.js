// The keys behind two-step sign-in (TOTP_KEY) and PINs (PIN_PEPPER): each can be changed without locking
// anyone out (the old value goes in *_OLD), and nothing falls back to another secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated } from './helpers/d1-fake.js';
import { signUp, signIn, mfaSetup, mfaEnable, mfaReady } from '../worker/src/auth.js';
import { RPC } from '../worker/src/rpc.js';
import { totpAt } from '../worker/src/totp.js';

const PEP = 'test-pepper-0123456789abcdef', K1 = 'test-totp-key-1-0123456789abcdef-x', K2 = 'test-totp-key-2-0123456789abcdef-x';
const code = (secret, shift = 0) => totpAt(secret, Math.floor(Date.now() / 30000) + shift);
const base = (DB, o = {}) => ({ DB, PIN_PEPPER: PEP, PBKDF2_ITER: '1000', SIGNUP_PER_HOUR: '1000', ...o });
const legacySeal = async (secret, pepper) => {
  const enc = new TextEncoder(), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode(`${pepper}:totp`)), 'AES-GCM', false, ['encrypt']);
  const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `v1:${hex(iv)}:${hex(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(secret)))}`;
};

test('legacy v1 uses current or old PIN pepper and migrates only after a valid authenticator code', async () => {
  for (const keyLocation of ['current', 'old']) {
    const DB = migrated(), initial = base(DB, { TOTP_KEY: K1 }), email = `${keyLocation}@test.local`;
    const s = await signUp(initial, { email, password: 'password123' }, 'ip'), user = s.user;
    const setup = await mfaSetup(initial, user, { current_password: 'password123' }, 'ip');
    await mfaEnable(initial, user, { code: await code(setup.secret) }, 'ip');
    const legacy = await legacySeal(setup.secret, PEP);
    DB.raw.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(legacy, user.id);
    const rotated = base(DB, keyLocation === 'old' ? { PIN_PEPPER: 'new-pepper-0123456789abcdef', PIN_PEPPER_OLD: PEP, TOTP_KEY: K2 } : { TOTP_KEY: K2 });
    await assert.rejects(signIn(rotated, { email, password: 'password123', code: 'invalid' }, 'ip'), (err) => err.code === 'mfa_invalid');
    assert.equal(DB.raw.prepare('SELECT totp_secret FROM users WHERE id = ?').get(user.id).totp_secret, legacy);
    assert.ok((await signIn(rotated, { email, password: 'password123', code: await code(setup.secret, 1) }, 'ip')).access_token);
    assert.match(DB.raw.prepare('SELECT totp_secret FROM users WHERE id = ?').get(user.id).totp_secret, /^v2:/);
  }
});

test('recovery codes remain one-use when the legacy or v2 decryption key is missing', async () => {
  for (const format of ['v1', 'v2']) {
    const DB = migrated(), initial = base(DB, { TOTP_KEY: K1 }), email = `${format}@test.local`;
    const s = await signUp(initial, { email, password: 'password123' }, 'ip'), user = s.user;
    const setup = await mfaSetup(initial, user, { current_password: 'password123' }, 'ip');
    const { recovery } = await mfaEnable(initial, user, { code: await code(setup.secret) }, 'ip');
    if (format === 'v1') DB.raw.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(await legacySeal(setup.secret, PEP), user.id);
    const lost = base(DB, { PIN_PEPPER: 'wrong-pepper', TOTP_KEY: undefined });
    await assert.rejects(signIn(lost, { email, password: 'password123', code: 'invalid' }, 'bad'), (err) => ['mfa_key_missing', 'mfa_not_configured'].includes(err.code));
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => signIn(lost, { email, password: 'password123', code: recovery[0] }, `source-${i}`)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, format);
    assert.equal(JSON.parse(DB.raw.prepare('SELECT totp_recovery FROM users WHERE id = ?').get(user.id).totp_recovery).length, 7);
  }
});

test('two-step sign-in: its own key; rotating it keeps everyone in and re-encrypts with the new key', async () => {
  const DB = migrated();
  const env1 = base(DB, { TOTP_KEY: K1 });
  const s = await signUp(env1, { email: 'a@test.local', password: 'password123' }, 'ip');
  const user = { id: s.user.id, email: 'a@test.local' };
  const setup = await mfaSetup(env1, user, { current_password: 'password123' }, 'ip');
  await mfaEnable(env1, user, { code: await code(setup.secret) }, 'ip');
  const sealed1 = DB.raw.prepare('SELECT totp_secret FROM users WHERE id = ?').get(user.id).totp_secret;
  assert.match(sealed1, /^v2:[0-9a-f]{12}:/);
  assert.ok(!sealed1.includes(setup.secret), 'kept encrypted');
  // Rotated: the new key in TOTP_KEY, the old one in TOTP_KEY_OLD.
  const env2 = base(DB, { TOTP_KEY: K2, TOTP_KEY_OLD: K1 });
  assert.ok((await signIn(env2, { email: 'a@test.local', password: 'password123', code: await code(setup.secret, 1) }, 'ip')).access_token);
  const sealed2 = DB.raw.prepare('SELECT totp_secret FROM users WHERE id = ?').get(user.id).totp_secret;
  assert.notEqual(sealed2.split(':')[1], sealed1.split(':')[1], 'sealed again with the new key');
  // After that the old key is no longer needed.
  const env3 = base(DB, { TOTP_KEY: K2 });
  assert.ok((await signIn(env3, { email: 'a@test.local', password: 'password123', code: await code(setup.secret, -1) }, 'ip')).access_token);
  // Without the key that sealed it: a clear error, never a pass.
  await assert.rejects(signIn(base(DB, { TOTP_KEY: 'another-key-0123456789abcdef-0123456' }), { email: 'a@test.local', password: 'password123', code: await code(setup.secret) }, 'ip'), /can not be read/);
});

test('two-step sign-in is off without TOTP_KEY (no fallback to PIN_PEPPER)', async () => {
  const DB = migrated();
  const env = base(DB);
  assert.equal(await mfaReady(env), false);
  const s = await signUp(env, { email: 'b@test.local', password: 'password123' }, 'ip');
  await assert.rejects(mfaSetup(env, { id: s.user.id, email: 'b@test.local' }, { current_password: 'password123' }, 'ip'), (e) => e.code === 'mfa_not_configured');
});

test('changing PIN_PEPPER: an old PIN works once with PIN_PEPPER_OLD and is hashed again', async () => {
  const DB = migrated();
  const env1 = base(DB);
  const s = await signUp(env1, { email: 'c@test.local', password: 'password123' }, 'ip');
  const ctx = (e) => ({ user: { id: s.user.id }, roles: new Map([[P, 'owner']]) });
  let P = null;
  P = await RPC.create_pharmacy(env1, { user: { id: s.user.id }, roles: new Map() }, { p_name: 'صيدلية' });
  const emp = await RPC.add_employee(env1, ctx(), { p_pharmacy: P, p_name: 'سارة', p_pin: '4821' });
  const h1 = DB.raw.prepare('SELECT pin_hash FROM employees WHERE id = ?').get(emp).pin_hash;
  const env2 = base(DB, { PIN_PEPPER: 'test-pepper-NEW-0123456789abcd', PIN_PEPPER_OLD: PEP });
  const r = await RPC.clock(env2, ctx(), { p_pharmacy: P, p_pin: '4821' });
  assert.ok(r, 'the old PIN still works');
  const h2 = DB.raw.prepare('SELECT pin_hash FROM employees WHERE id = ?').get(emp).pin_hash;
  assert.notEqual(h2, h1, 'hashed again with the new pepper');
  const env3 = base(DB, { PIN_PEPPER: 'test-pepper-NEW-0123456789abcd' });
  assert.ok(await RPC.clock(env3, ctx(), { p_pharmacy: P, p_pin: '4821' }), 'works without the old pepper now');
  await assert.rejects(RPC.clock(env3, ctx(), { p_pharmacy: P, p_pin: '1111' }), /wrong pin/);
  // Without any pepper the server refuses PIN work.
  await assert.rejects(RPC.clock(base(DB, { PIN_PEPPER: undefined }), ctx(), { p_pharmacy: P, p_pin: '4821' }), /PIN secret missing/);
});
