// A signed running fingerprint of a pharmacy's log of changes (migration 0016). Each seal covers the log up
// to a row id: hash = HMAC(key, previous hash + every row after the previous seal, in id order). The key comes
// from the server's PIN_PEPPER secret, so someone who can edit the database but doesn't hold the secret can't
// make the seals match an edited log. Checking walks the whole log from the start and compares every seal.
import { ApiError, nowIso } from './db.js';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function keyOf(env) {
  if (typeof env?.PIN_PEPPER !== 'string' || !env.PIN_PEPPER) throw new ApiError('server not configured: PIN secret missing', '503', 503);
  return crypto.subtle.importKey('raw', enc.encode(`${env.PIN_PEPPER}:audit-seal`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
// The row exactly as stored (text columns as they are), so the fingerprint doesn't depend on parsing.
const line = (r) => JSON.stringify([r.id, r.pharmacy_id, r.at, r.user_id ?? null, r.table_name, r.op, r.row_id ?? null, r.old_row ?? null, r.new_row ?? null]);
const PAGE = 1000;
async function* rowsAfter(env, pharmacyId, afterId, uptoId = Number.MAX_SAFE_INTEGER) {
  let last = afterId;
  for (;;) {
    const rs = (await env.DB.prepare('SELECT id, pharmacy_id, at, user_id, table_name, op, row_id, old_row, new_row FROM audit_log WHERE pharmacy_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?')
      .bind(pharmacyId, last, uptoId, PAGE).all()).results;
    for (const r of rs) yield r;
    if (rs.length < PAGE) return;
    last = rs.at(-1).id;
  }
}
async function chain(key, prev, rows) {
  let h = prev, n = 0;
  for await (const r of rows) { h = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${h}\n${line(r)}`))); n++; }
  return { hash: h, n };
}

// Adds a seal for the rows written since the last one (nothing when there are none).
export async function sealAudit(env, pharmacyId) {
  const key = await keyOf(env);
  const last = await env.DB.prepare('SELECT upto_id, rows, hash FROM audit_seals WHERE pharmacy_id = ? ORDER BY upto_id DESC LIMIT 1').bind(pharmacyId).first();
  const top = (await env.DB.prepare('SELECT max(id) AS m FROM audit_log WHERE pharmacy_id = ?').bind(pharmacyId).first())?.m ?? 0;
  if (!top || top <= (last?.upto_id ?? 0)) return { sealed: 0 };
  const { hash, n } = await chain(key, last?.hash ?? '', rowsAfter(env, pharmacyId, last?.upto_id ?? 0, top));
  await env.DB.prepare('INSERT INTO audit_seals (pharmacy_id, upto_id, rows, hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(pharmacyId, top, (last?.rows ?? 0) + n, hash, nowIso()).run();
  return { sealed: n };
}

// Walks the whole log and compares each seal. ok: false names the first seal that no longer matches
// (a row up to it was changed, removed or added afterwards).
export async function verifyAudit(env, pharmacyId) {
  const key = await keyOf(env);
  const seals = (await env.DB.prepare('SELECT upto_id, rows, hash, created_at FROM audit_seals WHERE pharmacy_id = ? ORDER BY upto_id').bind(pharmacyId).all()).results;
  let prevId = 0, prevHash = '', total = 0;
  for (const s of seals) {
    const { hash, n } = await chain(key, prevHash, rowsAfter(env, pharmacyId, prevId, s.upto_id));
    total += n;
    if (hash !== s.hash || total !== s.rows) return { ok: false, rows: total, seals: seals.length, broken_at: s.created_at, upto_id: s.upto_id };
    prevId = s.upto_id; prevHash = s.hash;
  }
  return { ok: true, rows: total, seals: seals.length, last_seal: seals.at(-1)?.created_at ?? null };
}
