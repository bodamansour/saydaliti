// Sign in with Google (OpenID Connect, the authorization-code flow with PKCE), on the website.
//   GET /api/auth/google/start     → to Google's account chooser
//   GET /api/auth/google/callback  ← back from Google: the account's verified email signs in (or opens a new
//                                    account with no password), then to the app
// The state and the PKCE verifier live in a short HttpOnly cookie for this one round trip, so a callback
// started in another browser (or forged by another site) signs nobody in. The ID token comes straight from
// Google's token endpoint over TLS with our client secret, so its claims are checked (audience, issuer,
// expiry, verified email) without fetching Google's signing keys (OpenID Connect Core 3.1.3.7). An account
// with two-step sign-in keeps its password and code: Google is refused for it. Off unless the server has
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET; refused on staging (guardedFetch).
import { ApiError, nowIso, uuid } from './db.js';
import { newSession, randomHex, sha256, sessionCookie } from './auth.js';

export const googleReady = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const STATE_COOKIE = 'sd_g';
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const redirectUri = (env, origin) => `${(env.SITE_URL || origin).replace(/\/$/, '')}/api/auth/google/callback`;
const stateCookie = (v, maxAge) => `${STATE_COOKIE}=${v}; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const go = (to, cookies = []) => {
  const r = new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
  for (const c of cookies) r.headers.append('Set-Cookie', c);
  return r;
};
// Back to the sign-in page with a reason the page can show (never anything from Google in the address).
const back = (why) => go(`/?google=${encodeURIComponent(why)}`, [stateCookie('', 0)]);

export async function googleStart(env, url) {
  if (!googleReady(env)) throw new ApiError('Google sign-in is not set up', '501', 501);
  const state = randomHex(16), verifier = randomHex(32);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(env, url.origin), response_type: 'code', scope: 'openid email',
    state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
  return go(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, [stateCookie(`${state}.${verifier}`, 600)]);
}

const cookieOf = (req) => (req.headers.get('Cookie') || '').split(/;\s*/).map((x) => x.split('=')).find(([k]) => k === STATE_COOKIE)?.[1] || '';
const sameText = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

/** The claims of an ID token received directly from Google, checked; null when any check fails. */
export function googleClaims(idToken, clientId, now = Date.now()) {
  try {
    const part = String(idToken).split('.')[1];
    const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0))));
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(clientId)) return null;
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(c.iss)) return null;
    if (!(+c.exp * 1000 > now)) return null;
    if (c.email_verified !== true && c.email_verified !== 'true') return null;
    const email = String(c.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;
    return { email, sub: String(c.sub || '') };
  } catch {
    return null;
  }
}

export async function googleCallback(env, req, url, { fetchImpl = fetch, ip = 'local', tooMany, note } = {}) {
  if (!googleReady(env)) throw new ApiError('Google sign-in is not set up', '501', 501);
  if (url.searchParams.get('error')) return back('cancelled');
  const [state, verifier] = cookieOf(req).split('.');
  const given = String(url.searchParams.get('state') || '');
  const code = String(url.searchParams.get('code') || '');
  if (!state || !verifier || !code || !sameText(given, state)) return back('expired');
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(env, url.origin), grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const out = await res.json().catch(() => ({}));
  const claims = res.ok ? googleClaims(out.id_token, env.GOOGLE_CLIENT_ID) : null;
  if (!claims) return back('failed');
  let u = await env.DB.prepare('SELECT id, email, totp_secret FROM users WHERE email = ?').bind(claims.email).first();
  if (u?.totp_secret) return back('mfa');
  if (!u) {
    // A new account, the same limit as signing up with a password.
    if (tooMany && await tooMany(env, `up:${ip}`, +(env.SIGNUP_PER_HOUR || 10), 60)) return back('busy');
    if (note) await note(env, `up:${ip}`);
    u = { id: uuid(), email: claims.email };
    // No password: 'google$…' is no password hash, so signing in with a password always fails until the owner
    // sets one with «نسيت كلمة السر».
    await env.DB.prepare('INSERT INTO users (id, email, pw_hash, created_at) VALUES (?, ?, ?, ?)').bind(u.id, u.email, `google$${await sha256(claims.sub)}`, nowIso()).run();
  }
  const s = await newSession(env, u);
  return go('/', [stateCookie('', 0), sessionCookie(s.access_token, s.expires_at)]);
}
