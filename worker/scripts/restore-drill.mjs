// Restore drill (Phase 2 M2), local only: never touches Cloudflare.
//   node worker/scripts/restore-drill.mjs <local wrangler state dir> <out report.json>
// 1. Copies the given local D1/R2 state as the SOURCE (the original is not changed).
// 2. Makes an EMPTY, separate TARGET database (its own state dir) and applies every migration.
// 3. Picks the pharmacy with the most receipts in the source, makes an encrypted backup there
//    (runBackup), reads the file back from R2 and opens it (decryptBackup).
// 4. Restores it into the target (restoreInto) and checks it (verifyRestore): rows and checksums
//    per table, money totals, stock levels rebuilt from the ledger, links between rows, files.
// 5. Negative checks: a second restore into the same target is refused; a restore into the source is
//    refused; the file can't be opened as another pharmacy. Retention: 16 backups keep the newest 14.
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { runBackup, decryptBackup, restoreInto, verifyRestore, backupHealth, RETAIN } from '../src/backup.js';

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [srcState, outFile] = process.argv.slice(2);
if (!srcState || !outFile) { console.error('usage: restore-drill.mjs <wrangler state dir> <out report.json>'); process.exit(2); }

const work = await mkdtemp(join(tmpdir(), 'saydaliti-drill-'));
const SRC = join(work, 'source'), DST = join(work, 'target');
await cp(resolve(srcState), SRC, { recursive: true });
// A separate, empty database with every migration.
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'saydaliti', '--local', '--persist-to', DST], { cwd: WORKER, stdio: 'pipe' });
const vars = Object.fromEntries((await readFile(join(WORKER, '.dev.vars'), 'utf8')).split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
if (!vars.BACKUP_KEY) throw new Error('worker/.dev.vars has no BACKUP_KEY (local test key)');
const open = async (dir) => { const p = await getPlatformProxy({ configPath: join(WORKER, 'wrangler.toml'), persist: { path: join(dir, 'v3') } }); return { p, env: { ...p.env, BACKUP_KEY: vars.BACKUP_KEY } }; };
const src = await open(SRC), dst = await open(DST);
const report = { at: new Date().toISOString(), source: 'copy of the local test database (test data only)', target: 'separate empty local D1/R2 with migrations 0001–0014' };
try {
  const pick = await src.env.DB.prepare(`SELECT p.id, (SELECT count(*) FROM pos_sales s WHERE s.pharmacy_id = p.id) AS sales, (SELECT count(*) FROM stock_ledger l WHERE l.pharmacy_id = p.id) AS ledger
    FROM pharmacies p ORDER BY sales + ledger DESC LIMIT 1`).first();
  report.pharmacy = pick;
  let t = Date.now();
  const b = await runBackup(src.env, pick.id, { source: 'drill' });
  report.backup = { ms: Date.now() - t, bytes: b.bytes, sha256: b.sha256, rows: Object.values(b.counts).reduce((a, n) => a + n, 0) };
  t = Date.now();
  const file = await (await src.env.FILES.get(b.key)).arrayBuffer();
  const dump = JSON.parse(await decryptBackup(src.env, pick.id, file));
  report.open_ms = Date.now() - t;
  t = Date.now();
  report.restored = await restoreInto(dst.env, dump);
  report.restore_ms = Date.now() - t;
  t = Date.now();
  report.verify = await verifyRestore(dst.env, dump);
  report.verify_ms = Date.now() - t;
  // The check must be able to fail: change the restored copy (one receipt removed, one amount changed,
  // one ledger row removed) and check again — every change has to be reported.
  const victim = dump.tables.pos_sales.find((r) => r.kind === 'sale');
  const other = dump.tables.pos_sales.find((r) => r.kind === 'sale' && r.id !== victim.id);
  const led = dump.tables.stock_ledger[0];
  await dst.env.DB.batch([
    dst.env.DB.prepare('DELETE FROM pos_sales WHERE id = ?').bind(victim.id),
    dst.env.DB.prepare('UPDATE pos_sales SET total = total + 1 WHERE id = ?').bind(other.id),
    ...(led ? [dst.env.DB.prepare('DELETE FROM stock_ledger WHERE id = ?').bind(led.id)] : []),
  ]);
  const tampered = await verifyRestore(dst.env, dump);
  report.tamper_check = { detected: !tampered.ok, problems: tampered.problems };
  // Negative checks.
  const refused = async (fn) => { try { await fn(); return false; } catch (e) { return String(e.message); } };
  report.negative = {
    second_restore_into_target: await refused(() => restoreInto(dst.env, dump)),
    restore_into_source: await refused(() => restoreInto(src.env, dump)),
    open_as_another_pharmacy: await refused(() => decryptBackup(src.env, '00000000-0000-4000-8000-000000000000', file)),
    open_with_another_key: await refused(() => decryptBackup({ BACKUP_KEY: 'x'.repeat(40) }, pick.id, file)),
  };
  // Retention: after RETAIN + 2 more backups, the newest RETAIN are kept and the older files are gone.
  for (let i = 0; i < RETAIN + 2; i++) await runBackup(src.env, pick.id, { source: 'drill' });
  const states = (await src.env.DB.prepare('SELECT status, r2_key FROM backups WHERE pharmacy_id = ? ORDER BY created_at').bind(pick.id).all()).results;
  const okKeys = states.filter((s) => s.status === 'ok').map((s) => s.r2_key);
  const expiredKeys = states.filter((s) => s.status === 'expired').map((s) => s.r2_key);
  report.retention = { kept: okKeys.length, expired: expiredKeys.length,
    expired_files_present: (await Promise.all(expiredKeys.map((k) => src.env.FILES.head(k)))).filter(Boolean).length,
    kept_files_present: (await Promise.all(okKeys.map((k) => src.env.FILES.head(k)))).filter(Boolean).length };
  // Monitoring: a failed backup is recorded and flagged; a pharmacy with no backup is flagged.
  let failedAsExpected = false;
  try { await runBackup({ ...src.env, BACKUP_KEY: '' }, pick.id, { source: 'drill' }); } catch { failedAsExpected = true; }
  const health = await backupHealth(src.env);
  report.monitoring = {
    failure_recorded: failedAsExpected && !!(await src.env.DB.prepare("SELECT 1 FROM backups WHERE pharmacy_id = ? AND status = 'failed'").bind(pick.id).first()),
    failure_flagged: health.problems.some((x) => x.pharmacy_id === pick.id && x.problem === 'last attempt failed'),
    no_backup_flagged: health.problems.some((x) => x.pharmacy_id !== pick.id && x.problem === 'no good backup'),
    checked: health.checked,
  };
  // Key rotation end to end: a backup made with the key in use opens after rotating, with the old key kept.
  const rotated = { ...src.env, BACKUP_KEY: `${vars.BACKUP_KEY}-rotated-0123456789`, BACKUP_KEYS_OLD: vars.BACKUP_KEY };
  const lastOk = await src.env.DB.prepare("SELECT r2_key FROM backups WHERE pharmacy_id = ? AND status = 'ok' ORDER BY created_at DESC LIMIT 1").bind(pick.id).first();
  const lastFile = await (await src.env.FILES.get(lastOk.r2_key)).arrayBuffer();
  report.rotation = {
    old_backup_opens_after_rotation: (await decryptBackup(rotated, pick.id, lastFile)).length > 0,
    old_backup_without_old_key: await (async () => { try { await decryptBackup({ BACKUP_KEY: rotated.BACKUP_KEY }, pick.id, lastFile); return 'opened (unexpected)'; } catch (e) { return String(e.message); } })(),
  };
  report.result = report.verify.ok && report.tamper_check.detected && report.monitoring.failure_recorded && report.monitoring.failure_flagged && report.monitoring.no_backup_flagged
    && report.rotation.old_backup_opens_after_rotation && /key not available/.test(report.rotation.old_backup_without_old_key) && Object.values(report.negative).every(Boolean) && report.retention.kept === RETAIN && report.retention.expired_files_present === 0 && report.retention.kept_files_present === RETAIN ? 'PASS' : 'FAIL';
} catch (e) {
  report.result = 'FAIL'; report.error = String(e?.stack || e);
} finally {
  await src.p.dispose(); await dst.p.dispose();
  await rm(work, { recursive: true, force: true });
}
await writeFile(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ result: report.result, pharmacy: report.pharmacy, backup: report.backup, restore_ms: report.restore_ms, problems: report.verify?.problems, tamper_check: report.tamper_check, negative: report.negative, retention: report.retention, monitoring: report.monitoring, rotation: report.rotation, error: report.error }, null, 1));
process.exit(report.result === 'PASS' ? 0 : 1);
