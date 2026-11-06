// Fail-closed guard for everything the staging workflow does on Cloudflare.
//
//   node scripts/staging-guard.mjs config          wrangler.toml [env.staging] names no production resource
//   node scripts/staging-guard.mjs remote          read-only: the token/account really hold the staging D1 and
//                                                  R2 bucket; writes a marker for this commit (no secrets in it)
//   node scripts/staging-guard.mjs run -- <args>   runs `wrangler <args> --env staging` only if the command is on
//                                                  the allowlist, names no production resource, and (for a write)
//                                                  the remote check passed for this commit
//   node scripts/staging-guard.mjs schedules       read-only: the staging Worker's cron schedules
//   node scripts/staging-guard.mjs fetch-backup    read-only: downloads the one backup named in
//                                                  worker/.staging-backup/request.json from the staging R2 bucket
//                                                  to worker/.staging-backup/backup.sdbk (fixed paths), so the
//                                                  backup-check script itself never needs the Cloudflare token
//
// Every wrangler call made here gets `--config <absolute path of worker/wrangler.toml>` (the file this guard
// checks), so Wrangler's own config discovery (wrangler.json / wrangler.jsonc found in any parent folder, or a
// .wrangler/deploy/config.json redirect) never runs; and the guard refuses to run at all while such a file exists.
//
// It never reads, prints or compares the production token, and it never sends a request about a production
// resource. Any doubt → exit 1 before wrangler runs. Tested by test/staging-guard.test.js.
import { readFileSync, writeFileSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Absolute paths from this file's own location, never from the current directory.
export const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG = join(WORKER, 'wrangler.toml');
const MARKER = join(WORKER, '.staging-preflight.json');
// The backup hand-over between the token-free backup check and the guarded download. Fixed paths: nobody can
// pass another one.
export const BACKUP_DIR = join(WORKER, '.staging-backup');
export const BACKUP_REQUEST = join(BACKUP_DIR, 'request.json');
export const BACKUP_FILE = join(BACKUP_DIR, 'backup.sdbk');
export const BACKUP_META = join(BACKUP_DIR, 'download.json');
export const BACKUP_MAX_BYTES = 200 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The only resources staging may touch.
export const STAGING = Object.freeze({
  worker: 'saydaliti-staging',
  dbName: 'saydaliti-staging',
  dbId: '0ba7c0dd-645e-453e-9999-a316a828e175',
  bucket: 'saydaliti-files-staging',
  cron: '*/30 * * * *',
  urlHost: /^https:\/\/saydaliti-staging\.[a-z0-9-]+\.workers\.dev$/,
});
// Production, fixed here on purpose (not only read from wrangler.toml, so editing the file can't move the target).
export const PRODUCTION = Object.freeze({
  worker: 'saydaliti',
  dbName: 'saydaliti',
  dbId: '3cf7edd2-1642-428b-bf1b-973f71d93529',
  bucket: 'saydaliti-files',
  url: 'saydaliti.mosaedapp.workers.dev',
});

// Credentials for real outside services; mirrored from worker/src/egress.js (a test keeps the two lists equal).
export const OUTSIDE_SERVICE_VARS = Object.freeze([
  'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TEMPLATE', 'WHATSAPP_DOSE_TEMPLATE', 'WHATSAPP_REFILL_TEMPLATE',
  'ANTHROPIC_API_KEY', 'AI_MODEL',
  'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_OUTBOX',
]);

class GuardError extends Error {}
const fail = (msg) => { throw new GuardError(msg); };

// ---------- which config Wrangler would read ----------
// Files that would make Wrangler read something other than worker/wrangler.toml if it searched for a config
// (it walks up from the current folder and prefers wrangler.json / wrangler.jsonc over wrangler.toml; a
// .wrangler/deploy/config.json redirects deploys; .env in the working folder is loaded into its environment).
export function alternativeConfigs(worker = WORKER) {
  const found = [];
  let dir = resolve(worker);
  for (;;) {
    for (const f of ['wrangler.json', 'wrangler.jsonc', join('.wrangler', 'deploy', 'config.json')]) if (existsSync(join(dir, f))) found.push(join(dir, f));
    const up = dirname(dir);
    if (up === dir || dir === parse(dir).root) break;
    dir = up;
  }
  for (const f of ['.env', '.env.local']) if (existsSync(join(worker, f))) found.push(join(worker, f));
  return found;
}
export function assertSingleConfig(worker = WORKER) {
  const alt = alternativeConfigs(worker);
  if (alt.length) fail(`refusing: other Wrangler config files could change what is deployed: ${alt.join(', ')}`);
  if (!existsSync(join(worker, 'wrangler.toml'))) fail('worker/wrangler.toml is missing');
}
// The one config, checked; used by every mode.
export function loadCheckedConfig(worker = WORKER) {
  assertSingleConfig(worker);
  const problems = checkConfig(readFileSync(join(worker, 'wrangler.toml'), 'utf8'));
  if (problems.length) fail(`wrangler.toml:\n  - ${problems.join('\n  - ')}`);
  const code = join(worker, 'src', 'index.js');
  const codeProblems = existsSync(code) ? checkScheduledHandler(readFileSync(code, 'utf8')) : ['worker/src/index.js is missing'];
  if (codeProblems.length) fail(`scheduled jobs:\n  - ${codeProblems.join('\n  - ')}`);
}

// The staging cron must reach only the backup job. In worker/src/index.js the handler has to send
// event.cron === env.BACKUP_CRON to the backups and return before the morning report or the patient reminders
// (any other cron would run the reminders).
export function checkScheduledHandler(src) {
  const start = src.search(/async\s+scheduled\s*\(/);
  if (start < 0) return ['no scheduled handler found'];
  const body = src.slice(start);
  const backup = body.search(/if\s*\(\s*event\.cron\s*===\s*env\.BACKUP_CRON\s*\)\s*\{[^{}]*backupAll\([^{}]*\breturn\s*;\s*\}/);
  const firstJob = body.search(/runReminders|runMorning/);
  const problems = [];
  // Both handlers must strip outside-service credentials first (worker/src/egress.js), and the jobs' fetch must
  // go through guardedFetch, so even a mis-set secret can't make staging message a patient.
  const isolated = body.search(/^\s*env\s*=\s*isolateEnv\(env\);/m);
  if (isolated < 0 || (firstJob >= 0 && isolated > firstJob)) problems.push('the scheduled handler must start with env = isolateEnv(env)');
  const fetchStart = src.search(/async\s+fetch\s*\(\s*req\s*,\s*env(?:\s*,\s*ctx)?\s*\)\s*\{/);
  if (fetchStart < 0 || !/^\s*env\s*=\s*isolateEnv\(env\);/m.test(src.slice(fetchStart).split('\n').slice(1, 3).join('\n'))) problems.push('the fetch handler must start with env = isolateEnv(env)');
  if (!/import\s*\{[^}]*\bisolateEnv\b[^}]*\bguardedFetch\b[^}]*\}\s*from\s*'\.\/egress\.js'/.test(src)) problems.push('index.js must import isolateEnv and guardedFetch from ./egress.js');
  if (/\breturn fetch\(u, init\)/.test(src) || !/guardedFetch\(env\)\(u, init\)/.test(src)) problems.push('the jobs\' outbound fetch must go through guardedFetch(env)');
  if (backup < 0) problems.push('the scheduled handler does not send BACKUP_CRON to the backups and return (this code would run the patient reminders on the staging cron)');
  else if (firstJob >= 0 && firstJob < backup) problems.push('the scheduled handler can start another job before the BACKUP_CRON check');
  return problems;
}

// ---------- wrangler.toml ----------
// Just enough TOML for this file: [section] / [[array]] headers and key = "string" | number | bool | [..].
export function parseToml(text) {
  const out = { root: {}, tables: [] };
  let cur = out.root;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    let m;
    if ((m = line.match(/^\[\[([^\]]+)\]\]$/))) { cur = { _table: m[1].trim(), _array: true }; out.tables.push(cur); continue; }
    if ((m = line.match(/^\[([^\]]+)\]$/))) { cur = { _table: m[1].trim(), _array: false }; out.tables.push(cur); continue; }
    if ((m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/))) cur[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}
