// Accounts: email + password, and sign-in sessions. Passwords are stored as PBKDF2-SHA256 hashes
// (with a random salt per account); a session is a random token, of which only the hash is stored.
// Accounts moved from Supabase keep their bcrypt hash and are moved to PBKDF2 at their next sign-in.
import { ApiError, nowIso, uuid } from './db.js';
import { newSecret, checkTotp, otpauthUrl, newRecoveryCodes, normRecovery } from './totp.js';
import { guardedFetch } from './egress.js';

// 100,000 is the most Cloudflare Workers allow for PBKDF2 (needs the Workers Paid plan's CPU time;
// on the free plan set PBKDF2_ITER lower). Hashes keep their own count, and are redone at sign-in
// when the setting changes.
const iterOf = (env) => Math.max(10000, Math.min(100000, +(env?.PBKDF2_ITER || 100000)));
const SESSION_DAYS = 60;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
export const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
export const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
export async function hashPassword(password, env) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iter = iterOf(env);
  return `pbkdf2$${iter}$${hex(salt)}$${await pbkdf2(password, salt, iter)}`;
}
// Constant-time comparison of two hex strings.
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
export async function checkPassword(password, stored) {
  if (stored.startsWith('pbkdf2$')) {
    const [, iter, salt, h] = stored.split('$');
    return same(await pbkdf2(password, unhex(salt), +iter), h);
  }
  if (/^\$2[aby]\$/.test(stored)) { const { default: bcrypt } = await import('bcryptjs'); return bcrypt.compare(password, stored); }
  return false;
}

// A PIN (4–6 digits) is checked against every employee of the pharmacy, so it uses a fast salted
// hash with a server-side secret; the server limits wrong tries (pin_attempts). Without the secret a
// PIN hash could be reversed by trying all 1,111,000 PINs, so the server refuses PIN work instead of
// falling back to a known value (the release workflow also checks the secret exists before deploying).
export const hashPin = async (env, pharmacyId, pin) => {
  if (typeof env?.PIN_PEPPER !== 'string' || !env.PIN_PEPPER) throw new ApiError('server not configured: PIN secret missing', '503', 503);
  return sha256(`${env.PIN_PEPPER}:${pharmacyId}:${pin}`);
};

async function tooMany(env, k, max, minutes) {
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  const r = await env.DB.prepare('SELECT count(*) AS n FROM auth_attempts WHERE k = ? AND at > ?').bind(k, since).first();
  return (r?.n ?? 0) >= max;
}
const note = (env, k) => env.DB.batch([
  env.DB.prepare('INSERT INTO auth_attempts (k, at) VALUES (?, ?)').bind(k, nowIso()),
  env.DB.prepare('DELETE FROM auth_attempts WHERE at < ?').bind(new Date(Date.now() - 86400000).toISOString()),
]);

async function newSession(env, user) {
  const token = randomHex(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), user.id, nowIso(), expires).run();
  return { access_token: token, expires_at: expires, user: { id: user.id, email: user.email } };
}

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

export async function signUp(env, { email, password }, ip) {
  email = String(email || '').trim().toLowerCase();
  if (!validEmail(email)) throw new ApiError('Unable to validate email address: invalid format', 'validation_failed');
  if (String(password || '').length < 8) throw new ApiError('Password should be at least 8 characters. weak_password', 'weak_password');
  if (await tooMany(env, `up:${ip}`, +(env.SIGNUP_PER_HOUR || 10), 60)) throw new ApiError('Request rate limit reached', 'over_request_rate_limit', 429);
  await note(env, `up:${ip}`);
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) throw new ApiError('User already registered', 'user_already_exists', 422);
  const user = { id: uuid(), email };
  await env.DB.prepare('INSERT INTO users (id, email, pw_hash, created_at) VALUES (?, ?, ?, ?)').bind(user.id, email, await hashPassword(password, env), nowIso()).run();
  return newSession(env, user);
}

