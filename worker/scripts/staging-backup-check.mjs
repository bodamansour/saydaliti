// Backup check ON CLOUDFLARE (staging only, synthetic data). Run by .github/workflows/staging.yml:
//   STAGING_URL=… STAGING_BACKUP_KEY=… CLOUDFLARE_API_TOKEN=<staging token> CLOUDFLARE_ACCOUNT_ID=…
//   node worker/scripts/staging-backup-check.mjs <rows> <report.json>
// 1. Makes a synthetic pharmacy on the staging Worker (receipts, a purchase, stock opened and blocked).
// 2. Asks the staging Worker for a backup (the real Workers runtime: D1 + R2 + WebCrypto), timed.
// 3. Downloads the encrypted file from the staging R2 bucket, opens it with the staging key, and checks
//    it can't be opened with another key, as another pharmacy, or after one changed byte.
// 4. Restores it into a separate, empty local database and verifies rows, money, stock and links.
// The key is read from the environment and never printed.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { decryptBackup, restoreInto, verifyRestore, summarize } from '../src/backup.js';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.STAGING_URL, KEY = process.env.STAGING_BACKUP_KEY;
const [rowsArg = '300', outFile = 'staging-backup-report.json'] = process.argv.slice(2);
if (!BASE || !KEY) { console.error('STAGING_URL and STAGING_BACKUP_KEY are needed'); process.exit(2); }
if (!/saydaliti-staging\./.test(BASE)) { console.error('refusing: not the staging URL'); process.exit(2); }
const report = { at: new Date().toISOString(), target: BASE, synthetic_rows: +rowsArg };
const rnd = () => Math.random().toString(36).slice(2, 10);
const wrangler = (args) => execFileSync('npx', ['wrangler', ...args, '--env', 'staging'], { cwd: WORKER, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function call(token, path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, ...(await r.json()) };
}
const work = await mkdtemp(join(tmpdir(), 'staging-backup-'));
try {
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
  // 3. The file, from the staging R2 bucket (its location is read from the staging D1).
  const q = JSON.parse(wrangler(['d1', 'execute', 'DB', '--remote', '--json', '--command', `SELECT r2_key FROM backups WHERE id = '${b.data.id.replace(/[^0-9a-f-]/g, '')}'`]));
  const r2key = q[0].results[0].r2_key;
  const file = join(work, 'backup.sdbk');
  wrangler(['r2', 'object', 'get', `saydaliti-files-staging/${r2key}`, '--remote', '--file', file]);
  const bytes = await readFile(file);
  report.file = { bytes: bytes.length, header: bytes.subarray(0, 5).toString() };
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
  // 4. Restore into a separate, empty local database.
  const dst = join(work, 'restore');
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'saydaliti', '--local', '--persist-to', dst], { cwd: WORKER, stdio: 'pipe' });
  const proxy = await getPlatformProxy({ configPath: join(WORKER, 'wrangler.toml'), persist: { path: join(dst, 'v3') } });
  try {
    t = Date.now();
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
