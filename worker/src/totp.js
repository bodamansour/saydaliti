// Two-step sign-in with an authenticator app (RFC 6238 TOTP: 6 digits, 30 seconds, HMAC-SHA1, the
// standard every authenticator app understands). Works the same in the Worker and in Node (Web Crypto).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes) {
  let bits = 0, v = 0, out = '';
  for (const b of bytes) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, v = 0; const out = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('bad base32');
    v = (v << 5) | i; bits += 5;
    if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export const newSecret = () => base32(crypto.getRandomValues(new Uint8Array(20)));

export async function totpAt(secret, step) {
  const key = await crypto.subtle.importKey('raw', unbase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, step >>> 0); // steps fit in 32 bits until the year 6000
  new DataView(msg).setUint32(0, Math.floor(step / 2 ** 32));
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

// The code is checked against the step now and one step either side (clocks drift). Returns the step
// that matched (so the same code can't be used twice), or null.
export async function checkTotp(secret, code, now = Date.now(), lastStep = -1) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step - 1, step, step + 1]) if (s > lastStep && (await totpAt(secret, s)) === c) return s;
  return null;
}

// What the authenticator app scans: otpauth://totp/Saydaliti:<email>?secret=…&issuer=Saydaliti
export const otpauthUrl = (secret, email) => `otpauth://totp/${encodeURIComponent(`Saydaliti:${email}`)}?secret=${secret}&issuer=Saydaliti&digits=6&period=30`;

// One-time recovery codes for a lost phone: 8 codes of 10 characters, shown once, kept hashed.
const RC = 'abcdefghjkmnpqrstuvwxyz23456789';
export const newRecoveryCodes = (n = 8) => Array.from({ length: n }, () => [...crypto.getRandomValues(new Uint8Array(10))].map((b) => RC[b % RC.length]).join('').replace(/(.{5})/, '$1-'));
export const normRecovery = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
