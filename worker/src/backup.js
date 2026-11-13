// Server backups of one pharmacy (Phase 2 M2): made on the server, encrypted, kept in R2, listed in
// the `backups` table (migrations/0014). Restoring puts every row back with the same ids into an
// EMPTY database (disaster recovery); moving to a new pharmacy on the same server stays import_backup.
//
// File format (.sdbk): "SDBK1" + 12-byte IV + AES-256-GCM(plain JSON), with the pharmacy id as
// additional data. The key is HKDF-SHA256(BACKUP_KEY, salt = pharmacy id, info "saydaliti-backup-v1"),
// so each pharmacy's backups have their own key and a file can't be opened as another pharmacy's.
// Without the BACKUP_KEY secret, no backup is made (and none is stored unencrypted).
import { TABLES } from './schema.js';
import { ApiError, nowIso, uuid } from './db.js';

export const RETAIN = 14; // the newest good backups kept per pharmacy (older files are deleted)
const enc = new TextEncoder(), dec = new TextDecoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256hex = async (text) => hex(await crypto.subtle.digest('SHA-256', typeof text === 'string' ? enc.encode(text) : text));

// Every table with the pharmacy's rows, parents first (restore order). stock_levels is not kept: the
// ledger's trigger rebuilds it, and the restore checks it comes back the same.
const SKIP = new Set(['users', 'sessions', 'password_resets', 'email_outbox', 'audit_seals', 'auth_attempts', 'app_admins', 'app_secrets', 'invite_attempts', 'pin_attempts', 'client_errors', 'app_config', 'stock_levels', 'pharmacies', 'members']);
export const BACKUP_TABLES = ['branches', 'employees', 'attendance', 'invites', 'snapshots', 'connector_tokens', 'customers', 'customer_payments', 'patients', 'reminders',
  'catalog_items', 'purchases', 'supplier_payments', 'pos_shifts', 'pos_barcodes', 'pos_sales', 'return_approvals', 'stock_moves', 'stock_bases', 'stock_ledger',
  'expenses', 'cash_moves', 'shortages', 'market_prices', 'day_closes', 'tasks', 'subscriptions', 'audit_log'];
{ // every tenant table of schema.js is covered (a new table must be added above)
  const missing = Object.entries(TABLES).filter(([n, t]) => !t.internal && !SKIP.has(n) && !BACKUP_TABLES.includes(n)).map(([n]) => n);
  if (missing.length) throw new Error(`backup.js: tables not in BACKUP_TABLES: ${missing.join(', ')}`);
}
const keyCol = (table) => (Array.isArray(TABLES[table].pk) ? TABLES[table].pk : [TABLES[table].pk || 'rowid']);

// ---------- Making the backup ----------
async function rowsOf(env, sql, ...args) { return (await env.DB.prepare(sql).bind(...args).all()).results; }

// The pharmacy as stored: raw column values (JSON stays text), so a restore writes back exactly the same.
export async function dumpPharmacy(env, pharmacyId) {
  const ph = await rowsOf(env, 'SELECT * FROM pharmacies WHERE id = ?', pharmacyId);
  if (!ph.length) throw new ApiError('pharmacy not found', '404', 404);
  const tables = { pharmacies: ph, members: await rowsOf(env, 'SELECT * FROM members WHERE pharmacy_id = ?', pharmacyId) };
  // The accounts that belong to it (sign-in hashes only, no sessions), so people can sign in after a restore.
  tables.users = await rowsOf(env, 'SELECT id, email, pw_hash, google_sub, created_at FROM users WHERE id IN (SELECT user_id FROM members WHERE pharmacy_id = ?)', pharmacyId);
  for (const t of BACKUP_TABLES) {
    const col = TABLES[t].tenant || 'pharmacy_id';
    tables[t] = await rowsOf(env, `SELECT * FROM ${t} WHERE ${col} = ? ORDER BY ${keyCol(t).join(', ')}`, pharmacyId);
  }
  // The uploaded files (R2) the snapshot rows point to.
  const blobs = {};
  for (const s of tables.snapshots) { const o = await env.FILES.get(`snapshots/${s.id}.json`); if (o) blobs[`snapshots/${s.id}.json`] = await o.text(); }
  return { app: 'saydaliti', kind: 'server-backup', version: 1, pharmacy_id: pharmacyId, created_at: nowIso(), tables, blobs };
}