export async function signIn(env, { email, password, code }, ip) {
  email = String(email || '').trim().toLowerCase();
  // Wrong tries are limited per email and per address, so passwords can't be guessed.
  if (await tooMany(env, `in:${email}`, 10, 15) || await tooMany(env, `ip:${ip}`, 30, 15)) throw new ApiError('Too many sign-in attempts. Request rate limit reached', 'over_request_rate_limit', 429);
  const u = await env.DB.prepare('SELECT id, email, pw_hash, totp_secret, totp_recovery FROM users WHERE email = ?').bind(email).first();
  if (!u || !(await checkPassword(String(password || ''), u.pw_hash))) {
    await note(env, `in:${email}`); await note(env, `ip:${ip}`);
    throw new ApiError('Invalid login credentials', 'invalid_credentials', 400);
  }
  // Two-step sign-in: the password was right; now the code from the authenticator app (or a recovery code).
  if (u.totp_secret) {
    if (!String(code ?? '').trim()) throw new ApiError('Two-step code required', 'mfa_required', 401);
    if (!(await secondStep(env, u, code))) {
      await note(env, `in:${email}`); await note(env, `ip:${ip}`);
      throw new ApiError('Wrong two-step code', 'mfa_invalid', 400);
    }
  }
  if (!u.pw_hash.startsWith(`pbkdf2$${iterOf(env)}$`)) await env.DB.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').bind(await hashPassword(password, env), u.id).run();
  return newSession(env, u);
}

