// Backup check ON CLOUDFLARE (staging only, synthetic data). Run by .github/workflows/staging.yml in three steps;
// this script runs the first and the last and NEVER has the Cloudflare token:
//
//   1. node scripts/staging-backup-check.mjs prepare <rows>      (STAGING_URL; no secrets)
//        Makes a synthetic pharmacy on the staging Worker, asks the Worker for a backup (the real Workers runtime:
//        D1 + R2 + WebCrypto), and writes the two ids to worker/.staging-backup/request.json.
//   2. node scripts/staging-guard.mjs fetch-backup                (the guard, with the staging token)
//        Downloads exactly that backup from the staging R2 bucket to worker/.staging-backup/backup.sdbk.
//   3. node scripts/staging-backup-check.mjs verify <report.json> (STAGING_BACKUP_KEY; no Cloudflare access)
//        Opens the downloaded file with the staging key, checks it can't be opened with another key, as another
//        pharmacy, or after one changed byte, restores it into a separate, empty LOCAL database and verifies rows,
//        money, stock and links.
//
// The file locations are fixed (imported from the guard); no path is taken from the command line. The key is read
// from the environment and never printed.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPlatformProxy } from 'wrangler';
import { decryptBackup, restoreInto, verifyRestore, summarize } from '../src/backup.js';
import { STAGING, WORKER, CONFIG, BACKUP_DIR, BACKUP_REQUEST, BACKUP_FILE, BACKUP_META, BACKUP_MAX_BYTES, readBackupRequest, wranglerBin } from './staging-guard.mjs';

const PREPARE_REPORT = join(BACKUP_DIR, 'prepare-report.json');
const [mode, arg] = process.argv.slice(2);
if (process.env.CLOUDFLARE_API_TOKEN) { console.error('refusing: this script must run without the Cloudflare token'); process.exit(2); }
const rnd = () => Math.random().toString(36).slice(2, 10);