const tablesOf = (cfg, name) => cfg.tables.filter((t) => t._table === name);
const bindingsOf = (cfg, prefix, kind) => tablesOf(cfg, prefix ? `${prefix}.${kind}` : kind);

export function checkConfig(text) {
  const cfg = parseToml(text);
  const problems = [];
  const no = (cond, msg) => { if (cond) problems.push(msg); };

  // Production is where it was (if this moves, something is wrong — stop).
  const pDb = bindingsOf(cfg, '', 'd1_databases'), pR2 = bindingsOf(cfg, '', 'r2_buckets');
  no(cfg.root.name !== PRODUCTION.worker, `production Worker name changed: ${cfg.root.name}`);
  no(pDb.length !== 1 || pDb[0].database_id !== PRODUCTION.dbId, 'production D1 binding changed');
  no(pR2.length !== 1 || pR2[0].bucket_name !== PRODUCTION.bucket, 'production R2 binding changed');

  const env = tablesOf(cfg, 'env.staging')[0];
  if (!env) return [...problems, 'no [env.staging] section'];
  const sDb = bindingsOf(cfg, 'env.staging', 'd1_databases'), sR2 = bindingsOf(cfg, 'env.staging', 'r2_buckets');
  const vars = tablesOf(cfg, 'env.staging.vars')[0] || {};

  no(env.name !== STAGING.worker, `staging Worker name is ${env.name}, expected ${STAGING.worker}`);
  no(env.workers_dev !== 'true', 'staging must deploy to workers.dev only');
  no('route' in env || 'routes' in env, 'staging must not have routes');
  no(sDb.length !== 1, `staging needs exactly one D1 binding (has ${sDb.length})`);
  no(sR2.length !== 1, `staging needs exactly one R2 binding (has ${sR2.length})`);
  for (const d of sDb) {
    no(d.database_id !== STAGING.dbId, `staging D1 id ${d.database_id} is not ${STAGING.dbId}`);
    no(d.database_name !== STAGING.dbName, `staging D1 name ${d.database_name} is not ${STAGING.dbName}`);
    no('preview_database_id' in d, 'staging D1 must not have a preview_database_id');
  }
  for (const b of sR2) {
    no(b.bucket_name !== STAGING.bucket, `staging bucket ${b.bucket_name} is not ${STAGING.bucket}`);
    no('preview_bucket_name' in b, 'staging R2 must not have a preview_bucket_name');
  }
  // Every binding production has, staging defines itself (wrangler does not inherit bindings per environment;
  // a missing one would make the staging Worker fail, never fall back to production — but keep it explicit).
  for (const p of pDb) no(!sDb.some((s) => s.binding === p.binding), `staging lacks the ${p.binding} D1 binding`);
  for (const p of pR2) no(!sR2.some((s) => s.binding === p.binding), `staging lacks the ${p.binding} R2 binding`);
  // Other binding kinds (KV, queues, services, …) are not used; if one appears, it must be reviewed here first.
  const known = new Set(['env.staging', 'env.staging.vars', 'env.staging.d1_databases', 'env.staging.r2_buckets', 'env.staging.triggers', 'env.staging.observability']);
  for (const t of cfg.tables.filter((t) => t._table.startsWith('env.staging') && !known.has(t._table))) problems.push(`unreviewed staging section [${t._table}]`);
  no(!STAGING.urlHost.test(vars.SITE_URL || ''), `staging SITE_URL is ${vars.SITE_URL}`);

  // Schedules: staging must declare its own triggers (otherwise it inherits production's morning report and
  // reminders), with exactly the backup cron, and BACKUP_CRON must be that same cron.
  const trig = tablesOf(cfg, 'env.staging.triggers');
  let crons = null;
  try { crons = trig.length === 1 ? JSON.parse(trig[0].crons ?? 'null') : null; } catch { crons = null; }
  no(!Array.isArray(crons) || crons.length !== 1 || crons[0] !== STAGING.cron, `staging crons must be exactly ["${STAGING.cron}"] (got ${trig.length === 1 ? trig[0].crons : 'no [env.staging.triggers]'})`);
  no(vars.BACKUP_CRON !== STAGING.cron, `staging BACKUP_CRON must be "${STAGING.cron}" (got ${vars.BACKUP_CRON})`);
  no(vars.MORNING_CRON === STAGING.cron, 'staging MORNING_CRON must not equal the staging cron');

  // The staging marker that turns off every outside service in the Worker (worker/src/egress.js), and never on
  // production.
  no(vars.DEPLOY_ENV !== 'staging', `staging DEPLOY_ENV must be "staging" (got ${vars.DEPLOY_ENV})`);
  const prodVars = tablesOf(cfg, 'vars')[0] || {};
  no('DEPLOY_ENV' in prodVars, 'production [vars] must not set DEPLOY_ENV');
  // No outside-service credential may be written into the staging config as a plain var.
  for (const k of OUTSIDE_SERVICE_VARS) no(k in vars, `staging must not set ${k}`);

  // No production identifier anywhere in the staging part of the file.
  const stagingText = text.slice(text.search(/^\[env\.staging\]/m));
  for (const [what, re] of productionPatterns()) no(re.test(stagingText), `staging section names the production ${what}`);
  return problems;
}