export async function signOut(env, token) {
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

// The current password is asked again, so a stolen or forgotten-open session can't lock the owner out.
// Wrong tries count against the same limit as sign-in.
export async function changePassword(env, user, { password, current_password }, ip = 'local') {
  if (String(password || '').length < 8) throw new ApiError('Password should be at least 8 characters. weak_password', 'weak_password');
  if (await tooMany(env, `in:${user.email}`, 10, 15) || await tooMany(env, `ip:${ip}`, 30, 15)) throw new ApiError('Too many attempts. Request rate limit reached', 'over_request_rate_limit', 429);
  const u = await env.DB.prepare('SELECT pw_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!u || !(await checkPassword(String(current_password || ''), u.pw_hash))) {
    await note(env, `in:${user.email}`); await note(env, `ip:${ip}`);
    throw new ApiError('Current password is wrong', 'invalid_credentials', 400);
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').bind(await hashPassword(password, env), user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  return newSession(env, user);
}

// ---------- Two-step sign-in (authenticator app) ----------
// The secret is kept encrypted (AES-GCM, key from the server's PIN_PEPPER secret), so a copy of the
// database alone can't make codes. A code is accepted once (its 30-second step is remembered).
async function totpKey(env) {
  if (typeof env?.PIN_PEPPER !== 'string' || !env.PIN_PEPPER) throw new ApiError('server not configured: PIN secret missing', '503', 503);
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode(`${env.PIN_PEPPER}:totp`)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return `v1:${hex(iv)}:${hex(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await totpKey(env), enc.encode(text)))}`;
}
async function unseal(env, sealed) {
  const [v, iv, ct] = String(sealed).split(':');
  if (v !== 'v1') throw new ApiError('bad two-step secret');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(iv) }, await totpKey(env), unhex(ct)));
}
// A code from the app, or one of the recovery codes (each works once).
async function secondStep(env, u, code) {
  const step = await checkTotp(await unseal(env, u.totp_secret), code);
  if (step !== null) {
    const k = `totp:${u.id}:${step}`;
    if (await env.DB.prepare('SELECT 1 FROM auth_attempts WHERE k = ?').bind(k).first()) return false; // used already
    await note(env, k);
    return true;
  }
  const list = JSON.parse(u.totp_recovery || '[]');
  const h = await sha256(`rc:${u.id}:${normRecovery(code)}`);
  if (!normRecovery(code) || !list.includes(h)) return false;
  await env.DB.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?').bind(JSON.stringify(list.filter((x) => x !== h)), u.id).run();
  return true;
}
async function passwordAgain(env, user, current_password, ip) {
  if (await tooMany(env, `in:${user.email}`, 10, 15) || await tooMany(env, `ip:${ip}`, 30, 15)) throw new ApiError('Too many attempts. Request rate limit reached', 'over_request_rate_limit', 429);
  const u = await env.DB.prepare('SELECT id, email, pw_hash, totp_secret, totp_pending, totp_recovery FROM users WHERE id = ?').bind(user.id).first();
  if (!u || !(await checkPassword(String(current_password || ''), u.pw_hash))) {
    await note(env, `in:${user.email}`); await note(env, `ip:${ip}`);
    throw new ApiError('Current password is wrong', 'invalid_credentials', 400);
  }
  return u;
}
// Step 1: a new secret, kept aside until a code from the app proves it was scanned.
export async function mfaSetup(env, user, { current_password }, ip = 'local') {
  const u = await passwordAgain(env, user, current_password, ip);
  if (u.totp_secret) throw new ApiError('Two-step sign-in is already on', 'mfa_on', 409);
  const secret = newSecret();
  await env.DB.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').bind(await seal(env, secret), u.id).run();
  return { secret, url: otpauthUrl(secret, u.email) };
}
// Step 2: the first code from the app turns it on, and the recovery codes are shown once.
export async function mfaEnable(env, user, { code }, ip = 'local') {
  if (await tooMany(env, `in:${user.email}`, 10, 15)) throw new ApiError('Too many attempts. Request rate limit reached', 'over_request_rate_limit', 429);
  const u = await env.DB.prepare('SELECT id, totp_secret, totp_pending FROM users WHERE id = ?').bind(user.id).first();
  if (u?.totp_secret) throw new ApiError('Two-step sign-in is already on', 'mfa_on', 409);
  if (!u?.totp_pending) throw new ApiError('Start two-step sign-in again', 'mfa_not_started', 400);
  const secret = await unseal(env, u.totp_pending);
  const step = await checkTotp(secret, code);
  if (step === null) { await note(env, `in:${user.email}`); throw new ApiError('Wrong two-step code', 'mfa_invalid', 400); }
  await note(env, `totp:${u.id}:${step}`);
  const codes = newRecoveryCodes();
  const hashes = await Promise.all(codes.map((c) => sha256(`rc:${u.id}:${normRecovery(c)}`)));
  await env.DB.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_recovery = ? WHERE id = ?').bind(JSON.stringify(hashes), u.id).run();
  return { on: true, recovery: codes };
}
// Off: the password and a current code (or a recovery code).
export async function mfaDisable(env, user, { current_password, code }, ip = 'local') {
  const u = await passwordAgain(env, user, current_password, ip);
  if (!u.totp_secret) return { on: false };
  if (!(await secondStep(env, u, code))) { await note(env, `in:${user.email}`); throw new ApiError('Wrong two-step code', 'mfa_invalid', 400); }
  await env.DB.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_recovery = NULL WHERE id = ?').bind(u.id).run();
  return { on: false };
}