async function prepare(rowsArg = '300') {
  const BASE = process.env.STAGING_URL;
  if (!BASE || !STAGING.urlHost.test(BASE)) { console.error('refusing: STAGING_URL is missing or not the staging URL'); process.exit(2); }
  const call = async (token, path, body) => {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const report = { at: new Date().toISOString(), target: BASE, synthetic_rows: +rowsArg };
  // 1. Synthetic pharmacy.
  const email = `stg-${rnd()}@test.local`;
  const token = (await call(null, '/api/auth/signup', { email, password: 'password123' })).data.access_token;
  const P = (await call(token, '/api/rpc/create_pharmacy', { p_name: 'صيدلية تجربة (staging)' })).data;
  const B = (await call(token, '/api/db', { op: 'select', table: 'branches', cols: 'id', filters: [['pharmacy_id', 'eq', P]] })).data[0].id;
  const n = Math.max(1, +rowsArg);
  await call(token, '/api/db', { op: 'upsert', table: 'purchases', ignoreDuplicates: true, rows: { id: crypto.randomUUID(), pharmacy_id: P, branch_id: B, received_on: new Date().toISOString().slice(0, 10), lines: [{ code: 'A1', qty: n + 10, cost: 5 }], total: (n + 10) * 5 } });
  let t = Date.now();
  for (let i = 0; i < n; i += 100) {
    const rows = Array.from({ length: Math.min(100, n - i) }, (_, k) => ({ id: crypto.randomUUID(), pharmacy_id: P, branch_id: B, number: `S-${i + k}-${rnd()}`, sold_at: new Date().toISOString(), lines: [{ code: 'A1', qty: 1, price: 10 }], total: 10, paid: 10 }));
    const r = await call(token, '/api/db', { op: 'upsert', table: 'pos_sales', rows, ignoreDuplicates: true });
    if (r.error) throw new Error(`synthetic receipts: ${r.error.message}`);
  }
  report.insert_ms = Date.now() - t;
  // 2. Backup on Cloudflare.
  t = Date.now();
  const b = await call(token, '/api/rpc/backup_now', { p_pharmacy: P });
  report.backup = { status: b.status, ms: Date.now() - t, error: b.error?.message ?? null, bytes: b.data?.bytes, counts: b.data?.counts };
  if (b.error) throw new Error(`backup on staging failed: ${b.error.message}`);
  const list = (await call(token, '/api/rpc/list_backups', { p_pharmacy: P })).data;
  report.list = list.map(({ status, bytes, source, summary }) => ({ status, bytes, source, key_id: summary?.key_id ?? null }));
  // The hand-over for the guarded download: the two ids only (the guard checks them again).
  await mkdir(BACKUP_DIR, { recursive: true });
  await writeFile(BACKUP_REQUEST, JSON.stringify({ pharmacyId: P, backupId: b.data.id }));
  readBackupRequest(); // the same check the guard makes
  await writeFile(PREPARE_REPORT, JSON.stringify(report));
  console.log(JSON.stringify({ step: 'prepare', backup: report.backup }));
}

async function verify(outFile = '../staging-backup-report.json') {
  const KEY = process.env.STAGING_BACKUP_KEY;
  if (!KEY) { console.error('STAGING_BACKUP_KEY is needed'); process.exit(2); }
  const report = JSON.parse(await readFile(PREPARE_REPORT, 'utf8').catch(() => '{}'));
  const work = await mkdtemp(join(tmpdir(), 'staging-backup-'));
  try {
    const { pharmacyId: P } = readBackupRequest();
    // 3. Only the file the guard downloaded, at its fixed place, as a plain file, matching what the guard recorded.
    const st = await lstat(BACKUP_FILE);
    if (!st.isFile() || st.isSymbolicLink() || st.size > BACKUP_MAX_BYTES) throw new Error('the downloaded backup is not a plain file of a possible size');
    const bytes = await readFile(BACKUP_FILE);
    const meta = JSON.parse(await readFile(BACKUP_META, 'utf8'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (meta.sha256 !== sha256 || meta.pharmacyId !== P || meta.bytes !== bytes.length) throw new Error('the backup file is not the one the guard downloaded');
    report.file = { bytes: bytes.length, header: bytes.subarray(0, 5).toString(), sha256 };
    const plain = await decryptBackup({ BACKUP_KEY: KEY }, P, bytes);
    const dump = JSON.parse(plain);
    const refused = async (fn) => { try { await fn(); return 'opened (unexpected)'; } catch (e) { return String(e.message); } };
    const bent = Buffer.from(bytes); bent[bent.length - 30] ^= 1;
    report.negative = {
      another_key: await refused(() => decryptBackup({ BACKUP_KEY: 'x'.repeat(48) }, P, bytes)),
      another_pharmacy: await refused(() => decryptBackup({ BACKUP_KEY: KEY }, crypto.randomUUID(), bytes)),
      one_byte_changed: await refused(() => decryptBackup({ BACKUP_KEY: KEY }, P, bent)),
      no_key: await refused(() => decryptBackup({}, P, bytes)),
    };
    // 4. Restore into a separate, empty LOCAL database (--local: on this runner's disk; no token in this step).
    const dst = join(work, 'restore');
    execFileSync(process.execPath, [wranglerBin(), 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', dst, '--config', CONFIG], { cwd: WORKER, stdio: 'pipe' });
    const proxy = await getPlatformProxy({ configPath: CONFIG, persist: { path: join(dst, 'v3') } });
    try {
      const t = Date.now();
      await restoreInto(proxy.env, dump);
      report.restore_ms = Date.now() - t;
      report.verify = await verifyRestore(proxy.env, dump);
      report.summary = { money: (await summarize(dump)).money, rows: Object.values(dump.tables).reduce((a, r) => a + r.length, 0) };
    } finally { await proxy.dispose(); }
    report.result = report.verify.ok && Object.values(report.negative).every((v) => !/unexpected/.test(v)) ? 'PASS' : 'FAIL';
  } catch (e) {
    report.result = 'FAIL'; report.error = String(e?.message || e).replaceAll(KEY, '[key]');
  } finally { await rm(work, { recursive: true, force: true }); }
  await writeFile(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, backup: report.backup, file: report.file, restore_ms: report.restore_ms, problems: report.verify?.problems, negative: report.negative, error: report.error }, null, 1));
  process.exit(report.result === 'PASS' ? 0 : 1);
}

if (mode === 'prepare') await prepare(arg).catch((e) => { console.error(`prepare failed: ${e?.message || e}`); process.exit(1); });
else if (mode === 'verify') await verify(arg);
else { console.error('usage: staging-backup-check.mjs prepare <rows> | verify <report.json>'); process.exit(2); }
