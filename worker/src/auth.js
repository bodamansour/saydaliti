// Accounts: email + password, and sign-in sessions. Passwords are stored as PBKDF2-SHA256 hashes
// (with a random salt per account); a session is a random token, of which only the hash is stored.
// Accounts moved from Supabase keep their bcrypt hash and are moved to PBKDF2 at their next sign-in.
import { ApiError, nowIso, uuid } from './db.js';

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
// hash with a server-side secret; the server limits wrong tries (pin_attempts).
export const hashPin = async (env, pharmacyId, pin) => sha256(`${env.PIN_PEPPER || 'saydaliti'}:${pharmacyId}:${pin}`);

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

export async function signIn(env, { email, password }, ip) {
  email = String(email || '').trim().toLowerCase();
  // Wrong tries are limited per email and per address, so passwords can't be guessed.
  if (await tooMany(env, `in:${email}`, 10, 15) || await tooMany(env, `ip:${ip}`, 30, 15)) throw new ApiError('Too many sign-in attempts. Request rate limit reached', 'over_request_rate_limit', 429);
  const u = await env.DB.prepare('SELECT id, email, pw_hash FROM users WHERE email = ?').bind(email).first();
  if (!u || !(await checkPassword(String(password || ''), u.pw_hash))) {
    await note(env, `in:${email}`); await note(env, `ip:${ip}`);
    throw new ApiError('Invalid login credentials', 'invalid_credentials', 400);
  }
  if (!u.pw_hash.startsWith(`pbkdf2$${iterOf(env)}$`)) await env.DB.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').bind(await hashPassword(password, env), u.id).run();
  return newSession(env, u);
}

export async function signOut(env, token) {
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

export async function changePassword(env, user, { password }) {
  if (String(password || '').length < 8) throw new ApiError('Password should be at least 8 characters. weak_password', 'weak_password');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').bind(await hashPassword(password, env), user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  return newSession(env, user);
}

// The signed-in user of a request (Authorization: Bearer <token>), or null.
export async function userOf(env, req) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  const s = await env.DB.prepare('SELECT s.user_id, s.expires_at, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(await sha256(m[1])).first();
  if (!s || s.expires_at < nowIso()) return null;
  return { id: s.user_id, email: s.email, token: m[1] };
}