function productionPatterns() {
  return [
    ['D1 id', new RegExp(PRODUCTION.dbId, 'i')],
    ['bucket', /(^|[^a-z0-9-])saydaliti-files(?![a-z0-9-])/i],
    ['Worker or D1 name', /"saydaliti"/],
    ['URL', new RegExp(PRODUCTION.url.replace(/\./g, '\\.'), 'i')],
  ];
}

// ---------- wrangler commands ----------
// Allowlist. Anything else (create, delete, rollback, tail of another worker, …) is refused.
const READS = [
  ['whoami'],
  ['d1', 'info'],
  ['d1', 'migrations', 'list'],
  ['d1', 'execute'], // only SELECT/WITH (checked below)
  ['secret', 'list'],
  ['r2', 'object', 'get'],
  ['r2', 'bucket', 'info'],
  ['deployments', 'list'],
];
// Writes are allowed only in these exact forms (no extra options: e.g. `deploy --route …` or `--var …`
// could change routes or bindings outside wrangler.toml).
const WRITES = [
  ['deploy'],
  ['d1', 'migrations', 'apply', 'DB', '--remote'],
  ['secret', 'put', 'BACKUP_KEY'],
  ['secret', 'put', 'PIN_PEPPER'],
  ['secret', 'put', 'AUDIT_SEAL_KEY'],
];
const WRITE_VERBS = [['deploy'], ['d1', 'migrations', 'apply'], ['secret', 'put'], ['versions'], ['rollback'], ['delete'], ['triggers'], ['r2', 'object', 'put'], ['d1', 'create'], ['d1', 'delete'], ['r2', 'bucket', 'create'], ['r2', 'bucket', 'delete'], ['secret', 'delete'], ['secret', 'bulk']];
const startsWith = (args, cmd) => cmd.every((c, i) => args[i] === c);

