// Sign in with Google: the round trip is tied to this browser (state + PKCE in a short cookie), the ID token's
// claims are checked, a new email opens an account with no password, and an account with two-step sign-in
// is refused (it keeps its password and code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated } from './helpers/d1-fake.js';
import { googleStart, googleCallback, googleClaims, googleReady } from '../worker/src/google.js';
import { signIn } from '../worker/src/auth.js';

const env0 = () => ({ DB: migrated(), GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'sec', SITE_URL: 'https://tablix.example', PBKDF2_ITER: '10000' });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (over = {}) => `${b64({ alg: 'RS256' })}.${b64({ iss: 'https://accounts.google.com', aud: 'cid.apps.googleusercontent.com', exp: Math.floor(Date.now() / 1000) + 600, email: 'Owner@Gmail.com', email_verified: true, sub: '1234', ...over })}.sig`;
const google = (calls, token = idToken()) => async (url, init) => { calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) }); return new Response(JSON.stringify({ id_token: token }), { status: 200 }); };

async function start(env) {
  const r = await googleStart(env, new URL('https://tablix.example/api/auth/google/start'));
  const loc = new URL(r.headers.get('Location'));
  const cookie = r.headers.get('Set-Cookie').split(';')[0];
  return { r, loc, cookie, state: loc.searchParams.get('state') };
}
const back = (env, { cookie, state, code = 'c0de' }, opts) => googleCallback(env,
  new Request(`https://tablix.example/api/auth/google/callback?state=${state}&code=${code}`, { headers: cookie ? { Cookie: cookie } : {} }),
  new URL(`https://tablix.example/api/auth/google/callback?state=${state}&code=${code}`), opts);

test('off without the keys; the start goes to Google with state and PKCE', async () => {
  assert.equal(googleReady({}), false);
  await assert.rejects(googleStart({}, new URL('https://x/')), /not set up/);
  const { r, loc, cookie, state } = await start(env0());
  assert.equal(r.status, 302);
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://tablix.example/api/auth/google/callback');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(loc.searchParams.get('scope'), 'openid email');
  assert.match(cookie, new RegExp(`^sd_g=${state}\\.[0-9a-f]{64}$`));
  assert.match(r.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
});

test('the ID token: audience, issuer, expiry and a verified email', () => {
  const id = 'cid.apps.googleusercontent.com';
  assert.deepEqual(googleClaims(idToken(), id), { email: 'owner@gmail.com', sub: '1234' });
  assert.equal(googleClaims(idToken({ aud: 'someone-else' }), id), null);
  assert.equal(googleClaims(idToken({ iss: 'https://evil.example' }), id), null);
  assert.equal(googleClaims(idToken({ exp: 1 }), id), null);
  assert.equal(googleClaims(idToken({ email_verified: false }), id), null);
  assert.equal(googleClaims('garbage', id), null);
});

test('back from Google: a new account, signed in, and the verifier sent; no password works for it', async () => {
  const env = env0();
  const calls = [];
  const s = await start(env);
  const r = await back(env, s, { fetchImpl: google(calls) });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/');
  assert.match(r.headers.get('Set-Cookie'), /sd_session=[0-9a-f]{64}/);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[0].body.code_verifier, s.cookie.split('.')[1]);
  assert.equal(calls[0].body.redirect_uri, 'https://tablix.example/api/auth/google/callback');
  const u = await env.DB.prepare('SELECT email, pw_hash FROM users').first();
  assert.equal(u.email, 'owner@gmail.com');
  assert.match(u.pw_hash, /^google\$/);
  await assert.rejects(signIn(env, { email: 'owner@gmail.com', password: 'google$' }, '1.1.1.1'), /Invalid login/);
  // Signing in again: the same account.
  const s2 = await start(env);
  await back(env, s2, { fetchImpl: google([]) });
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n, 1);
});

test('refused: another browser\'s callback, a cancelled sign-in, a bad token, an account with two-step sign-in', async () => {
  const env = env0();
  const s = await start(env);
  const where = async (r) => new URL(r.headers.get('Location'), 'https://x').searchParams.get('google');
  assert.equal(await where(await back(env, { ...s, cookie: null }, { fetchImpl: google([]) })), 'expired');
  assert.equal(await where(await back(env, { ...s, state: 'f'.repeat(32) }, { fetchImpl: google([]) })), 'expired');
  const cancel = await googleCallback(env, new Request('https://x/?error=access_denied'), new URL('https://x/api/auth/google/callback?error=access_denied'));
  assert.equal(await where(cancel), 'cancelled');
  assert.equal(await where(await back(env, s, { fetchImpl: google([], idToken({ aud: 'other' })) })), 'failed');
  await env.DB.prepare("INSERT INTO users (id, email, pw_hash, totp_secret, created_at) VALUES ('u2', 'owner@gmail.com', 'pbkdf2$1$00$00', 'sealed', '2026-01-01')").run();
  assert.equal(await where(await back(env, s, { fetchImpl: google([]) })), 'mfa');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n, 0);
});