// What a backup holds, to check a restore against: rows per table, a checksum per table, money
// totals, and the stock per item and branch from the ledger.
export async function summarize(dump) {
  const t = dump.tables;
  const sum = (rows, col, f = () => true) => Math.round(rows.filter(f).reduce((a, r) => a + (+r[col] || 0), 0) * 100) / 100;
  const counts = {}, hashes = {};
  for (const [name, rows] of Object.entries(t)) {
    counts[name] = rows.length;
    const stable = rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).sort();
    hashes[name] = await sha256hex(stable.join('\n'));
  }
  const stock = {};
  for (const r of t.stock_ledger || []) { const k = `${r.branch_id}|${r.code}`; stock[k] = Math.round(((stock[k] || 0) + (+r.applied || 0)) * 1e6) / 1e6; }
  return {
    counts, hashes, blobs: Object.keys(dump.blobs || {}).length,
    money: {
      sales: sum(t.pos_sales || [], 'total', (r) => r.kind === 'sale'), returns: sum(t.pos_sales || [], 'total', (r) => r.kind === 'return'),
      purchases: sum(t.purchases || [], 'total', (r) => r.kind !== 'return'), supplier_returns: sum(t.purchases || [], 'total', (r) => r.kind === 'return'),
      supplier_payments: sum(t.supplier_payments || [], 'amount'), customer_payments: sum(t.customer_payments || [], 'amount'),
      expenses: sum(t.expenses || [], 'amount'), on_account: sum(t.pos_sales || [], 'credit'),
    },
    stock,
  };
}

// ---------- Encryption ----------
// File: "SDBK2" + 8-byte key id + 12-byte IV + AES-256-GCM(plain, additional data = pharmacy id).
// The key id says which BACKUP_KEY made the file, so the key can be rotated: put the new key in
// BACKUP_KEY and the previous ones in BACKUP_KEYS_OLD (comma-separated); files made with a retired key
// still open. A file whose key is in neither is reported as such — it can't be opened by anyone.
// (Files from before key ids, "SDBK1", are tried with every available key.)
const MAGIC2 = enc.encode('SDBK2');
const keysOf = (env) => [String(env?.BACKUP_KEY || ''), ...String(env?.BACKUP_KEYS_OLD || '').split(',').map((k) => k.trim())].filter((k) => k.length >= 32);
export async function keyId(secret) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`saydaliti-backup-key-id:${secret}`))).slice(0, 8); }
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
async function aesKey(secret, pharmacyId) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(String(pharmacyId)), info: enc.encode('saydaliti-backup-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptBackup(env, pharmacyId, text) {
  const secret = String(env?.BACKUP_KEY || '');
  if (secret.length < 32) throw new ApiError('server not configured: backup key missing', '503', 503);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kid = await keyId(secret);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(String(pharmacyId)) }, await aesKey(secret, pharmacyId), enc.encode(text)));
  const out = new Uint8Array(MAGIC2.length + 8 + 12 + ct.length);
  out.set(MAGIC2, 0); out.set(kid, 5); out.set(iv, 13); out.set(ct, 25);
  return out;
}
export async function decryptBackup(env, pharmacyId, bytes) {
  const b = new Uint8Array(bytes);
  const head = dec.decode(b.slice(0, 5));
  const keys = keysOf(env);
  if (!keys.length) throw new ApiError('server not configured: backup key missing', '503', 503);
  let tries, iv, ct;
  if (head === 'SDBK2' && b.length >= 25 + 16) {
    const kid = b.slice(5, 13);
    tries = [];
    for (const k of keys) if (sameBytes(await keyId(k), kid)) tries.push(k);
    if (!tries.length) throw new ApiError(`backup key not available (key id ${hex(kid)}): this file was made with a key that is not in BACKUP_KEY or BACKUP_KEYS_OLD`);
    iv = b.slice(13, 25); ct = b.slice(25);
  } else if (head === 'SDBK1' && b.length >= 17 + 16) { tries = keys; iv = b.slice(5, 17); ct = b.slice(17); } else throw new ApiError('not a backup file');
  for (const k of tries) {
    try { return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(String(pharmacyId)) }, await aesKey(k, pharmacyId), ct)); } catch { /* next key */ }
  }
  throw new ApiError('backup cannot be opened (wrong key, wrong pharmacy, or damaged)');
}
export async function keyIdOfFile(bytes) { const b = new Uint8Array(bytes); return dec.decode(b.slice(0, 5)) === 'SDBK2' ? hex(b.slice(5, 13)) : null; }

