// Server keys with versions, so one can be replaced without losing what the old one protected.
// Each purpose has its own secret (never PIN_PEPPER, which only hashes PINs):
//   TOTP_KEY          encrypts the two-step sign-in secrets
//   AUDIT_SEAL_KEY    signs the fingerprints of the log of changes
// To rotate: put the new value in the main secret and move the old one into <NAME>_OLD (comma-separated
// when there are several). New data uses the main key; old data is still read with the old key (and the
// two-step secrets are re-encrypted with the new key the next time they are used). A key is named by a
// short id (a hash of the key), never by its value.
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function keyId(raw) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(`saydaliti-key-id:${raw}`))).slice(0, 12);
}
// The keys for a purpose, the current one first; [] when it is not set up. Called with the two settings
// read by name (env.TOTP_KEY, env.TOTP_KEY_OLD), so every env key the code reads stays visible to the
// staging allowlist check.
export async function keyring(current, old) {
  const cur = typeof current === 'string' ? current.trim() : '';
  if (cur.length < 32) return []; // like BACKUP_KEY: at least 32 characters
  const olds = String(old || '').split(',').map((x) => x.trim()).filter((k) => k.length >= 32);
  return Promise.all([...new Set([cur, ...olds])].map(async (raw) => ({ id: await keyId(raw), raw })));
}
