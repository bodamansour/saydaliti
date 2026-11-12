// The staging guard refuses anything that names or could reach production, and refuses writes until the
// remote staging check has passed. Pure checks only: no wrangler, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { symlinkSync } from 'node:fs';
const PH = '11111111-2222-4333-8444-555555555555', BK = 'abcdef12-0000-4000-8000-000000000000';
import { tmpdir } from 'node:os';
import { checkConfig, checkWranglerArgs, verifyRemote, alternativeConfigs, guardedArgv, wranglerBin, checkScheduledHandler, readBackupRequest, backupKeyOk, backupSelect, STAGING, PRODUCTION, WORKER, CONFIG, BACKUP_FILE, BACKUP_DIR } from '../worker/scripts/staging-guard.mjs';

const toml = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');
const staging = (fn) => toml.replace(/^\[env\.staging\][\s\S]*$/m, (part) => fn(part));

test('the real wrangler.toml passes', () => {
  assert.deepEqual(checkConfig(toml), []);
});

test('config: any production resource in [env.staging] is refused', () => {
  const cases = {
    'production D1 id': staging((p) => p.replace(STAGING.dbId, PRODUCTION.dbId)),
    'production D1 name': staging((p) => p.replace(`database_name = "${STAGING.dbName}"`, 'database_name = "saydaliti"')),
    'production bucket': staging((p) => p.replace(`bucket_name = "${STAGING.bucket}"`, 'bucket_name = "saydaliti-files"')),
    'production Worker name': staging((p) => p.replace('name = "tablix-staging"', 'name = "tablix"')),
    'production URL': staging((p) => p.replace('https://tablix-staging.tablixpharma.workers.dev', 'https://tablix.tablixpharma.workers.dev')),
    'a route': staging((p) => p.replace('workers_dev = true', 'workers_dev = true\nroutes = ["example.com/*"]')),
    'no workers.dev': staging((p) => p.replace('workers_dev = true', 'workers_dev = false')),
    'a preview database': staging((p) => p.replace(`database_id = "${STAGING.dbId}"`, `database_id = "${STAGING.dbId}"\npreview_database_id = "${PRODUCTION.dbId}"`)),
    'a second D1 binding': staging((p) => `${p}\n[[env.staging.d1_databases]]\nbinding = "OLD"\ndatabase_name = "x"\ndatabase_id = "${PRODUCTION.dbId}"\n`),
    'no R2 binding': staging((p) => p.replace(/\[\[env\.staging\.r2_buckets\]\][^[]*/, '')),
    'an unreviewed binding kind': staging((p) => `${p}\n[[env.staging.kv_namespaces]]\nbinding = "KV"\nid = "abc"\n`),
    'no staging section': toml.replace(/^\[env\.staging\][\s\S]*$/m, ''),
    'production moved': toml.replace(`database_id = "${PRODUCTION.dbId}"`, `database_id = "${STAGING.dbId}"`),
  };
  for (const [what, text] of Object.entries(cases)) assert.ok(checkConfig(text).length > 0, what);
});

test('wrangler: the guard adds --env staging and allows listed reads', () => {
  assert.deepEqual(checkWranglerArgs(['d1', 'info', 'DB', '--json']), ['d1', 'info', 'DB', '--json', '--env', 'staging']);
  assert.deepEqual(checkWranglerArgs(['d1', 'migrations', 'list', 'DB', '--remote']).slice(-2), ['--env', 'staging']);
  checkWranglerArgs(['d1', 'execute', 'DB', '--remote', '--command', 'SELECT id FROM d1_migrations ORDER BY id']);
  checkWranglerArgs(['r2', 'object', 'get', `${STAGING.bucket}/backups/${PH}/2026-11-03T21-50-49-123Z-abcdef12.sdbk`, '--remote', '--file', BACKUP_FILE]);
  checkWranglerArgs(['secret', 'list', '--format', 'json']);
});

test('wrangler: writes need the remote check for this commit', () => {
  for (const args of [['deploy'], ['d1', 'migrations', 'apply', 'DB', '--remote'], ['secret', 'put', 'BACKUP_KEY'], ['secret', 'put', 'AUDIT_SEAL_KEY']]) {
    assert.throws(() => checkWranglerArgs(args), /remote staging check/, args.join(' '));
    assert.deepEqual(checkWranglerArgs(args, { markerOk: true }).slice(-2), ['--env', 'staging']);
  }
});

test('wrangler: production names, other environments, other configs and unlisted commands are refused', () => {
  const ok = { markerOk: true };
  const refused = [
    ['d1', 'migrations', 'apply', 'saydaliti', '--remote'],
    ['d1', 'execute', PRODUCTION.dbId, '--remote', '--command', 'SELECT 1'],
    ['d1', 'execute', 'saydaliti-staging', '--remote', '--command', 'SELECT 1'],
    ['r2', 'object', 'get', 'saydaliti-files/backups/x', '--remote'],
    ['r2', 'object', 'get', 'other-bucket/x', '--remote'],
    ['deploy', '--env', 'production'],
    ['deploy', '--env='],
    ['deploy', '-e', 'staging'],
    ['deploy', '--config', 'other.toml'],
    ['deploy', '--name', 'tablix'],
    ['deploy', '--account-id', '0'.repeat(32)],
    ['d1', 'create', 'x'],
    ['d1', 'delete', 'DB'],
    ['r2', 'bucket', 'create', STAGING.bucket],
    ['r2', 'bucket', 'delete', STAGING.bucket],
    ['r2', 'object', 'put', `${STAGING.bucket}/x`],
    ['r2', 'object', 'delete', `${STAGING.bucket}/x`],
    ['secret', 'delete', 'BACKUP_KEY'],
    ['secret', 'put', 'WHATSAPP_TOKEN'],
    ['rollback'],
    ['versions', 'upload'],
    ['delete'],
    ['d1', 'execute', 'DB', '--remote', '--command', 'DELETE FROM sales'],
    ['d1', 'execute', 'DB', '--remote', '--command', 'SELECT 1; DROP TABLE sales'],
    ['d1', 'execute', 'DB', '--remote', '--file', 'x.sql'],
    ['d1', 'execute', 'DB', '--remote', '--local', '--command', 'SELECT 1'],
    // writes only in their exact reviewed form
    ['deploy', '--route', 'pharmacy.example/*'],
    ['deploy', '--routes=pharmacy.example/*'],
    ['deploy', '--domain', 'pharmacy.example'],
    ['deploy', '--var', 'SITE_URL:https://tablix.tablixpharma.workers.dev'],
    ['deploy', '--triggers', '* * * * *'],
    ['deploy', 'src/other.js'],
    ['d1', 'migrations', 'apply', 'DB'],
    ['d1', 'migrations', 'apply', 'DB', '--remote', '--persist-to', 'x'],
    ['secret', 'put', 'BACKUP_KEY', '--name', 'tablix'],
    ['secret', 'bulk', 'x.json'],
    ['triggers', 'deploy'],
    ['versions', 'deploy'],
    ['deployments', 'list', '--name', 'tablix'],
    [],
  ];
  for (const args of refused) assert.throws(() => checkWranglerArgs(args, ok), undefined, args.join(' '));
});

test('remote proof: the token must be active, see exactly the staging account, and reach the staging D1 and R2', async () => {
  const account = 'a'.repeat(32);
  const good = {
    '/user/tokens/verify': { ok: true, result: { status: 'active', expires_on: '2027-01-01T00:00:00Z' } },
    '/accounts?per_page=50': { ok: true, result: [{ id: account }] },
    [`/accounts/${account}/d1/database/${STAGING.dbId}`]: { ok: true, result: { uuid: STAGING.dbId, name: STAGING.dbName } },
    [`/accounts/${account}/r2/buckets/${STAGING.bucket}`]: { ok: true, result: { name: STAGING.bucket } },
  };
  const fake = (over = {}) => async (path) => ({ status: 200, errors: [], ...((path in over ? over : good)[path] || { ok: false, status: 404 }) });
  assert.equal(await verifyRemote(fake(), account), true);
  const bad = {
    'inactive token': { '/user/tokens/verify': { ok: true, result: { status: 'disabled' } } },
    'token sees two accounts': { '/accounts?per_page=50': { ok: true, result: [{ id: account }, { id: 'b'.repeat(32) }] } },
    'token sees another account': { '/accounts?per_page=50': { ok: true, result: [{ id: 'b'.repeat(32) }] } },
    'accounts unreadable': { '/accounts?per_page=50': { ok: false, status: 403 } },
    'staging D1 missing': { [`/accounts/${account}/d1/database/${STAGING.dbId}`]: { ok: false, status: 404 } },
    'D1 renamed': { [`/accounts/${account}/d1/database/${STAGING.dbId}`]: { ok: true, result: { uuid: STAGING.dbId, name: 'saydaliti' } } },
    'staging bucket missing': { [`/accounts/${account}/r2/buckets/${STAGING.bucket}`]: { ok: false, status: 404 } },
  };
  for (const [what, over] of Object.entries(bad)) await assert.rejects(verifyRemote(fake(over), account), undefined, what);
  await assert.rejects(verifyRemote(fake(), 'b'.repeat(32)), undefined, 'a different configured account');
});

test('no script calls wrangler remotely except through the guard', () => {
  const dir = new URL('../worker/scripts/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'staging-guard.mjs')) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const line of src.split('\n').filter((l) => /['"]wrangler['"]/.test(l) && /execFile|spawn|exec\(/.test(l))) {
      assert.ok(/'--local'/.test(line) || /checkWranglerArgs\(/.test(line), `${f}: ${line.trim()}`);
      assert.doesNotMatch(line, /'--remote'/, `${f}: ${line.trim()}`);
    }
  }
});