export function checkWranglerArgs(args, { markerOk = false } = {}) {
  if (!Array.isArray(args) || !args.length) fail('no wrangler command');
  const write = WRITES.find((c) => c.length === args.length && startsWith(args, c));
  const read = !WRITE_VERBS.some((c) => startsWith(args, c)) && READS.find((c) => startsWith(args, c));
  if (!write && !read) fail(`wrangler ${args.slice(0, 4).join(' ')} is not on the staging allowlist (writes are allowed only in their exact reviewed form)`);

  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    // The environment is added here, always; nobody else picks it, and no other config file or name may be given.
    if (/^(--env|-e|--config|-c|--name|--script-name|--account-id|--env-file|--route|--routes|--domain|--domains|--triggers|--schedule|--var|--define|--assets|--site|--persist-to|--preview)(=|$)/.test(a)) fail(`option ${a.split('=')[0]} is not allowed (the guard sets the environment)`);
    for (const [what, re] of productionPatterns()) if (re.test(a) || (what === 'Worker or D1 name' && a === PRODUCTION.dbName)) fail(`argument names the production ${what}: refused`);
  }
  // D1 commands: only the staging binding, by its binding name.
  if (args[0] === 'd1') {
    const target = args[args[1] === 'migrations' ? 3 : 2];
    if (target !== 'DB') fail(`D1 commands must name the binding DB (got ${target})`);
    if (args.includes('--remote') && args.includes('--local')) fail('both --remote and --local');
  }
  if (startsWith(args, ['d1', 'execute'])) {
    if (args.some((a) => /^--file(=|$)/.test(a))) fail('d1 execute --file is not allowed on staging (reads only)');
    const i = args.indexOf('--command');
    const sql = i >= 0 ? String(args[i + 1] || '') : '';
    if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /;\s*\S/.test(sql) || /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA|VACUUM)\b/i.test(sql)) fail('d1 execute: only a single SELECT is allowed');
  }
  if (args[0] === 'r2') {
    const path = args[3] || '';
    if (args[1] === 'object' && !path.startsWith(`${STAGING.bucket}/`)) fail(`r2 object path must be in ${STAGING.bucket}`);
    if (args[1] === 'object') {
      // Only the backup download: one key under backups/, from the remote bucket, into the one fixed file.
      if (!/^backups\/[0-9a-f-]{36}\/[A-Za-z0-9-]+\.sdbk$/.test(path.slice(STAGING.bucket.length + 1))) fail('r2 object get: only a staging backup file may be read');
      const opts = args.slice(4);
      if (opts.length !== 3 || opts[0] !== '--remote' || opts[1] !== '--file' || opts[2] !== BACKUP_FILE) fail(`r2 object get: exactly --remote --file ${BACKUP_FILE}`);
    }
    if (args[1] === 'bucket' && path !== STAGING.bucket) fail(`r2 bucket must be ${STAGING.bucket}`);
  }
  if (write && !markerOk) fail(`wrangler ${write.join(' ')} refused: the remote staging check has not passed for this commit`);
  return [...args, '--env', 'staging'];
}

