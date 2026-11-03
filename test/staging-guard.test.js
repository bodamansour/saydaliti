// The staging guard refuses anything that names or could reach production, and refuses writes until the
// remote staging check has passed. Pure checks only: no wrangler, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { checkConfig, checkWranglerArgs, verifyRemote, STAGING, PRODUCTION } from '../worker/scripts/staging-guard.mjs';

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
    'production Worker name': staging((p) => p.replace('name = "saydaliti-staging"', 'name = "saydaliti"')),
    'production URL': staging((p) => p.replace('https://saydaliti-staging.mosaedapp.workers.dev', 'https://saydaliti.mosaedapp.workers.dev')),
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
  checkWranglerArgs(['r2', 'object', 'get', `${STAGING.bucket}/backups/p/1.sdbk`, '--remote', '--file', 'x']);
  checkWranglerArgs(['secret', 'list', '--format', 'json']);
});

test('wrangler: writes need the remote check for this commit', () => {
  for (const args of [['deploy'], ['d1', 'migrations', 'apply', 'DB', '--remote'], ['secret', 'put', 'BACKUP_KEY']]) {
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
    ['deploy', '--name', 'saydaliti'],
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
    ['deploy', '--var', 'SITE_URL:https://saydaliti.mosaedapp.workers.dev'],
    ['deploy', '--triggers', '* * * * *'],
    ['deploy', 'src/other.js'],
    ['d1', 'migrations', 'apply', 'DB'],
    ['d1', 'migrations', 'apply', 'DB', '--remote', '--persist-to', 'x'],
    ['secret', 'put', 'BACKUP_KEY', '--name', 'saydaliti'],
    ['secret', 'bulk', 'x.json'],
    ['triggers', 'deploy'],
    ['versions', 'deploy'],
    ['deployments', 'list', '--name', 'saydaliti'],
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
