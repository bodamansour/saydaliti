// Each seal HMACs the log up to a row id. R2 keeps both the current anchor and immutable recovery copies.
// A rebaseline starts a new epoch; old seals and any previous R2 evidence remain untouched.
import { ApiError, nowIso } from './db.js';
import { keyring } from './keys.js';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));
const digest = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const hmacKey = (raw) => crypto.subtle.importKey('raw', enc.encode(`${raw}:audit-seal`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const cursorKey = (raw) => crypto.subtle.importKey('raw', enc.encode(`${raw}:audit-verify-cursor`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
export const sealReady = async (env) => (await keyring(env?.AUDIT_SEAL_KEY, env?.AUDIT_SEAL_KEY_OLD)).length > 0;
const line = (r) => JSON.stringify([r.id, r.pharmacy_id, r.at, r.user_id ?? null, r.table_name, r.op, r.row_id ?? null, r.old_row ?? null, r.new_row ?? null]);
const PAGE = 500;
const ANCHOR_MAX_BYTES = 8192;
const REBASE_CONFIRM = 'REBASELINE_AUDIT_ANCHOR';

async function* rowsAfter(env, pharmacyId, afterId, uptoId = Number.MAX_SAFE_INTEGER, limit = Infinity) {
  let last = afterId, n = 0;
  while (n < limit) {
    const rs = (await env.DB.prepare('SELECT id, pharmacy_id, at, user_id, table_name, op, row_id, old_row, new_row FROM audit_log WHERE pharmacy_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?')
      .bind(pharmacyId, last, uptoId, Math.min(PAGE, limit - n)).all()).results;
    for (const r of rs) { n++; yield r; }
    if (rs.length < PAGE) return;
    last = rs.at(-1).id;
  }
}
async function chain(key, prev, rows) {
  let h = prev, n = 0, lastId = null;
  for await (const r of rows) { h = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${h}\n${line(r)}`))); n++; lastId = r.id; }
  return { hash: h, n, lastId };
}

const pathPart = (s) => encodeURIComponent(String(s));
const anchorKey = (p) => `audit-anchor/${pathPart(p)}.json`;
const historyKey = (p, s) => `audit-anchor-history/${pathPart(p)}/${s.epoch}-${s.upto_id}-${s.hash}.json`;
const evidenceKey = async (p, raw) => `audit-anchor-evidence/${pathPart(p)}/${Date.now()}-${await digest(raw)}.json`;
const normalizeSeal = (s) => s && ({ epoch: Number(s.epoch ?? 0), upto_id: Number(s.upto_id), rows: Number(s.rows), hash: String(s.hash), key_id: String(s.key_id), created_at: String(s.created_at) });
const validSeal = (s) => !!s && Number.isInteger(s.epoch) && s.epoch >= 0 && Number.isInteger(s.upto_id) && s.upto_id > 0 && Number.isInteger(s.rows) && s.rows > 0 && /^[0-9a-f]{64}$/i.test(s.hash) && !!s.key_id && !Number.isNaN(Date.parse(s.created_at));
const sameSeal = (a, b) => {
  const x = normalizeSeal(a), y = normalizeSeal(b);
  return validSeal(x) && validSeal(y) && ['epoch', 'upto_id', 'rows', 'hash', 'key_id'].every((k) => x[k] === y[k]);
};

async function readObject(env, key) {
  if (!env.FILES) return { status: 'unavailable' };
  try {
    const o = await env.FILES.get(key);
    if (!o) return { status: 'missing' };
    if (o.size > ANCHOR_MAX_BYTES) return { status: 'oversized', etag: o.etag ?? null };
    if (typeof o.text !== 'function') return { status: 'unreadable', etag: o.etag ?? null };
    return { status: 'present', raw: await o.text(), etag: o.etag ?? null };
  } catch { return { status: 'unavailable' }; }
}
async function readAnchor(env, p) {
  const o = await readObject(env, anchorKey(p));
  if (o.status !== 'present') return o;
  try {
    const value = JSON.parse(o.raw), allowed = new Set(['epoch', 'upto_id', 'rows', 'hash', 'key_id', 'created_at']);
    if (!value || Object.keys(value).some((k) => !allowed.has(k)) || !validSeal(normalizeSeal(value))) return { ...o, status: 'malformed' };
    return { ...o, value: normalizeSeal(value) };
  } catch { return { ...o, status: 'malformed' }; }
}
async function readHistory(env, p, seal) {
  const o = await readObject(env, historyKey(p, seal));
  if (o.status !== 'present') return o;
  try {
    const value = JSON.parse(o.raw);
    return validSeal(normalizeSeal(value)) ? { ...o, value: normalizeSeal(value) } : { ...o, status: 'malformed' };
  } catch { return { ...o, status: 'malformed' }; }
}
async function historyInventory(env, p) {
  const prefix = `audit-anchor-history/${pathPart(p)}/`;
  const scan = async () => {
    const entries = [], seen = new Set(); let cursor;
    do {
      const page = await env.FILES.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      if (!page || !Array.isArray(page.objects) || typeof page.truncated !== 'boolean') throw new Error('invalid history listing');
      for (const object of page.objects) {
        const key = object?.key;
        const m = typeof key === 'string' && key.startsWith(prefix) && key.slice(prefix.length).match(/^(\d+)-(\d+)-([0-9a-f]{64})\.json$/);
        if (!m || !Number.isSafeInteger(+m[1]) || !Number.isSafeInteger(+m[2])) throw new Error('invalid history key');
        entries.push({ key, epoch: +m[1], upto: +m[2], hash: m[3] });
      }
      if (page.truncated && (!page.cursor || seen.has(page.cursor))) throw new Error('invalid history cursor');
      if (page.truncated) seen.add(page.cursor);
      cursor = page.truncated ? page.cursor : null;
    } while (cursor);
    return entries.sort((a, b) => a.key.localeCompare(b.key));
  };
  try {
    const first = await scan(), second = await scan();
    if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('history changed during listing');
    return second;
  } catch { throw new ApiError('audit anchor history is unavailable', 'audit_anchor_unavailable', 503); }
}
function requireCurrentHistory(entries, seal) {
  if (!seal && entries.length) throw new ApiError('audit anchor history exists without D1 seals', 'audit_anchor_evidence_conflict', 503);
  if (seal && entries.some((e) => e.epoch > seal.epoch || (e.epoch === seal.epoch && (e.upto > seal.upto_id || (e.upto === seal.upto_id && e.hash !== seal.hash))))) {
    throw new ApiError('audit anchor history conflicts with D1', 'audit_anchor_evidence_conflict', 503);
  }
}
const parentSeal = (env, p, s) => env.DB.prepare('SELECT epoch, upto_id, rows, hash, key_id, created_at FROM audit_seals WHERE pharmacy_id = ? AND epoch = ? AND upto_id < ? ORDER BY upto_id DESC LIMIT 1').bind(p, s.epoch, s.upto_id).first();
const latestSeal = (env, p) => env.DB.prepare('SELECT epoch, upto_id, rows, hash, key_id, created_at FROM audit_seals WHERE pharmacy_id = ? ORDER BY epoch DESC, upto_id DESC LIMIT 1').bind(p).first();
const logCountAfter = async (env, p, id) => (await env.DB.prepare('SELECT count(*) AS n FROM audit_log WHERE pharmacy_id = ? AND id > ?').bind(p, id).first())?.n ?? 0;

async function putImmutable(env, key, raw) {
  const before = await readObject(env, key);
  if (before.status === 'present') {
    if (before.raw === raw) return;
    try { if (sameSeal(JSON.parse(before.raw), JSON.parse(raw))) return; } catch { /* preserve and fail below */ }
    throw new ApiError('trusted audit anchor copy conflicts with existing evidence', 'audit_anchor_evidence_conflict', 503);
  }
  if (before.status !== 'missing') throw new ApiError('trusted audit anchor copy is unavailable', 'audit_anchor_unavailable', 503);
  try {
    const put = await env.FILES.put(key, raw, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    if (put) return;
  } catch { /* a racing or locked write may already have stored the same immutable object */ }
  const after = await readObject(env, key);
  try { if (after.status === 'present' && sameSeal(JSON.parse(after.raw), JSON.parse(raw))) return; } catch { /* fail closed */ }
  throw new ApiError('trusted audit anchor copy could not be written', 'audit_anchor_unavailable', 503);
}
async function preserveAnchor(env, p, state) {
  if (!['present', 'malformed'].includes(state.status)) return;
  if (typeof state.raw !== 'string') throw new ApiError('existing audit anchor cannot be preserved', 'audit_anchor_unavailable', 503);
  await putImmutable(env, await evidenceKey(p, state.raw), state.raw);
}
async function writeAnchor(env, p, seal, state) {
  let onlyIf;
  if (state.status === 'missing') onlyIf = { etagDoesNotMatch: '*' };
  else if (['present', 'malformed'].includes(state.status) && state.etag) onlyIf = { etagMatches: state.etag };
  else throw new ApiError('audit anchor cannot be safely replaced', 'audit_anchor_unavailable', 503);
  const put = await env.FILES.put(anchorKey(p), JSON.stringify(seal), { onlyIf, httpMetadata: { contentType: 'application/json' } });
  if (!put) {
    const after = await readAnchor(env, p);
    if (after.status === 'present' && sameSeal(after.value, seal)) return;
    throw new ApiError('audit anchor changed while it was being written', 'audit_anchor_mismatch', 503);
  }
  const after = await readAnchor(env, p);
  if (after.status !== 'present' || !sameSeal(after.value, seal)) throw new ApiError('audit anchor write could not be verified', 'audit_anchor_unavailable', 503);
}
async function ensureHistory(env, p, seal) {
  const prior = await readHistory(env, p, seal);
  if (prior.status === 'missing') return putImmutable(env, historyKey(p, seal), JSON.stringify(seal));
  if (prior.status === 'present' && sameSeal(prior.value, seal)) return;
  throw new ApiError('trusted audit anchor copy does not match the database', 'audit_anchor_evidence_conflict', 503);
}
async function logAnchorAction(env, p, userId, op, detail) {
  const rowId = String(detail.previous_upto_id ?? detail.upto_id ?? 0), newRow = JSON.stringify(detail);
  if (await env.DB.prepare("SELECT 1 FROM audit_log WHERE pharmacy_id = ? AND table_name = 'audit_anchor' AND op = ? AND row_id = ? AND new_row = ? LIMIT 1").bind(p, op, rowId, newRow).first()) return;
  await env.DB.prepare('INSERT INTO audit_log (pharmacy_id, at, user_id, table_name, op, row_id, old_row, new_row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(p, nowIso(), userId ?? null, 'audit_anchor', op, rowId, null, newRow).run();
}

// How many rows one run may seal. The configured budget is intentionally unchanged until Cloudflare measurements exist.
export const sealBudget = (env) => Math.max(10, Math.min(50000, Math.trunc(+env?.SEAL_BUDGET) || 150));
const verifyMax = (env) => Math.max(100, Math.min(500000, Math.trunc(+env?.VERIFY_MAX_ROWS) || 200));

async function signCursor(ring, state) {
  const body = hex(enc.encode(JSON.stringify(state))), k = ring[0];
  return `${k.id}.${body}.${hex(await crypto.subtle.sign('HMAC', await cursorKey(k.raw), enc.encode(body)))}`;
}
async function readCursor(ring, token, pharmacyId, userId, kind) {
  const invalid = () => new ApiError('audit verification cursor is invalid or expired', 'audit_cursor_invalid', 400);
  if (typeof token !== 'string' || token.length > 8192 || !/^[0-9a-f]{12}\.[0-9a-f]+\.[0-9a-f]{64}$/.test(token)) throw invalid();
  const [id, body, sig] = token.split('.'), k = ring.find((x) => x.id === id);
  if (!k || body.length % 2 || !(await crypto.subtle.verify('HMAC', await cursorKey(k.raw), unhex(sig), enc.encode(body)))) throw invalid();
  let state;
  try { state = JSON.parse(new TextDecoder().decode(unhex(body))); } catch { throw invalid(); }
  if (state.v !== 1 || state.kind !== kind || state.pharmacy !== pharmacyId || state.user !== (userId ?? null) || !Number.isSafeInteger(state.expires) || state.expires < Date.now() || !validSeal(state.latest)) throw invalid();
  return state;
}
const anchorVersion = (a) => `${a.status}:${a.etag ?? ''}`;
const verificationChanged = () => ({ ok: null, reason: 'changed_during_verification' });

// A cursor authenticates intermediate hashes; D1 does not offer a pinned snapshot across requests.
async function verifyAuditPage(env, pharmacyId, latest, ring, { cursor, userId }) {
  let state = cursor ? await readCursor(ring, cursor, pharmacyId, userId, 'progress') : null;
  if (state && !sameSeal(state.latest, latest)) return verificationChanged();
  try { requireCurrentHistory(await historyInventory(env, pharmacyId), latest); }
  catch (e) { return { ok: e.code === 'audit_anchor_evidence_conflict' ? false : null, reason: e.code === 'audit_anchor_evidence_conflict' ? 'anchor_mismatch' : 'anchor_unavailable' }; }
  const anchor = await readAnchor(env, pharmacyId);
  if (['unavailable', 'unreadable', 'oversized'].includes(anchor.status)) return { ok: null, reason: 'anchor_unavailable' };
  if (state && state.anchor !== anchorVersion(anchor)) return verificationChanged();
  if (!state) state = { v: 1, kind: 'progress', pharmacy: pharmacyId, user: userId ?? null, expires: Date.now() + 86400000, started: nowIso(), latest: normalizeSeal(latest), anchor: anchorVersion(anchor), rowId: 0, boundary: 0, rows: 0, hash: '' };
  const limit = verifyMax(env), epoch = state.latest.epoch;
  const seals = (await env.DB.prepare('SELECT upto_id, rows, hash, key_id, created_at, epoch FROM audit_seals WHERE pharmacy_id = ? AND epoch = ? AND upto_id > ? AND upto_id <= ? ORDER BY upto_id LIMIT ?')
    .bind(pharmacyId, epoch, state.boundary, state.latest.upto_id, limit + 1).all()).results;
  const rows = (await env.DB.prepare('SELECT id, pharmacy_id, at, user_id, table_name, op, row_id, old_row, new_row FROM audit_log WHERE pharmacy_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?')
    .bind(pharmacyId, state.rowId, state.latest.upto_id, limit).all()).results;
  const keys = new Map(await Promise.all(ring.map(async (k) => [k.id, await hmacKey(k.raw)])));
  let i = 0;
  for (const row of rows) {
    const s = seals[i];
    if (!s || !validSeal(normalizeSeal(s)) || s.epoch !== epoch || s.upto_id <= state.boundary || s.upto_id < row.id) return { ok: false, reason: 'changed', rows: state.rows, epoch };
    const key = keys.get(s.key_id);
    if (!key) return { ok: false, reason: 'key_missing', rows: state.rows, broken_at: s.created_at, epoch };
    state.hash = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${state.hash}\n${line(row)}`)));
    state.rowId = row.id; state.rows++;
    if (row.id === s.upto_id) {
      if (state.hash !== s.hash || state.rows !== s.rows) return { ok: false, reason: 'changed', rows: state.rows, broken_at: s.created_at, upto_id: s.upto_id, epoch };
      state.boundary = s.upto_id; i++;
    }
  }
  if (!rows.length || (rows.length < limit && state.rowId !== state.latest.upto_id)) return { ok: false, reason: 'changed', rows: state.rows, epoch };
  if (seals[i] && seals[i].upto_id <= state.rowId) return { ok: false, reason: 'changed', rows: state.rows, epoch };
  if (state.rowId !== state.latest.upto_id) return { ok: null, reason: 'in_progress', rows: state.rows, total_rows: state.latest.rows, cursor: await signCursor(ring, state) };
  if (state.boundary !== state.latest.upto_id || state.rows !== state.latest.rows || state.hash !== state.latest.hash || (seals[i] && seals[i].upto_id <= state.rowId)) return { ok: false, reason: 'changed', rows: state.rows, epoch };
  const endLatest = await latestSeal(env, pharmacyId), endAnchor = await readAnchor(env, pharmacyId);
  if (!sameSeal(endLatest, state.latest) || anchorVersion(endAnchor) !== state.anchor) return verificationChanged();
  try { requireCurrentHistory(await historyInventory(env, pharmacyId), endLatest); }
  catch (e) { return { ok: e.code === 'audit_anchor_evidence_conflict' ? false : null, reason: e.code === 'audit_anchor_evidence_conflict' ? 'anchor_mismatch' : 'anchor_unavailable' }; }
  const unsealed = await logCountAfter(env, pharmacyId, state.latest.upto_id), result = { epoch, rows: state.rows, upto_id: state.rowId, unsealed, started: state.started, finished: nowIso() };
  if (endAnchor.status !== 'present' || !sameSeal(endAnchor.value, state.latest)) {
    state.kind = 'proof';
    const reason = endAnchor.status === 'missing' ? 'anchor_missing' : endAnchor.status === 'malformed' ? 'anchor_unreadable' : 'anchor_mismatch';
    return { ...result, ok: reason === 'anchor_mismatch' ? false : null, reason, proof: await signCursor(ring, state) };
  }
  if (unsealed) return { ...result, ok: null, reason: 'unsealed' };
  return { ...result, ok: true };
}

async function verifyEpoch(env, pharmacyId) {
  const ring = await keyring(env?.AUDIT_SEAL_KEY, env?.AUDIT_SEAL_KEY_OLD);
  if (!ring.length) return { ok: null, configured: false };
  const epoch = (await env.DB.prepare('SELECT max(epoch) AS epoch FROM audit_seals WHERE pharmacy_id = ?').bind(pharmacyId).first())?.epoch ?? 0;
  const seals = (await env.DB.prepare('SELECT upto_id, rows, hash, key_id, created_at, epoch FROM audit_seals WHERE pharmacy_id = ? AND epoch = ? ORDER BY upto_id').bind(pharmacyId, epoch).all()).results;
  if ((seals.at(-1)?.rows ?? 0) > verifyMax(env)) return { ok: null, reason: 'too_big', rows: seals.at(-1).rows, limit: verifyMax(env), epoch };
  const keys = new Map(await Promise.all(ring.map(async (k) => [k.id, await hmacKey(k.raw)])));
  let prevId = 0, prevHash = '', total = 0;
  for (const s of seals) {
    if (!validSeal(normalizeSeal(s)) || s.epoch !== epoch || s.upto_id <= prevId) return { ok: false, reason: 'malformed_seal', rows: total, seals: seals.length, broken_at: s.created_at, epoch };
    const key = keys.get(s.key_id);
    if (!key) return { ok: false, reason: 'key_missing', rows: total, seals: seals.length, broken_at: s.created_at, epoch };
    const { hash, n } = await chain(key, prevHash, rowsAfter(env, pharmacyId, prevId, s.upto_id));
    total += n;
    if (hash !== s.hash || total !== s.rows) return { ok: false, reason: 'changed', rows: total, seals: seals.length, broken_at: s.created_at, upto_id: s.upto_id, epoch };
    prevId = s.upto_id; prevHash = s.hash;
  }
  const unsealed = await logCountAfter(env, pharmacyId, prevId);
  return { ok: true, epoch, rows: total, seals: seals.length, last_seal: seals.at(-1)?.created_at ?? null, upto_id: seals.at(-1)?.upto_id ?? 0, unsealed };
}

export async function verifyAudit(env, pharmacyId, { cursor = null, userId = null } = {}) {
  const ring = await keyring(env?.AUDIT_SEAL_KEY, env?.AUDIT_SEAL_KEY_OLD);
  if (!ring.length) return { ok: null, configured: false };
  const tip = await latestSeal(env, pharmacyId);
  if (cursor && !tip) return verificationChanged();
  if (cursor || (tip && tip.rows > verifyMax(env))) return verifyAuditPage(env, pharmacyId, tip, ring, { cursor, userId });
  const check = await verifyEpoch(env, pharmacyId);
  if (check.ok !== true) return check;
  const latest = await latestSeal(env, pharmacyId);
  try { requireCurrentHistory(await historyInventory(env, pharmacyId), latest); }
  catch (e) { return { ...check, ok: e.code === 'audit_anchor_evidence_conflict' ? false : null, reason: e.code === 'audit_anchor_evidence_conflict' ? 'anchor_mismatch' : 'anchor_unavailable' }; }
  const anchor = await readAnchor(env, pharmacyId);
  if (anchor.status === 'unavailable' || anchor.status === 'unreadable' || anchor.status === 'oversized') return { ...check, ok: null, reason: 'anchor_unavailable' };
  if (anchor.status === 'malformed') return { ...check, ok: null, reason: 'anchor_unreadable' };
  if (anchor.status === 'missing') {
    if (check.seals) return { ...check, ok: null, reason: 'anchor_missing' };
    if (check.unsealed) return { ...check, ok: null, reason: 'unsealed' };
    return check;
  }
  if (!latest || !sameSeal(anchor.value, latest)) return { ...check, ok: false, reason: 'anchor_mismatch' };
  if (check.unsealed) return { ...check, ok: null, reason: 'unsealed' };
  return check;
}

async function restoreTrusted(env, pharmacyId, seal, state, userId = null) {
  if (!seal) return false;
  const backup = await readHistory(env, pharmacyId, seal);
  if (backup.status === 'missing') return false;
  if (backup.status !== 'present' || !sameSeal(backup.value, seal)) throw new ApiError('trusted audit anchor copy is invalid', 'audit_anchor_evidence_conflict', 503);
  requireCurrentHistory(await historyInventory(env, pharmacyId), seal);
  if (state.status === 'present' && sameSeal(state.value, seal)) return false;
  if (['unavailable', 'unreadable', 'oversized'].includes(state.status)) throw new ApiError('current audit anchor cannot be read or preserved', 'audit_anchor_unavailable', 503);
  await preserveAnchor(env, pharmacyId, state);
  await logAnchorAction(env, pharmacyId, userId, 'restore', { epoch: seal.epoch, upto_id: seal.upto_id, hash: seal.hash, source: 'trusted_backup' });
  if (!sameSeal(await latestSeal(env, pharmacyId), seal)) throw new ApiError('audit seal changed during recovery', 'audit_anchor_mismatch', 503);
  await writeAnchor(env, pharmacyId, seal, state);
  return true;
}

async function insertSeal(env, pharmacyId, seal, state, parent) {
  await ensureHistory(env, pharmacyId, seal);
  const r = await env.DB.prepare(`INSERT INTO audit_seals (pharmacy_id, epoch, upto_id, rows, hash, key_id, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM audit_seals WHERE pharmacy_id = ? AND epoch = ? AND upto_id = ?)
      AND COALESCE((SELECT epoch || ':' || upto_id || ':' || hash FROM audit_seals WHERE pharmacy_id = ? ORDER BY epoch DESC, upto_id DESC LIMIT 1), '') = ?`)
    .bind(pharmacyId, seal.epoch, seal.upto_id, seal.rows, seal.hash, seal.key_id, seal.created_at, pharmacyId, seal.epoch, seal.upto_id,
      pharmacyId, parent ? `${parent.epoch}:${parent.upto_id}:${parent.hash}` : '').run();
  if ((r?.meta?.changes ?? 0) !== 1) throw new ApiError('another request sealed this audit log; retry later', 'audit_seal_conflict', 503);
  await writeAnchor(env, pharmacyId, seal, state);
}

// New seals require the current R2 anchor to match D1. A missing/mismatched anchor is restored only from an
// immutable copy that exactly matches the current D1 seal; otherwise sealing stops for owner-authorized recovery.
export async function sealAudit(env, pharmacyId, { maxRows = 2000 } = {}) {
  const [k] = await keyring(env?.AUDIT_SEAL_KEY, env?.AUDIT_SEAL_KEY_OLD);
  if (!k) return { sealed: 0, left: false, configured: false };
  if (!env.FILES) throw new ApiError('R2 audit anchor is unavailable', 'audit_anchor_unavailable', 503);
  const latest = await latestSeal(env, pharmacyId);
  requireCurrentHistory(await historyInventory(env, pharmacyId), latest);
  let anchor = await readAnchor(env, pharmacyId);
  if (latest) {
    if (anchor.status !== 'present' || !sameSeal(anchor.value, latest)) {
      // Only one case is repaired here without the owner: the anchor is exactly one seal behind (the seal
      // went into D1, then writing the anchor failed), and that seal's immutable copy is in R2 and the seal
      // checks out. Anything else (anchor missing, unreadable, or not the seal right before) stops sealing
      // until the owner restores it (rebaselineAudit restores from the trusted copy first).
      const parent = await parentSeal(env, pharmacyId, latest);
      const lagging = anchor.status === 'present' && parent && sameSeal(anchor.value, parent);
      const checked = lagging ? await verifyEpoch(env, pharmacyId) : null;
      if (!lagging || checked?.ok !== true || !(await restoreTrusted(env, pharmacyId, latest, anchor))) {
        const why = anchor.status === 'missing' ? 'anchor_missing' : anchor.status === 'present' ? 'anchor_mismatch' : 'anchor_unreadable';
        console.error('AUDIT_SEAL_STOPPED', pharmacyId, why);
        throw new ApiError(`audit anchor recovery required: ${why}`, 'audit_anchor_recovery_required', 503);
      }
      anchor = await readAnchor(env, pharmacyId);
    }
    await ensureHistory(env, pharmacyId, latest);
  } else if (anchor.status !== 'missing') {
    throw new ApiError('audit anchor exists without a D1 seal; preserve it and request owner rebaseline', 'audit_anchor_recovery_required', 503);
  }
  const epoch = latest?.epoch ?? 0, prevId = latest?.upto_id ?? 0, prevHash = latest?.hash ?? '';
  const { hash, n, lastId } = await chain(await hmacKey(k.raw), prevHash, rowsAfter(env, pharmacyId, prevId, Number.MAX_SAFE_INTEGER, maxRows));
  if (!n) return { sealed: 0, left: false, epoch };
  const seal = { epoch, upto_id: lastId, rows: (latest?.rows ?? 0) + n, hash, key_id: k.id, created_at: nowIso() };
  await insertSeal(env, pharmacyId, seal, anchor, latest);
  return { sealed: n, left: !!(await env.DB.prepare('SELECT 1 FROM audit_log WHERE pharmacy_id = ? AND id > ? LIMIT 1').bind(pharmacyId, lastId).first()), epoch };
}

// Every pharmacy's new rows, within a total budget per run; what is left waits for the next run.
export async function sealAll(env, { budget = 20000 } = {}) {
  const out = { pharmacies: 0, sealed: 0, failed: 0, left: 0, configured: await sealReady(env) };
  if (!out.configured) { console.warn('AUDIT_SEAL_NOT_CONFIGURED: AUDIT_SEAL_KEY is not set, the log is not sealed'); return out; }
  for (const { pharmacy_id: id } of (await env.DB.prepare('SELECT DISTINCT pharmacy_id FROM audit_log').all()).results) {
    if (out.sealed >= budget) { out.left++; continue; }
    try {
      const r = await sealAudit(env, id, { maxRows: budget - out.sealed });
      out.pharmacies++; out.sealed += r.sealed; if (r.left) out.left++;
    } catch (e) { out.failed++; console.error('AUDIT_SEAL_FAILED', id, e?.message); }
  }
  if (out.left) console.warn('AUDIT_SEAL_BACKLOG', out.left, 'pharmacies still have unsealed rows; they continue on the next run');
  return out;
}

// Manual recovery is reserved for a pharmacy owner. It appends a new epoch and logs the reason; prior D1 seals,
// the current R2 object (when readable), and every immutable anchor copy are retained as evidence.
export async function rebaselineAudit(env, pharmacyId, { userId, reason, confirm, proof = null } = {}) {
  if (confirm !== REBASE_CONFIRM) throw new ApiError('explicit owner confirmation required', 'audit_rebaseline_confirmation_required', 400);
  reason = String(reason || '').trim();
  if (reason.length < 10 || reason.length > 500) throw new ApiError('write a reason of 10 to 500 characters', 'validation_failed', 400);
  const [k] = await keyring(env?.AUDIT_SEAL_KEY, env?.AUDIT_SEAL_KEY_OLD);
  if (!k || !env.FILES) throw new ApiError('audit sealing is not configured', 'audit_seal_not_configured', 503);
  const latest = await latestSeal(env, pharmacyId), anchor = await readAnchor(env, pharmacyId);
  const history = await historyInventory(env, pharmacyId);
  if (['unavailable', 'unreadable', 'oversized'].includes(anchor.status)) throw new ApiError('current audit anchor cannot be read or preserved', 'audit_anchor_unavailable', 503);
  let historyCurrent = true;
  try { requireCurrentHistory(history, latest); } catch { historyCurrent = false; }
  let checked = latest ? await verifyEpoch(env, pharmacyId) : { ok: true };
  if (latest && historyCurrent && checked.ok === null && checked.reason === 'too_big') {
    if (!proof) throw new ApiError('complete the audit verification before recovery', 'audit_verify_required', 409);
    const state = await readCursor(await keyring(env?.AUDIT_SEAL_KEY, env?.AUDIT_SEAL_KEY_OLD), proof, pharmacyId, userId, 'proof');
    if (!sameSeal(state.latest, latest) || state.anchor !== anchorVersion(anchor) || state.rowId !== latest.upto_id || state.boundary !== latest.upto_id || state.rows !== latest.rows || state.hash !== latest.hash) throw new ApiError('audit verification is no longer current', 'audit_verify_required', 409);
    checked = { ok: true };
  }
  if (latest && historyCurrent && checked.ok === null) throw new ApiError('audit verification could not be completed', 'audit_verify_required', 409);
  if (latest && historyCurrent && anchor.status === 'present' && sameSeal(anchor.value, latest) && checked.ok === true) throw new ApiError('audit anchor is already in sync; no rebaseline is needed', 'audit_anchor_in_sync', 409);
  // Never over evidence. A new epoch seals the log again from its first row, so it would vouch for whatever
  // is there now: it is allowed only when the one thing wrong is a missing or unreadable anchor. A changed
  // row or seal, an anchor that disagrees with D1 (the end cut off), seals removed while the anchor exists,
  // or copies in R2 that D1 doesn't have: sealing stays stopped and everything stays as it is, to be looked at.
  const evidence = !historyCurrent ? 'history_conflict'
    : latest && checked.ok === false ? checked.reason || 'changed'
    : anchor.status === 'present' && (!latest || !sameSeal(anchor.value, latest)) ? (latest ? 'anchor_mismatch' : 'seals_missing')
    : null;
  if (evidence) {
    console.error('AUDIT_REBASELINE_REFUSED', pharmacyId, evidence);
    throw new ApiError(`the audit log shows signs of tampering (${evidence}); it is kept as evidence and sealing stays stopped`, 'audit_rebaseline_refused', 409);
  }
  if (latest) {
    if (historyCurrent && checked.ok === true) {
      let restored = false;
      try { restored = await restoreTrusted(env, pharmacyId, latest, anchor, userId); }
      catch (e) { if (e.code !== 'audit_anchor_evidence_conflict') throw e; }
      if (restored) {
        const r = await sealAudit(env, pharmacyId, { maxRows: sealBudget(env) });
        return { action: 'restored_from_trusted_backup', ...r };
      }
    }
  }
  await preserveAnchor(env, pharmacyId, anchor);
  const max = (await env.DB.prepare('SELECT max(epoch) AS epoch FROM audit_seals WHERE pharmacy_id = ?').bind(pharmacyId).first())?.epoch;
  const epoch = history.reduce((n, entry) => Math.max(n, entry.epoch), max ?? -1) + 1;
  if (!Number.isSafeInteger(epoch)) throw new ApiError('audit epoch exhausted', 'audit_anchor_evidence_conflict', 503);
  await logAnchorAction(env, pharmacyId, userId, 'rebaseline', {
    epoch, previous_epoch: latest?.epoch ?? null, previous_upto_id: latest?.upto_id ?? null, previous_hash: latest?.hash ?? null,
    anchor_status: anchor.status, reason, authorized_by: userId,
  });
  const { hash, n, lastId } = await chain(await hmacKey(k.raw), '', rowsAfter(env, pharmacyId, 0, Number.MAX_SAFE_INTEGER, sealBudget(env)));
  if (!n) throw new ApiError('no audit rows were available to establish a new epoch', 'audit_rebaseline_empty', 409);
  const seal = { epoch, upto_id: lastId, rows: n, hash, key_id: k.id, created_at: nowIso() };
  await insertSeal(env, pharmacyId, seal, anchor, latest);
  return { action: 'rebaselined', epoch, sealed: n, left: !!(await env.DB.prepare('SELECT 1 FROM audit_log WHERE pharmacy_id = ? AND id > ? LIMIT 1').bind(pharmacyId, lastId).first()) };
}