// The exact command line every guarded wrangler call runs (read-only proof and writes alike).
export function guardedArgv(args, { markerOk = false, worker = WORKER } = {}) {
  assertSingleConfig(worker);
  return ['wrangler', ...checkWranglerArgs(args, { markerOk }), '--config', join(resolve(worker), 'wrangler.toml')];
}
// The Wrangler installed by `npm ci` in worker/ (exact version from package-lock.json), run with this Node. Never
// `npx wrangler`: npx downloads the latest Wrangler from the registry when none is installed, and on Windows
// `npx` is a .cmd file that execFileSync cannot start without a shell.
export function wranglerBin(worker = WORKER) {
  const bin = join(resolve(worker), 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(bin)) fail('the Worker tools are not installed (run npm ci in worker/); refusing to fetch Wrangler with npx');
  return bin;
}
const wrangler = (args, opts) => execFileSync(process.execPath, [wranglerBin(), ...guardedArgv(args, { markerOk: opts?.markerOk }).slice(1)], { cwd: WORKER, ...opts?.exec });

export function markerValid(sha = process.env.GITHUB_SHA || 'local') {
  if (!existsSync(MARKER)) return false;
  try {
    const m = JSON.parse(readFileSync(MARKER, 'utf8'));
    return m.ok === true && m.sha === sha && m.dbId === STAGING.dbId && m.bucket === STAGING.bucket;
  } catch { return false; }
}