// ---------- H1: Wrangler must read worker/wrangler.toml and nothing else ----------
// A throwaway tree: <tmp>/repo/worker/wrangler.toml (the real one), plus whatever an attack adds.
function tree() {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  const worker = join(root, 'repo', 'worker');
  mkdirSync(worker, { recursive: true });
  copyFileSync(new URL('../worker/wrangler.toml', import.meta.url), join(worker, 'wrangler.toml'));
  return { root, repo: join(root, 'repo'), worker, done: () => rmSync(root, { recursive: true, force: true }) };
}
// What an attacker would put in an alternative config: production Worker, database, bucket, route and crons.
const PROD_JSON = JSON.stringify({ name: 'tablix', main: 'src/index.js', env: { staging: {
  name: PRODUCTION.worker, routes: ['pharmacy.example/*'], triggers: { crons: ['0 6 * * *', '15 * * * *'] },
  d1_databases: [{ binding: 'DB', database_name: PRODUCTION.dbName, database_id: PRODUCTION.dbId }],
  r2_buckets: [{ binding: 'FILES', bucket_name: PRODUCTION.bucket }] } } });

test('the real checkout has no alternative Wrangler config, and every guarded call names worker/wrangler.toml absolutely', () => {
  assert.deepEqual(alternativeConfigs(), []);
  assert.ok(isAbsolute(CONFIG) && CONFIG === join(WORKER, 'wrangler.toml'));
  const argv = guardedArgv(['d1', 'info', 'DB', '--json']);
  assert.deepEqual(argv.slice(-4), ['--env', 'staging', '--config', CONFIG]);
  assert.deepEqual(guardedArgv(['deploy'], { markerOk: true }), ['wrangler', 'deploy', '--env', 'staging', '--config', CONFIG]);
});

