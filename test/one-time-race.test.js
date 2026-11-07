// One-time codes under requests sent at the same moment: the reset link, a recovery code and a TOTP code
// each work once. The fake D1 runs each statement on its own, and the password hashing between the read
// and the write really waits (WebCrypto), so the requests interleave the way they can on the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated } from './helpers/d1-fake.js';
import { signUp, signIn, mfaSetup, mfaEnable, forgotPassword, resetPassword, checkPassword, sha256 } from '../worker/src/auth.js';
import { totpAt } from '../worker/src/totp.js';

const env = (DB) => ({ DB, PIN_PEPPER: 'test-pepper-0123456789abcdef', TOTP_KEY: 'test-totp-key-1-0123456789abcdef-x', PBKDF2_ITER: '1000', SIGNUP_PER_HOUR: '1000', EMAIL_OUTBOX: 'dev' });
const settle = (ps) => Promise.allSettled(ps).then((r) => r.filter((x) => x.status === 'fulfilled').length);
const serializeBatches = (DB) => {
  const batch = DB.batch.bind(DB); let tail = Promise.resolve();
  DB.batch = (statements) => { const result = tail.then(() => batch(statements)); tail = result.catch(() => {}); return result; };
};

test('the same reset link sent 8 times at once: one password is set', async () => {
  const DB = migrated(); const e = env(DB);
  await signUp(e, { email: 'r@test.local', password: 'old-password1' }, 'ip');
  await forgotPassword(e, { email: 'r@test.local' }, 'ip', 'http://x');
  const token = /#reset=([0-9a-f]{64})/.exec(DB.raw.prepare('SELECT body FROM email_outbox').get().body)[1];
  const pws = Array.from({ length: 8 }, (_, i) => `race-password-${i}`);
  serializeBatches(DB);
  const results = await Promise.allSettled(pws.map((password, i) => resetPassword(e, { token, password }, `ip${i}`)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'reset_invalid'));
  const hash = DB.raw.prepare('SELECT pw_hash FROM users WHERE email = ?').get('r@test.local').pw_hash;
  const matches = await Promise.all(pws.map((pw) => checkPassword(pw, hash)));
  assert.equal(matches.filter(Boolean).length, 1, 'the password in the database is the one whose request won');
  assert.ok((await signIn(e, { email: 'r@test.local', password: pws[matches.indexOf(true)] }, 'ip2')).access_token);
});

test('two reset links for the same account racing can change the password only once', async () => {
  const DB = migrated(), e = env(DB), email = 'two-links@test.local';
  await signUp(e, { email, password: 'old-password1' }, 'ip');
  await forgotPassword(e, { email }, 'ip', 'http://x');
  await forgotPassword(e, { email }, 'ip', 'http://x');
  const tokens = DB.raw.prepare('SELECT body FROM email_outbox ORDER BY rowid').all().map((row) => /#reset=([0-9a-f]{64})/.exec(row.body)[1]);
  const passwords = ['new-password1', 'new-password2'];
  serializeBatches(DB);
  const results = await Promise.allSettled(tokens.map((token, i) => resetPassword(e, { token, password: passwords[i] }, `ip${i}`)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'reset_invalid');
  const hash = DB.raw.prepare('SELECT pw_hash FROM users WHERE email = ?').get(email).pw_hash;
  const matches = await Promise.all(passwords.map((pw) => checkPassword(pw, hash)));
  assert.equal(matches.filter(Boolean).length, 1);
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
});

test('a reset session failure rolls back the token, password and existing sessions', async () => {
  const DB = migrated(), e = env(DB), email = 'rollback@test.local';
  await signUp(e, { email, password: 'old-password1' }, 'ip');
  await forgotPassword(e, { email }, 'ip', 'http://x');
  await forgotPassword(e, { email }, 'ip', 'http://x');
  const token = /#reset=([0-9a-f]{64})/.exec(DB.raw.prepare('SELECT body FROM email_outbox ORDER BY rowid').get().body)[1];
  const snapshot = () => ['users', 'sessions', 'password_resets'].map((table) => DB.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row })));
  const before = snapshot();
  DB.exec("CREATE TRIGGER fail_reset_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END");
  await assert.rejects(resetPassword(e, { token, password: 'new-password1' }, 'ip'), /injected reset failure/);
  assert.deepEqual(snapshot(), before);
});

const mfaUser = async (e, email) => {
  const s = await signUp(e, { email, password: 'password123' }, 'ip');
  const user = { id: s.user.id, email };
  const setup = await mfaSetup(e, user, { current_password: 'password123' }, 'ip');
  const { recovery } = await mfaEnable(e, user, { code: await totpAt(setup.secret, Math.floor(Date.now() / 30000) - 1) }, 'ip');
  return { user, secret: setup.secret, recovery };
};
const tries = (e, email, code, n = 8) => Array.from({ length: n }, (_, i) => signIn(e, { email, password: 'password123', code }, `ip${i}`));

test('reset with two-step sign-in enabled keeps it on and creates no session', async () => {
  const DB = migrated(), e = env(DB), email = 'reset-mfa@test.local';
  const { user } = await mfaUser(e, email);
  const secret = DB.raw.prepare('SELECT totp_secret FROM users WHERE id = ?').get(user.id).totp_secret;
  await forgotPassword(e, { email }, 'ip', 'http://x');
  const token = /#reset=([0-9a-f]{64})/.exec(DB.raw.prepare('SELECT body FROM email_outbox').get().body)[1];
  assert.deepEqual(await resetPassword(e, { token, password: 'new-password1' }, 'ip'), { reset: true, mfa: true });
  assert.equal(DB.raw.prepare('SELECT totp_secret FROM users WHERE id = ?').get(user.id).totp_secret, secret);
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?').get(user.id).n, 0);
});