// ---------- One backup: make, encrypt, store, list, keep the newest RETAIN ----------
export async function runBackup(env, pharmacyId, { by = null, source = 'manual' } = {}) {
  const id = uuid(), at = nowIso();
  try {
    const dump = await dumpPharmacy(env, pharmacyId);
    const text = JSON.stringify(dump);
    const sha = await sha256hex(text);
    const summary = await summarize(dump);
    const file = await encryptBackup(env, pharmacyId, text);
    const key = `backups/${pharmacyId}/${at.replace(/[:.]/g, '-')}-${id.slice(0, 8)}.sdbk`;
    await env.FILES.put(key, file, { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { sha256: sha, pharmacy: pharmacyId } });
    // Read it back and open it before listing it as good: a file that was only written is not a backup.
    const back = await env.FILES.get(key);
    if (!back || (await sha256hex(await decryptBackup(env, pharmacyId, await back.arrayBuffer()))) !== sha) throw new Error('backup check after writing failed');
    await env.DB.prepare('INSERT INTO backups (id, pharmacy_id, created_at, status, r2_key, bytes, sha256, summary, created_by, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, pharmacyId, at, 'ok', key, file.length, sha, JSON.stringify({ counts: summary.counts, money: summary.money, blobs: summary.blobs, key_id: await keyIdOfFile(file) }), by, source).run();
    await prune(env, pharmacyId);
    return { id, key, bytes: file.length, sha256: sha, counts: summary.counts };
  } catch (e) {
    await env.DB.prepare('INSERT INTO backups (id, pharmacy_id, created_at, status, error, created_by, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, pharmacyId, at, 'failed', String(e?.message || e).slice(0, 500), by, source).run().catch(() => {});
    throw e;
  }
}
async function prune(env, pharmacyId) {
  const old = await rowsOf(env, "SELECT id, r2_key FROM backups WHERE pharmacy_id = ? AND status = 'ok' ORDER BY created_at DESC LIMIT -1 OFFSET ?", pharmacyId, RETAIN);
  if (!old.length) return;
  await env.FILES.delete(old.map((o) => o.r2_key));
  await env.DB.prepare(`UPDATE backups SET status = 'expired' WHERE id IN (${old.map(() => '?').join(', ')})`).bind(...old.map((o) => o.id)).run();
}

// The daily job (cron): every pharmacy, one at a time; a failure is listed and the others go on.
// Afterwards the health check runs; any problem is logged as "BACKUP_ALERT {...}" (Cloudflare
// observability can alert on it) and is shown to the owner and the app admin (list_backups,
// admin_backup_health).
export async function backupAll(env) {
  if (!env.BACKUP_KEY) { console.error('BACKUP_ALERT', JSON.stringify({ problem: 'BACKUP_KEY not set: no backups are made' })); return { skipped: 'no BACKUP_KEY' }; }
  const out = { ok: 0, failed: 0 };
  for (const { id } of await rowsOf(env, 'SELECT id FROM pharmacies ORDER BY created_at')) {
    try { await runBackup(env, id, { source: 'daily' }); out.ok++; } catch { out.failed++; }
  }
  const health = await backupHealth(env);
  if (health.problems.length) console.error('BACKUP_ALERT', JSON.stringify(health));
  return { ...out, problems: health.problems.length };
}

// Which pharmacies have no good backup, an old one (> STALE_HOURS), or a failure after the last good one.
export const STALE_HOURS = 36;
export async function backupHealth(env, now = Date.now()) {
  const rows = await rowsOf(env, `SELECT p.id, p.name,
      (SELECT max(created_at) FROM backups b WHERE b.pharmacy_id = p.id AND b.status = 'ok') AS last_ok,
      (SELECT max(created_at) FROM backups b WHERE b.pharmacy_id = p.id AND b.status = 'failed') AS last_failed,
      (SELECT error FROM backups b WHERE b.pharmacy_id = p.id AND b.status = 'failed' ORDER BY created_at DESC LIMIT 1) AS last_error
    FROM pharmacies p ORDER BY p.created_at`);
  const problems = [];
  for (const r of rows) {
    if (!r.last_ok) problems.push({ pharmacy_id: r.id, problem: 'no good backup' });
    else if (now - Date.parse(r.last_ok) > STALE_HOURS * 3600000) problems.push({ pharmacy_id: r.id, problem: 'last good backup too old', last_ok: r.last_ok });
    if (r.last_failed && (!r.last_ok || r.last_failed > r.last_ok)) problems.push({ pharmacy_id: r.id, problem: 'last attempt failed', at: r.last_failed, error: r.last_error });
  }
  return { checked: rows.length, problems, at: new Date(now).toISOString() };
}

// ---------- Restore into an empty database (disaster recovery) ----------
// Every row back with the same ids, in order; the uploaded files back to R2. Refuses if the pharmacy
// (or any of its accounts) is already there: it never merges into or overwrites existing data.
export async function restoreInto(env, dump) {
  if (dump?.app !== 'saydaliti' || dump.kind !== 'server-backup' || !dump.tables?.pharmacies?.[0]) throw new ApiError('not a server backup');
  const pid = dump.pharmacy_id;
  if (await env.DB.prepare('SELECT 1 FROM pharmacies WHERE id = ?').bind(pid).first()) throw new ApiError('pharmacy already exists here: restore only into an empty database');
  for (const u of dump.tables.users || []) if (await env.DB.prepare('SELECT 1 FROM users WHERE id = ? OR email = ? OR (google_sub IS NOT NULL AND google_sub = ?)').bind(u.id, u.email, u.google_sub ?? null).first()) throw new ApiError('account already exists here: restore only into an empty database');
  const order = ['pharmacies', 'users', 'members', ...BACKUP_TABLES];
  const counts = {};
  for (const table of order) {
    const rows = dump.tables[table] || [];
    counts[table] = rows.length;
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    for (const c of cols) if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw new ApiError('bad column in backup');
    // 200 rows per statement, read from JSON (a statement per row would hit D1's query limits).
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200).map((r) => cols.map((c) => r[c] ?? null));
      await env.DB.prepare(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${cols.map((_, k) => `json_extract(value, '$[${k}]')`).join(', ')} FROM json_each(?)`)
        .bind(JSON.stringify(chunk)).run();
    }
  }
  for (const [k, text] of Object.entries(dump.blobs || {})) { if (!/^snapshots\/\d+\.json$/.test(k)) throw new ApiError('bad file in backup'); await env.FILES.put(k, text, { httpMetadata: { contentType: 'application/json' } }); }
  return counts;
}

// A restored pharmacy compared with its backup: rows, checksums, money, stock (rebuilt by the trigger
// from the ledger, compared with the backup's ledger), links between rows, and the uploaded files.
export async function verifyRestore(env, dump) {
  const pid = dump.pharmacy_id;
  const again = await dumpPharmacy(env, pid);
  const [a, b] = [await summarize(dump), await summarize(again)];
  const problems = [];
  for (const t of Object.keys(a.counts)) {
    if (a.counts[t] !== b.counts[t]) problems.push(`${t}: ${a.counts[t]} rows in the backup, ${b.counts[t]} restored`);
    else if (a.hashes[t] !== b.hashes[t]) problems.push(`${t}: same row count, different contents`);
  }
  for (const k of Object.keys(a.money)) if (a.money[k] !== b.money[k]) problems.push(`money ${k}: ${a.money[k]} vs ${b.money[k]}`);
  if (a.blobs !== b.blobs) problems.push(`files: ${a.blobs} vs ${b.blobs}`);
  for (const [k, v] of Object.entries(dump.blobs || {})) if (again.blobs[k] !== v) problems.push(`file ${k} differs`);
  // Stock: the levels the trigger rebuilt = the ledger sums in the backup.
  const levels = await rowsOf(env, 'SELECT branch_id, code, qty FROM stock_levels WHERE pharmacy_id = ?', pid);
  const lv = Object.fromEntries(levels.map((r) => [`${r.branch_id}|${r.code}`, Math.round(r.qty * 1e6) / 1e6]));
  for (const k of new Set([...Object.keys(a.stock), ...Object.keys(lv)])) if (Math.abs((a.stock[k] ?? 0) - (lv[k] ?? 0)) > 1e-6) problems.push(`stock ${k}: backup ledger ${a.stock[k] ?? 0}, restored level ${lv[k] ?? 0}`);
  // Links: every reference points to a row of the same pharmacy.
  const LINKS = [['pos_sales', 'branch_id', 'branches'], ['pos_sales', 'customer_id', 'customers'], ['pos_sales', 'employee_id', 'employees'], ['pos_sales', 'shift_id', 'pos_shifts'],
    ['pos_sales', 'return_of', 'pos_sales'], ['pos_sales', 'approval_id', 'return_approvals'], ['purchases', 'branch_id', 'branches'], ['stock_moves', 'branch_id', 'branches'],
    ['customer_payments', 'customer_id', 'customers'], ['reminders', 'patient_id', 'patients'], ['expenses', 'branch_id', 'branches'], ['stock_ledger', 'branch_id', 'branches'],
    ['members', 'user_id', 'users'], ['attendance', 'employee_id', 'employees']];
  for (const [t, col, ref] of LINKS) {
    const n = (await env.DB.prepare(`SELECT count(*) AS n FROM ${t} x WHERE x.pharmacy_id = ? AND x.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${ref} r WHERE r.id = x.${col})`).bind(pid).first()).n;
    if (n) problems.push(`${n} ${t}.${col} pointing nowhere`);
  }
  return { ok: !problems.length, problems, counts: b.counts, money: b.money, stock_items: Object.keys(lv).length };
}