test('the config path does not depend on the current directory', () => {
  const t = tree();
  const before = process.cwd();
  try { process.chdir(t.root); assert.equal(guardedArgv(['d1', 'info', 'DB']).at(-1), CONFIG); } finally { process.chdir(before); t.done(); }
});

test('attack: a wrangler.json / wrangler.jsonc in a parent folder (Wrangler prefers it over wrangler.toml) is refused', () => {
  for (const [where, file] of [['repo', 'wrangler.json'], ['repo', 'wrangler.jsonc'], ['root', 'wrangler.json'], ['worker', 'wrangler.json'], ['worker', 'wrangler.jsonc']]) {
    const t = tree();
    try {
      writeFileSync(join(t[where], file), PROD_JSON);
      assert.ok(alternativeConfigs(t.worker).length > 0, `${where}/${file} detected`);
      // Even a read, and even the read-only proof's own d1 info, is refused; so is every write.
      for (const args of [['d1', 'info', 'DB', '--json'], ['deploy'], ['d1', 'migrations', 'apply', 'DB', '--remote'], ['secret', 'put', 'BACKUP_KEY']]) {
        assert.throws(() => guardedArgv(args, { markerOk: true, worker: t.worker }), /other Wrangler config files/, `${where}/${file}: ${args.join(' ')}`);
      }
    } finally { t.done(); }
  }
});

