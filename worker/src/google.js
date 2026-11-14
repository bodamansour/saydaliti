// Verify Google's ID token before it can identify an account. Email alone never links accounts.
import { ApiError } from './db.js';
import { guardedFetch } from './egress.js';

const CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
let cached = { keys: [], until: 0 };
const invalid = () => new ApiError('Google sign-in failed', 'google_invalid', 401);
const bytes = (part) => {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw invalid();
  return Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4)), (c) => c.charCodeAt(0));
};

export async function verifyGoogleToken(env, credential, fetchImpl) {
  if (!env?.GOOGLE_CLIENT_ID) throw new ApiError('Google sign-in is not configured', 'google_not_configured', 503);
  if (typeof credential !== 'string' || credential.length > 12000) throw invalid();
  const parts = credential.split('.');
  if (parts.length !== 3) throw invalid();
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(bytes(parts[1])));
  } catch { throw invalid(); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) throw invalid();
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== env.GOOGLE_CLIENT_ID || (claims.azp && claims.azp !== env.GOOGLE_CLIENT_ID)
    || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)
    || !Number.isInteger(claims.exp) || claims.exp <= now || !Number.isInteger(claims.iat) || claims.iat > now + 60
    || (claims.nbf != null && (!Number.isInteger(claims.nbf) || claims.nbf > now + 60))
    || claims.email_verified !== true || typeof claims.email !== 'string'
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) || claims.email.length > 254
    || typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) throw invalid();
  if (Date.now() >= cached.until || !cached.keys.some((k) => k.kid === header.kid)) {
    let response;
    try { response = await guardedFetch(env, fetchImpl)(CERTS); }
    catch { throw new ApiError('Google sign-in is temporarily unavailable', 'google_unavailable', 503); }
    if (!response.ok) throw new ApiError('Google sign-in is temporarily unavailable', 'google_unavailable', 503);
    const raw = await response.text();
    if (raw.length > 65536) throw invalid();
    let document;
    try { document = JSON.parse(raw); } catch { throw invalid(); }
    if (!Array.isArray(document.keys)) throw invalid();
    const age = /max-age=(\d+)/i.exec(response.headers.get('Cache-Control') || '')?.[1];
    cached = { keys: document.keys, until: Date.now() + Math.min(3600, Math.max(60, +(age || 300))) * 1000 };
  }
  const jwk = cached.keys.find((k) => k.kid === header.kid && k.kty === 'RSA' && k.alg === 'RS256' && k.use === 'sig');
  if (!jwk) throw invalid();
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw invalid();
  } catch { throw invalid(); }
  return { sub: claims.sub, email: claims.email.toLowerCase() };
}