// ---------- backup hand-over (fixed files; nothing from them reaches a command line unchecked) ----------
function plainFileOrMissing(path, what) {
  let st;
  try { st = lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!st.isFile() || st.isSymbolicLink()) fail(`${what} must be a plain file (not a link or folder)`);
  return st;
}
export function backupDirOk(dir = BACKUP_DIR) {
  let st;
  try { st = lstatSync(dir); } catch { fail(`${dir} is missing`); }
  if (!st.isDirectory() || st.isSymbolicLink()) fail(`${dir} must be a plain folder (not a link)`);
}
// The request the token-free script wrote: two ids, nothing else.
export function readBackupRequest(file = BACKUP_REQUEST, dir = BACKUP_DIR) {
  backupDirOk(dir);
  const st = plainFileOrMissing(file, 'the backup request');
  if (!st) fail('no backup request (the backup step did not run or failed)');
  if (st.size > 1024) fail('the backup request is too large');
  let req;
  try { req = JSON.parse(readFileSync(file, 'utf8')); } catch { fail('the backup request is not JSON'); }
  const keys = Object.keys(req || {}).sort().join(',');
  if (keys !== 'backupId,pharmacyId') fail('the backup request must hold exactly backupId and pharmacyId');
  if (!UUID.test(req.pharmacyId) || !UUID.test(req.backupId)) fail('the backup request ids must be UUIDs');
  return { pharmacyId: req.pharmacyId, backupId: req.backupId };
}
// The R2 key the staging D1 lists for that backup must be the one the Worker makes for it
// (worker/src/backup.js: backups/<pharmacy>/<time>-<first 8 of the id>.sdbk).
export function backupKeyOk(key, { pharmacyId, backupId }) {
  const re = new RegExp(`^backups/${pharmacyId}/\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-${backupId.slice(0, 8)}\\.sdbk$`);
  return typeof key === 'string' && re.test(key);
}
export function backupSelect({ pharmacyId, backupId }) {
  if (!UUID.test(pharmacyId) || !UUID.test(backupId)) fail('ids must be UUIDs');
  return `SELECT r2_key FROM backups WHERE id = '${backupId}' AND pharmacy_id = '${pharmacyId}' AND status = 'ok'`;
}

async function fetchBackup() {
  credentials();
  const req = readBackupRequest();
  const out = wrangler(['d1', 'execute', 'DB', '--remote', '--json', '--command', backupSelect(req)], { exec: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] } });
  let rows;
  try { rows = JSON.parse(out)?.[0]?.results; } catch { fail('could not read the backup row'); }
  if (!Array.isArray(rows) || rows.length !== 1) fail(`expected exactly one good backup row, got ${Array.isArray(rows) ? rows.length : 'none'}`);
  const key = rows[0].r2_key;
  if (!backupKeyOk(key, req)) fail('the backup row has an unexpected R2 key');
  for (const f of [BACKUP_FILE, BACKUP_META]) if (plainFileOrMissing(f, f)) unlinkSync(f);
  wrangler(['r2', 'object', 'get', `${STAGING.bucket}/${key}`, '--remote', '--file', BACKUP_FILE], { exec: { stdio: ['ignore', 'pipe', 'pipe'] } });
  const st = plainFileOrMissing(BACKUP_FILE, 'the downloaded backup');
  if (!st || st.size < 41 || st.size > BACKUP_MAX_BYTES) fail('the downloaded backup is missing or has an impossible size');
  const bytes = readFileSync(BACKUP_FILE);
  if (bytes.subarray(0, 4).toString() !== 'SDBK') fail('the downloaded file is not a backup');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(BACKUP_META, JSON.stringify({ ...req, bytes: bytes.length, sha256 }));
  console.log(`staging backup downloaded: ${bytes.length} bytes, sha256 ${sha256}`);
}

