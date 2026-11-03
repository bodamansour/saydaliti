// Fail-closed guard for everything the staging workflow does on Cloudflare.
//
//   node scripts/staging-guard.mjs config          wrangler.toml [env.staging] names no production resource
//   node scripts/staging-guard.mjs remote          read-only: the token/account really hold the staging D1 and
//                                                  R2 bucket; writes a marker for this commit (no secrets in it)
//   node scripts/staging-guard.mjs run -- <args>   runs `wrangler <args> --env staging` only if the command is on
//                                                  the allowlist, names no production resource, and (for a write)
//                                                  the remote check passed for this commit
//   node scripts/staging-guard.mjs schedules       read-only: the staging Worker's cron schedules
//
// It never reads, prints or compares the production token, and it never sends a request about a production
// resource. Any doubt → exit 1 before wrangler runs. Tested by test/staging-guard.test.js.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = join(WORKER, '.staging-preflight.json');

// The only resources staging may touch.
export const STAGING = Object.freeze({
  worker: 'saydaliti-staging',
  dbName: 'saydaliti-staging',
  dbId: '0ba7c0dd-645e-453e-9999-a316a828e175',
  bucket: 'saydaliti-files-staging',
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

class GuardError extends Error {}
const fail = (msg) => { throw new GuardError(msg); };

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
const WRITES = [
  ['deploy'],
  ['d1', 'migrations', 'apply'],
  ['secret', 'put'],
];
const startsWith = (args, cmd) => cmd.every((c, i) => args[i] === c);

export function checkWranglerArgs(args, { markerOk = false } = {}) {
  if (!Array.isArray(args) || !args.length) fail('no wrangler command');
  const write = WRITES.find((c) => startsWith(args, c));
  const read = READS.find((c) => startsWith(args, c));
  if (!write && !read) fail(`wrangler ${args.slice(0, 3).join(' ')} is not on the staging allowlist`);

  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    // The environment is added here, always; nobody else picks it, and no other config file or name may be given.
    if (/^(--env|-e|--config|-c|--name|--script-name|--account-id|--env-file)(=|$)/.test(a)) fail(`option ${a.split('=')[0]} is not allowed (the guard sets the environment)`);
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
    if (args[1] === 'bucket' && path !== STAGING.bucket) fail(`r2 bucket must be ${STAGING.bucket}`);
  }
  if (startsWith(args, ['secret', 'put']) && !['BACKUP_KEY', 'PIN_PEPPER'].includes(args[2])) fail(`secret ${args[2]} is not a staging secret this workflow sets`);
  if (write && !markerOk) fail(`wrangler ${write.join(' ')} refused: the remote staging check has not passed for this commit`);
  return [...args, '--env', 'staging'];
}

export function markerValid(sha = process.env.GITHUB_SHA || 'local') {
  if (!existsSync(MARKER)) return false;
  try {
    const m = JSON.parse(readFileSync(MARKER, 'utf8'));
    return m.ok === true && m.sha === sha && m.dbId === STAGING.dbId && m.bucket === STAGING.bucket;
  } catch { return false; }
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

async function remote() {
  const { account } = credentials();
  const v = await cf('/user/tokens/verify');
  if (!v.ok || v.result?.status !== 'active') fail(`the staging token is not active (${v.status} ${v.errors.join('; ')})`);
  if (v.result?.expires_on) console.log('staging token expires:', v.result.expires_on);
  else console.log('::warning::the staging token has no expiry date; consider setting one');

  const db = await cf(`/accounts/${account}/d1/database/${STAGING.dbId}`);
  if (!db.ok) fail(`the staging D1 ${STAGING.dbId} is not reachable in this account (${db.status} ${db.errors.join('; ')})`);
  if (db.result?.uuid !== STAGING.dbId || db.result?.name !== STAGING.dbName) fail(`D1 ${STAGING.dbId} is "${db.result?.name}", not ${STAGING.dbName}`);

  const r2 = await cf(`/accounts/${account}/r2/buckets/${STAGING.bucket}`);
  if (!r2.ok || r2.result?.name !== STAGING.bucket) fail(`the staging bucket ${STAGING.bucket} is not reachable (${r2.status} ${r2.errors.join('; ')})`);

  // Wrangler resolves the binding to the same database (same file, same environment the wrapper forces).
  const info = JSON.parse(execFileSync('npx', ['wrangler', ...checkWranglerArgs(['d1', 'info', 'DB', '--json'])], { cwd: WORKER, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (info.uuid !== STAGING.dbId || info.uuid === PRODUCTION.dbId) fail(`wrangler resolved DB to ${info.uuid}, not the staging database`);

  writeFileSync(MARKER, JSON.stringify({ ok: true, sha: process.env.GITHUB_SHA || 'local', dbId: STAGING.dbId, bucket: STAGING.bucket, worker: STAGING.worker, at: new Date().toISOString() }));
  console.log(`staging preflight OK: D1 ${STAGING.dbName} ${STAGING.dbId}, R2 ${STAGING.bucket}, Worker ${STAGING.worker}`);
}

async function schedules() {
  const { account } = credentials();
  const s = await cf(`/accounts/${account}/workers/scripts/${STAGING.worker}/schedules`);
  console.log('success:', s.ok, 'schedules:', JSON.stringify((s.result?.schedules || []).map((x) => x.cron)), s.errors.length ? `errors: ${s.errors.join('; ')}` : '');
  if (!s.ok) process.exitCode = 1;
}

// ---------- CLI ----------
async function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === 'config') {
    const problems = checkConfig(readFileSync(join(WORKER, 'wrangler.toml'), 'utf8'));
    if (problems.length) fail(`wrangler.toml:\n  - ${problems.join('\n  - ')}`);
    console.log('wrangler.toml: staging is isolated from production');
  } else if (mode === 'remote') {
    const problems = checkConfig(readFileSync(join(WORKER, 'wrangler.toml'), 'utf8'));
    if (problems.length) fail(`wrangler.toml:\n  - ${problems.join('\n  - ')}`);
    await remote();
  } else if (mode === 'schedules') {
    await schedules();
  } else if (mode === 'run') {
    const args = rest[0] === '--' ? rest.slice(1) : rest;
    const full = checkWranglerArgs(args, { markerOk: markerValid() });
    credentials();
    execFileSync('npx', ['wrangler', ...full], { cwd: WORKER, stdio: 'inherit' });
  } else {
    fail('usage: staging-guard.mjs config | remote | schedules | run -- <wrangler args>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`::error::staging guard: ${e instanceof GuardError ? e.message : 'command failed'}`);
    process.exit(1);
  });
}