test('the same recovery code sent 8 times at once: one sign-in, and only that code is used up', async () => {
  const DB = migrated(); const e = env(DB);
  const m = await mfaUser(e, 'm@test.local');
  assert.equal(await settle(tries(e, 'm@test.local', m.recovery[0])), 1);
  assert.equal(JSON.parse(DB.raw.prepare('SELECT totp_recovery FROM users WHERE id = ?').get(m.user.id).totp_recovery).length, m.recovery.length - 1, 'the other codes still work');
});

test('the same TOTP code sent 8 times at once: one sign-in', async () => {
  const DB = migrated(); const e = env(DB);
  const m = await mfaUser(e, 't@test.local');
  assert.equal(await settle(tries(e, 't@test.local', await totpAt(m.secret, Math.floor(Date.now() / 30000)))), 1);
});

test('one source can check only five codes and another source can use a recovery code', async () => {
  const DB = migrated(), e = env(DB), m = await mfaUser(e, 'g@test.local');
  const rs = await Promise.allSettled(Array.from({ length: 6 }, () => signIn(e, { email: 'g@test.local', password: 'password123', code: 'not-a-code' }, 'attacker')));
  const checked = rs.filter((r) => r.status === 'rejected' && r.reason.code === 'mfa_invalid').length;
  const limited = rs.filter((r) => r.status === 'rejected' && r.reason.code === 'over_request_rate_limit').length;
  assert.equal(checked, 5); assert.equal(limited, 1);
  assert.ok((await signIn(e, { email: 'g@test.local', password: 'password123', code: m.recovery[0] }, 'owner')).access_token);
  assert.equal(DB.raw.prepare("SELECT count(*) AS n FROM auth_attempts WHERE k LIKE 'mfa:a:%'").get().n, 5, 'successful recovery releases only its own reservation');
});

test('the account limit reserves the final slot atomically across distinct sources', async () => {
  const DB = migrated(), e = env(DB), m = await mfaUser(e, 'aggregate@test.local');
  const ins = DB.raw.prepare('INSERT INTO auth_attempts (k, at) VALUES (?, ?)'), at = new Date().toISOString();
  for (let i = 0; i < 19; i++) {
    const suffix = i.toString(16).padStart(32, '0');
    ins.run(`mfa:a:${m.user.id}:${suffix}`, at);
    ins.run(`mfa:s:${m.user.id}:${await sha256(`prior-${i}`)}:${suffix}`, at);
  }
  const rs = await Promise.allSettled(tries(e, 'aggregate@test.local', 'not-a-code', 2));
  assert.equal(rs.filter((r) => r.status === 'rejected' && r.reason.code === 'mfa_invalid').length, 1);
  assert.equal(rs.filter((r) => r.status === 'rejected' && r.reason.code === 'over_request_rate_limit').length, 1);
  await assert.rejects(signIn(e, { email: 'aggregate@test.local', password: 'password123', code: m.recovery[0] }, 'owner'), (err) => err.code === 'over_request_rate_limit');
  DB.raw.prepare("UPDATE auth_attempts SET at = '2000-01-01T00:00:00.000Z' WHERE k LIKE 'mfa:%'").run();
  assert.ok((await signIn(e, { email: 'aggregate@test.local', password: 'password123', code: m.recovery[0] }, 'owner')).access_token);
});

test('wrong two-step codes receive a progressive delay', async () => {
  const DB = migrated(), e = env(DB);
  await mfaUser(e, 'mfa-delay@test.local');
  await signIn(e, { email: 'mfa-delay@test.local', password: 'password123', code: 'not-a-code' }, 'ip').catch(() => {});
  const start = performance.now();
  await signIn(e, { email: 'mfa-delay@test.local', password: 'password123', code: 'not-a-code' }, 'ip').catch(() => {});
  assert.ok(performance.now() - start >= 200);
});

test('forgotten password: the same answer, at once, whether the account exists and whether the email goes out', async () => {
  const DB = migrated();
  const e = { ...env(DB), EMAIL_OUTBOX: undefined, RESEND_API_KEY: 'test-resend-key', EMAIL_FROM: 'test@test.local' };
  await signUp(e, { email: 'f@test.local', password: 'password123' }, 'ip');
  const real = globalThis.fetch, sent = [], errs = [], logged = console.error;
  globalThis.fetch = async (u) => { sent.push(String(u)); return new Response('down', { status: 500 }); }; // the email service fails
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const later = [];
    const known = await forgotPassword(e, { email: 'f@test.local' }, 'ip1', 'http://x', (p) => later.push(p));
    const unknown = await forgotPassword(e, { email: 'nobody@test.local' }, 'ip2', 'http://x', (p) => later.push(p));
    assert.deepEqual(known, unknown, 'same answer');
    assert.equal(later.length, 1, 'the email is sent after the answer');
    await Promise.all(later);
    assert.deepEqual(sent, ['https://api.resend.com/emails']);
    assert.match(errs.join('\n'), /RESET_EMAIL_FAILED email_failed/, 'a failed send is logged on the server');
    assert.ok(!errs.join('\n').includes('test-resend-key'), 'no key in the log');
  } finally { globalThis.fetch = real; console.error = logged; }
});