test('attack: a .wrangler/deploy/config.json redirect (here or in a parent folder) or a .env in worker/ is refused', () => {
  for (const [where, rel] of [['worker', ['.wrangler', 'deploy', 'config.json']], ['repo', ['.wrangler', 'deploy', 'config.json']], ['worker', ['.env']], ['worker', ['.env.local']]]) {
    const t = tree();
    try {
      mkdirSync(join(t[where], ...rel.slice(0, -1)), { recursive: true });
      writeFileSync(join(t[where], ...rel), rel[0] === '.wrangler' ? JSON.stringify({ configPath: '../../prod.json' }) : 'CLOUDFLARE_ENV=production\n');
      assert.throws(() => guardedArgv(['deploy'], { markerOk: true, worker: t.worker }), /other Wrangler config files/, `${where}/${rel.join('/')}`);
    } finally { t.done(); }
  }
});

test('a clean tree passes, and a missing wrangler.toml is refused', () => {
  const t = tree();
  try {
    assert.deepEqual(alternativeConfigs(t.worker), []);
    assert.deepEqual(guardedArgv(['deploy'], { markerOk: true, worker: t.worker }).slice(-2), ['--config', join(t.worker, 'wrangler.toml')]);
    rmSync(join(t.worker, 'wrangler.toml'));
    assert.throws(() => guardedArgv(['deploy'], { markerOk: true, worker: t.worker }), /wrangler\.toml is missing/);
  } finally { t.done(); }
});

