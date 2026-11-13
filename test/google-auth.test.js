import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated } from './helpers/d1-fake.js';
import { signUp, signInWithGoogle, linkGoogle, mfaSetup, mfaEnable } from '../worker/src/auth.js';
import { verifyGoogleToken } from '../worker/src/google.js';
import { totpAt } from '../worker/src/totp.js';

const id = 'test-web-client.apps.googleusercontent.com';
const enc = (v) => Buffer.from(Buffer.isBuffer(v) ? v : typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const fetchImpl = async (url) => {
  assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs');
  return new Response(JSON.stringify({ keys: [publicKey] }), { headers: { 'Cache-Control': 'max-age=300' } });
};
async function token(sub, email, changes = {}) {
  const head = enc({ alg: 'RS256', kid: 'test-key' });
  const body = enc({ iss: 'https://accounts.google.com', aud: id, sub, email, email_verified: true,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...changes });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${enc(Buffer.from(signature))}`;
}
const env = () => ({ DB: migrated(), GOOGLE_CLIENT_ID: id, PBKDF2_ITER: '10000', SIGNUP_PER_HOUR: '1000',
  TOTP_KEY: 'test-google-totp-key-0123456789abcdef' });

test('Google token: signature, issuer, audience, expiry and verified email are required', async () => {
  const e = env(), good = await token('google-1', 'one@gmail.com');
  assert.deepEqual(await verifyGoogleToken(e, good, fetchImpl), { sub: 'google-1', email: 'one@gmail.com' });
  for (const bad of [
    good.slice(0, -2) + 'xx',
    await token('google-1', 'one@gmail.com', { aud: 'another-client' }),
    await token('google-1', 'one@gmail.com', { iss: 'https://attacker.example' }),
    await token('google-1', 'one@gmail.com', { exp: 1 }),
    await token('google-1', 'one@gmail.com', { email_verified: false }),
  ]) await assert.rejects(verifyGoogleToken(e, bad, fetchImpl), (x) => x.code === 'google_invalid');
});

test('Google creates a new identity; an existing password account needs explicit password linking', async () => {
  const e = env(), first = await token('sub-new', 'new@gmail.com');
  const a = await signInWithGoogle(e, { credential: first }, 'ip-1', fetchImpl);
  assert.equal((await signInWithGoogle(e, { credential: first }, 'ip-1', fetchImpl)).user.id, a.user.id);
  assert.match((await e.DB.prepare('SELECT pw_hash FROM users WHERE id = ?').bind(a.user.id).first()).pw_hash, /^google-only\$/);

  const existing = await signUp(e, { email: 'old@gmail.com', password: 'password123' }, 'ip-2');
  const google = await token('sub-old', 'old@gmail.com');
  await assert.rejects(signInWithGoogle(e, { credential: google }, 'ip-2', fetchImpl), (x) => x.code === 'google_link_required');
  await assert.rejects(linkGoogle(e, existing.user, { credential: google, current_password: 'wrong' }, 'ip-2', fetchImpl), (x) => x.code === 'invalid_credentials');
  assert.deepEqual(await linkGoogle(e, existing.user, { credential: google, current_password: 'password123' }, 'ip-2', fetchImpl), { linked: true });
  assert.equal((await signInWithGoogle(e, { credential: google }, 'ip-2', fetchImpl)).user.id, existing.user.id);
  await assert.rejects(linkGoogle(e, existing.user, { credential: first, current_password: 'password123' }, 'ip-2', fetchImpl), (x) => x.code === 'google_email_mismatch');
});

test('Google login still requires the account two-step code', async () => {
  const e = env();
  const account = await signUp(e, { email: 'mfa@gmail.com', password: 'password123' }, 'ip-3');
  const google = await token('sub-mfa', 'mfa@gmail.com');
  await linkGoogle(e, account.user, { credential: google, current_password: 'password123' }, 'ip-3', fetchImpl);
  const setup = await mfaSetup(e, account.user, { current_password: 'password123' }, 'ip-3');
  const code = await totpAt(setup.secret, Math.floor(Date.now() / 30000));
  const enabled = await mfaEnable(e, account.user, { code }, 'ip-3');
  await assert.rejects(signInWithGoogle(e, { credential: google }, 'ip-3', fetchImpl), (x) => x.code === 'mfa_required');
  assert.ok((await signInWithGoogle(e, { credential: google, code: enabled.recovery[0] }, 'ip-3', fetchImpl)).access_token);
});