// ---------- Cloudflare (read-only, staging resources only) ----------
function credentials() {
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token) fail('CLOUDFLARE_API_TOKEN (from the staging secret) is not set');
  if (!account || !/^[0-9a-f]{32}$/.test(account)) fail('CLOUDFLARE_ACCOUNT_ID is missing or not a Cloudflare account id');
  if (process.env.CLOUDFLARE_STAGING_TOKEN_SOURCE !== 'CLOUDFLARE_STAGING_API_TOKEN') fail('the token was not taken from CLOUDFLARE_STAGING_API_TOKEN');
  return { token, account };
}
async function cf(path) {
  const { token } = credentials();
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}` } });
  let body = {};
  try { body = await res.json(); } catch {}
  return { status: res.status, ok: res.ok && body.success === true, result: body.result, errors: (body.errors || []).map((e) => `${e.code} ${e.message}`) };
}

// The Cloudflare API part of the remote proof. `get` is the API reader (a fake one in the tests).
export async function verifyRemote(get, account) {
  const v = await get('/user/tokens/verify');
  if (!v.ok || v.result?.status !== 'active') fail(`the staging token is not active (${v.status} ${v.errors.join('; ')})`);
  if (v.result?.expires_on) console.log('staging token expires:', v.result.expires_on);
  else console.log('::warning::the staging token has no expiry date; consider setting one');

  // The token must see exactly one account, the configured one (a token that reaches several accounts is
  // broader than this workflow needs). D1 UUIDs are unique, so finding the staging UUID there pins the account.
  const acc = await get('/accounts?per_page=50');
  if (!acc.ok) fail(`cannot list the token's accounts (${acc.status} ${acc.errors.join('; ')})`);
  const ids = (acc.result || []).map((a) => a.id);
  if (ids.length !== 1 || ids[0] !== account) fail(`the staging token must see exactly one account, CLOUDFLARE_STAGING_ACCOUNT_ID (it sees ${ids.length}${ids.includes(account) ? ', including it' : ', not including it'})`);

  const db = await get(`/accounts/${account}/d1/database/${STAGING.dbId}`);
  if (!db.ok) fail(`the staging D1 ${STAGING.dbId} is not reachable in this account (${db.status} ${db.errors.join('; ')})`);
  if (db.result?.uuid !== STAGING.dbId || db.result?.name !== STAGING.dbName) fail(`D1 ${STAGING.dbId} is "${db.result?.name}", not ${STAGING.dbName}`);

  const r2 = await get(`/accounts/${account}/r2/buckets/${STAGING.bucket}`);
  if (!r2.ok || r2.result?.name !== STAGING.bucket) fail(`the staging bucket ${STAGING.bucket} is not reachable (${r2.status} ${r2.errors.join('; ')})`);
  return true;
}

async function remote() {
  const { account } = credentials();
  await verifyRemote(cf, account);

  // Wrangler resolves the binding to the same database (same file, same environment the wrapper forces).
  const info = JSON.parse(wrangler(['d1', 'info', 'DB', '--json'], { exec: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] } }));
  if (info.uuid !== STAGING.dbId || info.uuid === PRODUCTION.dbId) fail(`wrangler resolved DB to ${info.uuid}, not the staging database`);

  writeFileSync(MARKER, JSON.stringify({ ok: true, sha: process.env.GITHUB_SHA || 'local', dbId: STAGING.dbId, bucket: STAGING.bucket, worker: STAGING.worker, at: new Date().toISOString() }));
  console.log(`staging preflight OK: D1 ${STAGING.dbName} ${STAGING.dbId}, R2 ${STAGING.bucket}, Worker ${STAGING.worker}`);
}

async function schedules() {
  const { account } = credentials();
  const s = await cf(`/accounts/${account}/workers/scripts/${STAGING.worker}/schedules`);
  console.log('success:', s.ok, 'schedules:', JSON.stringify((s.result?.schedules || []).map((x) => x.cron)), s.errors.length ? `errors: ${s.errors.join('; ')}` : '');
  const got = (s.result?.schedules || []).map((x) => x.cron);
  if (!s.ok || got.length !== 1 || got[0] !== STAGING.cron) fail(`the staging Worker's schedules are ${JSON.stringify(got)}, expected ["${STAGING.cron}"]`);
}

// ---------- CLI ----------
async function main(argv) {
  const [mode, ...rest] = argv;
  // Every mode first checks the one config file (and that no other could be read) and the scheduled handler.
  loadCheckedConfig();
  if (mode === 'config') {
    console.log('wrangler.toml: staging is isolated from production; the staging cron reaches only the backups');
  } else if (mode === 'remote') {
    await remote();
  } else if (mode === 'schedules') {
    await schedules();
  } else if (mode === 'fetch-backup') {
    await fetchBackup();
  } else if (mode === 'run') {
    const args = rest[0] === '--' ? rest.slice(1) : rest;
    const markerOk = markerValid();
    guardedArgv(args, { markerOk }); // refuse before touching credentials
    credentials();
    wrangler(args, { markerOk, exec: { stdio: 'inherit' } });
  } else {
    fail('usage: staging-guard.mjs config | remote | schedules | fetch-backup | run -- <wrangler args>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`::error::staging guard: ${e instanceof GuardError ? e.message : 'command failed'}`);
    process.exit(1);
  });
}