// ---------- Forgotten password ----------
// Sends a one-time link (30 minutes). The answer is the same whether the email has an account or not,
// so nobody can find out who has one. Email goes through Resend (RESEND_API_KEY + EMAIL_FROM); on a
// development machine EMAIL_OUTBOX=dev writes it to the email_outbox table instead.
const RESET_MINUTES = 30;
export const emailReady = (env) => env?.EMAIL_OUTBOX === 'dev' || !!(env?.RESEND_API_KEY && env?.EMAIL_FROM);
export async function sendEmail(env, to, subject, text) {
  if (env?.EMAIL_OUTBOX === 'dev') {
    await env.DB.prepare('INSERT INTO email_outbox (to_email, subject, body, created_at) VALUES (?, ?, ?, ?)').bind(to, subject, text, nowIso()).run();
    return;
  }
  if (!emailReady(env)) throw new ApiError('Email is not set up on the server', 'email_not_configured', 503);
  const r = await guardedFetch(env)('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
  });
  if (!r.ok) throw new ApiError('The email could not be sent. Try again later.', 'email_failed', 502);
}
export async function forgotPassword(env, { email }, ip, origin) {
  if (!emailReady(env)) throw new ApiError('Email is not set up on the server', 'email_not_configured', 503);
  email = String(email || '').trim().toLowerCase();
  if (!validEmail(email)) throw new ApiError('Unable to validate email address: invalid format', 'validation_failed');
  if (await tooMany(env, `fp:${email}`, 3, 60) || await tooMany(env, `fpip:${ip}`, 10, 60)) throw new ApiError('Request rate limit reached', 'over_request_rate_limit', 429);
  await note(env, `fp:${email}`); await note(env, `fpip:${ip}`);
  const u = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first();
  if (!u) return { sent: true };
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), u.id, new Date(now).toISOString(), new Date(now + RESET_MINUTES * 60000).toISOString()).run();
  const site = String(env.SITE_URL || origin || '').replace(/\/$/, '');
  await sendEmail(env, u.email, 'صيدليتي: تغيير كلمة السر',
    `حد طلب تغيير كلمة السر لحسابك في صيدليتي.\nلو إنت، افتح اللينك ده خلال ${RESET_MINUTES} دقيقة:\n${site}/#reset=${token}\n\nلو مش إنت، تجاهل الرسالة دي وكلمة السر مش هتتغير.`);
  return { sent: true };
}
export async function resetPassword(env, { token, password }, ip) {
  if (String(password || '').length < 8) throw new ApiError('Password should be at least 8 characters. weak_password', 'weak_password');
  if (await tooMany(env, `rs:${ip}`, 20, 60)) throw new ApiError('Request rate limit reached', 'over_request_rate_limit', 429);
  const t = /^[0-9a-f]{64}$/i.test(String(token || '')) ? String(token).toLowerCase() : null;
  const r = t && await env.DB.prepare('SELECT r.user_id, r.expires_at, r.used_at, u.email FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?').bind(await sha256(t)).first();
  if (!r || r.used_at || r.expires_at < nowIso()) { await note(env, `rs:${ip}`); throw new ApiError('This link is not valid any more. Ask for a new one.', 'reset_invalid', 400); }
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').bind(await hashPassword(password, env), r.user_id),
    env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(nowIso(), r.user_id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(r.user_id),
  ]);
  // Two-step sign-in stays on: the link proves the email, not the phone.
  const u = await env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(r.user_id).first();
  if (u?.totp_secret) return { reset: true, mfa: true };
  return newSession(env, { id: r.user_id, email: r.email });
}
export const mfaOf = async (env, userId) => !!(await env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(userId).first())?.totp_secret;

// ---------- Where the sign-in lives ----------
// In the browser the session token is an HttpOnly cookie: page scripts (and so an injected script) can't
// read it. Scripts and tests that ask for it (X-Want-Token: 1) still get it in the answer, and send it as
// Authorization: Bearer. A request signed in by the cookie must also carry X-Saydaliti: 1 to change
// anything: another site can't add that header (it would need CORS, which this server never allows), so a
// page elsewhere can't act with the pharmacy's sign-in (CSRF). SameSite=Strict blocks the same.
export const COOKIE = 'sd_session';
export const sessionCookie = (token, expiresAt) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))}`;
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
const cookieToken = (req) => {
  for (const part of String(req.headers.get('Cookie') || '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE && /^[0-9a-f]{64}$/i.test(v || '')) return v;
  }
  return null;
};
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// The signed-in user of a request (the session cookie, or Authorization: Bearer <token>), or null.
export async function userOf(env, req) {
  const bearer = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.get('Authorization') || '')?.[1];
  const token = bearer || cookieToken(req);
  if (!token) return null;
  if (!bearer && !SAFE.has(req.method) && req.headers.get('X-Saydaliti') !== '1') throw new ApiError('request refused', 'csrf', 403);
  const s = await env.DB.prepare('SELECT s.user_id, s.expires_at, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(await sha256(token)).first();
  if (!s || s.expires_at < nowIso()) return null;
  return { id: s.user_id, email: s.email, token, expires_at: s.expires_at, via: bearer ? 'bearer' : 'cookie' };
}