// ---------- M2: schedules ----------
test('config: the staging schedule must be exactly the backup cron, and BACKUP_CRON must match it', () => {
  const cases = {
    'no [env.staging.triggers] (would inherit production crons)': staging((p) => p.replace(/\[env\.staging\.triggers\][^[]*/, '')),
    'production crons': staging((p) => p.replace('crons = ["*/30 * * * *"]', 'crons = ["0 6 * * *", "15 * * * *"]')),
    'an extra cron': staging((p) => p.replace('crons = ["*/30 * * * *"]', 'crons = ["*/30 * * * *", "15 * * * *"]')),
    'another cron': staging((p) => p.replace('crons = ["*/30 * * * *"]', 'crons = ["*/15 * * * *"]')),
    'unparseable crons': staging((p) => p.replace('crons = ["*/30 * * * *"]', 'crons = [\n  "*/30 * * * *",\n]')),
    'BACKUP_CRON differs': staging((p) => p.replace('BACKUP_CRON = "*/30 * * * *"', 'BACKUP_CRON = "30 1 * * *"')),
    'no BACKUP_CRON': staging((p) => p.replace(/BACKUP_CRON = "\*\/30 \* \* \* \*"\n/, '')),
    'MORNING_CRON equal to the staging cron': staging((p) => p.replace('MORNING_CRON = "0 6 * * *"', 'MORNING_CRON = "*/30 * * * *"')),
  };
  for (const [what, text] of Object.entries(cases)) assert.ok(checkConfig(text).some((p) => /cron/i.test(p)), what);
  // The staging marker that turns off outside services: required on staging, forbidden on production.
  const marker = {
    'no DEPLOY_ENV': staging((p) => p.replace(/DEPLOY_ENV = "staging"\n/, '')),
    'DEPLOY_ENV production': staging((p) => p.replace('DEPLOY_ENV = "staging"', 'DEPLOY_ENV = "production"')),
    'production [vars] sets DEPLOY_ENV': toml.replace('[vars]\n', '[vars]\nDEPLOY_ENV = "staging"\n'),
    'a WhatsApp token in staging vars': staging((p) => p.replace('DEPLOY_ENV = "staging"', 'DEPLOY_ENV = "staging"\nWHATSAPP_TOKEN = "x"')),
    'an AI key in staging vars': staging((p) => p.replace('DEPLOY_ENV = "staging"', 'DEPLOY_ENV = "staging"\nANTHROPIC_API_KEY = "x"')),
  };
  for (const [what, text] of Object.entries(marker)) assert.ok(checkConfig(text).some((p) => /DEPLOY_ENV|must not set/.test(p)), what);
  assert.deepEqual(checkConfig(toml), []);
});

test('code: the staging cron may reach only the backups (never the patient reminders or the morning report)', () => {
  const good = `import { isolateEnv, guardedFetch } from './egress.js';
  function internalFetch(env) { return async (u, init) => { if (String(u).startsWith('internal://')) return null; return guardedFetch(env)(u, init); }; }
  export default {
  async fetch(req, env) {
    env = isolateEnv(env);
    return new Response('');
  },
  async scheduled(event, env, ctx) {
    env = isolateEnv(env);
    const e = jobEnv(env);
    if (event.cron === env.BACKUP_CRON) { ctx.waitUntil(backupAll(env).then((r) => console.log(r))); return; }
    if (event.cron === env.MORNING_CRON) ctx.waitUntil(runMorning({ env: e }));
    else ctx.waitUntil(runReminders({ env: e }));
  } };`;
  assert.deepEqual(checkScheduledHandler(good), []);
  assert.deepEqual(checkScheduledHandler(good.replace('async fetch(req, env)', 'async fetch(req, env, ctx)')), []);
  const bad = {
    'no backup branch (main before PR #51: every other cron runs the reminders)': `export default { async scheduled(event, env, ctx) {
      if (event.cron === env.MORNING_CRON) ctx.waitUntil(runMorning({}));
      else ctx.waitUntil(runReminders({}));
    } };`,
    'backup branch without return': good.replace('; return; }', '; }'),
    'reminders before the backup check': good.replace('const e = jobEnv(env);', 'const e = jobEnv(env); ctx.waitUntil(runReminders({ env: e }));'),
    'backup check on another variable': good.replace('env.BACKUP_CRON', 'env.MORNING_CRON'),
    'no scheduled handler': 'export default { fetch() {} };',
    // The outside-service kill switch (worker/src/egress.js) must be wired in.
    'scheduled without isolateEnv': good.replace('  async scheduled(event, env, ctx) {\n    env = isolateEnv(env);', '  async scheduled(event, env, ctx) {'),
    'fetch without isolateEnv': good.replace('  async fetch(req, env) {\n    env = isolateEnv(env);', '  async fetch(req, env) {'),
    'isolateEnv after a job starts': good.replace('    env = isolateEnv(env);\n    const e', '    const e').replace("else ctx.waitUntil(runReminders({ env: e }));", "else ctx.waitUntil(runReminders({ env: e }));\n    env = isolateEnv(env);"),
    'jobs use the raw fetch': good.replace('return guardedFetch(env)(u, init);', 'return fetch(u, init);'),
    'egress.js not imported': good.replace("import { isolateEnv, guardedFetch } from './egress.js';", ''),
  };
  for (const [what, src] of Object.entries(bad)) assert.ok(checkScheduledHandler(src).length > 0, what);
});

// ---------- the backup hand-over: guarded download, token-free check ----------
const GOOD_KEY = `backups/${PH}/2026-11-03T21-50-49-123Z-abcdef12.sdbk`;

test('r2: only the guarded backup download — one backup key, from the remote bucket, into the one fixed file', () => {
  const get = (path, ...opts) => ['r2', 'object', 'get', path, ...opts];
  assert.deepEqual(checkWranglerArgs(get(`${STAGING.bucket}/${GOOD_KEY}`, '--remote', '--file', BACKUP_FILE)).slice(-2), ['--env', 'staging']);
  const refused = {
    'another file': get(`${STAGING.bucket}/${GOOD_KEY}`, '--remote', '--file', '/tmp/x.sdbk'),
    'a relative file': get(`${STAGING.bucket}/${GOOD_KEY}`, '--remote', '--file', 'backup.sdbk'),
    'to stdout': get(`${STAGING.bucket}/${GOOD_KEY}`, '--remote', '--pipe'),
    'no --remote (local)': get(`${STAGING.bucket}/${GOOD_KEY}`, '--file', BACKUP_FILE),
    'an extra option': get(`${STAGING.bucket}/${GOOD_KEY}`, '--remote', '--file', BACKUP_FILE, '--jurisdiction', 'eu'),
    'not a backup': get(`${STAGING.bucket}/images/${PH}/a.png`, '--remote', '--file', BACKUP_FILE),
    'path traversal': get(`${STAGING.bucket}/backups/${PH}/../../x.sdbk`, '--remote', '--file', BACKUP_FILE),
    'production bucket': get(`saydaliti-files/${GOOD_KEY}`, '--remote', '--file', BACKUP_FILE),
  };
  for (const [what, args] of Object.entries(refused)) assert.throws(() => checkWranglerArgs(args, { markerOk: true }), undefined, what);
});

test('backup request: exactly two UUIDs, in a plain file inside a plain folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'req-'));
  const dir = join(root, '.staging-backup'), file = join(dir, 'request.json');
  try {
    assert.throws(() => readBackupRequest(file, dir), /missing/);
    mkdirSync(dir);
    assert.throws(() => readBackupRequest(file, dir), /no backup request/);
    writeFileSync(file, JSON.stringify({ pharmacyId: PH, backupId: BK }));
    assert.deepEqual(readBackupRequest(file, dir), { pharmacyId: PH, backupId: BK });
    const bad = {
      'extra field (e.g. a path)': { pharmacyId: PH, backupId: BK, file: '/etc/passwd' },
      'not a UUID': { pharmacyId: PH, backupId: "x' OR 1=1 --" },
      'missing id': { pharmacyId: PH },
    };
    for (const [what, req] of Object.entries(bad)) { writeFileSync(file, JSON.stringify(req)); assert.throws(() => readBackupRequest(file, dir), undefined, what); }
    writeFileSync(file, 'x'.repeat(2000)); assert.throws(() => readBackupRequest(file, dir), /too large/);
    // A link instead of the file, or instead of the folder, is refused.
    rmSync(file); writeFileSync(join(root, 'elsewhere.json'), JSON.stringify({ pharmacyId: PH, backupId: BK }));
    symlinkSync(join(root, 'elsewhere.json'), file); assert.throws(() => readBackupRequest(file, dir), /plain file/);
    const other = join(root, 'other'); mkdirSync(other); const linked = join(root, 'linked');
    symlinkSync(other, linked); assert.throws(() => readBackupRequest(join(linked, 'request.json'), linked), /plain folder/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.ok(BACKUP_FILE.startsWith(BACKUP_DIR) && isAbsolute(BACKUP_FILE) && BACKUP_DIR.startsWith(WORKER));
});

test('backup key and SELECT: only the key the Worker makes for that pharmacy and backup; ids can not inject SQL', () => {
  const req = { pharmacyId: PH, backupId: BK };
  assert.equal(backupKeyOk(GOOD_KEY, req), true);
  for (const k of [`backups/${PH}/../x-abcdef12.sdbk`, `backups/${PH}/2026-11-03T21-50-49-123Z-00000000.sdbk`, `backups/22222222-2222-4333-8444-555555555555/2026-11-03T21-50-49-123Z-abcdef12.sdbk`, `images/${PH}/2026-11-03T21-50-49-123Z-abcdef12.sdbk`, `${GOOD_KEY}x`, null]) assert.equal(backupKeyOk(k, req), false, String(k));
  assert.match(backupSelect(req), /^SELECT r2_key FROM backups WHERE id = '[0-9a-f-]{36}' AND pharmacy_id = '[0-9a-f-]{36}' AND status = 'ok'$/);
  checkWranglerArgs(['d1', 'execute', 'DB', '--remote', '--json', '--command', backupSelect(req)]);
  assert.throws(() => backupSelect({ pharmacyId: PH, backupId: "' OR '1'='1" }));
});

test('the backup-check script never has Cloudflare access: no token, no remote wrangler, no guard call, fixed file paths', () => {
  const src = readFileSync(new URL('../worker/scripts/staging-backup-check.mjs', import.meta.url), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /if \(process\.env\.CLOUDFLARE_API_TOKEN\) \{[^}]*process\.exit\(2\)/, 'it refuses to run with the token');
  assert.doesNotMatch(code.replace("process.env.CLOUDFLARE_API_TOKEN", ''), /CLOUDFLARE|api\.cloudflare\.com/);
  assert.doesNotMatch(code, /--remote|checkWranglerArgs|guardedArgv|staging-guard\.mjs['"]\s*\)|r2['"],\s*['"]object|fetch-backup/);
  const wranglerLines = code.split('\n').filter((l) => /['"]wrangler['"]|wranglerBin\(\)/.test(l) && /execFile|spawn/.test(l));
  assert.ok(wranglerLines.length >= 1, 'the local restore runs Wrangler');
  for (const line of wranglerLines) {
    assert.match(line, /'--local'/); assert.match(line, /'--config', CONFIG/);
  }
  // The downloaded file is read only from the guard's fixed constant; the command line can't name it.
  assert.match(code, /readFile\(BACKUP_FILE\)/);
  assert.doesNotMatch(code, /readFile\((arg|process\.argv)/);
  assert.match(code, /meta\.sha256 !== sha256/, 'checks the file is the one the guard downloaded');
});

// Windows (execFileSync cannot start npx.cmd without a shell) and supply chain (npx downloads the latest Wrangler
// when none is installed): every script and test that runs Wrangler uses the one installed from the lockfile.
test('Wrangler is never started through npx; the guard refuses when the installed Wrangler is missing', () => {
  for (const f of ['../worker/scripts/staging-guard.mjs', '../worker/scripts/staging-backup-check.mjs', '../worker/scripts/restore-drill.mjs', '../worker/test/staging-egress.workerd.test.mjs']) {
    const code = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /(execFile|execFileSync|spawn|spawnSync|exec|execSync)\(\s*['"]npx/, f);
  }
  const t = mkdtempSync(join(tmpdir(), 'guard-bin-'));
  try {
    assert.throws(() => wranglerBin(t), /not installed/);
    mkdirSync(join(t, 'node_modules', 'wrangler', 'bin'), { recursive: true });
    writeFileSync(join(t, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), '');
    assert.equal(wranglerBin(t), join(t, 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
  } finally { rmSync(t, { recursive: true, force: true }); }
});
