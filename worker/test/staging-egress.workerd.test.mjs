// M1 in the real Workers runtime (workerd, through Miniflare), not only in Node: on staging nothing leaves the
// Worker — not from ordinary requests, the AI route or the scheduled jobs — even with fake outside-service keys set;
// on production the same code still reaches the network. Every outbound request is captured by Miniflare's
// outboundService (nothing really goes out); an empty capture list on staging is the proof, and the production
// case shows the capture works.
// Needs the Worker's tools (npm ci in worker/); skipped without them. Synthetic data, local D1/R2 in a temp folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(WORKER, 'wrangler.toml');
const STAGING_DB_ID = '0ba7c0dd-645e-453e-9999-a316a828e175';
const req = createRequire(join(WORKER, 'package.json'));
let tools = null;
try { tools = { miniflare: req.resolve('miniflare'), esbuild: req.resolve('esbuild') }; } catch { /* not installed */ }
const skip = !tools && 'worker tools not installed (run npm ci in worker/)';

const FAKE_OUTSIDE = { ANTHROPIC_API_KEY: 'fake-anthropic-not-real', AI_MODEL: 'x', WHATSAPP_TOKEN: 'fake-wa-not-real', WHATSAPP_PHONE_ID: '1', NEW_VENDOR_API_KEY: 'fake-new-not-real' };
const COMMON = { MORNING_CRON: '0 6 * * *', PBKDF2_ITER: '1000', SIGNUP_PER_HOUR: '10000', PIN_PEPPER: 'test-pepper-not-real', ...FAKE_OUTSIDE };
const STAGING_VARS = { ...COMMON, DEPLOY_ENV: 'staging', BACKUP_CRON: '*/30 * * * *', SITE_URL: 'https://saydaliti-staging.mosaedapp.workers.dev' };
const PROD_VARS = { ...COMMON, SITE_URL: 'https://saydaliti.mosaedapp.workers.dev' };
const PROBES = ['https://egress-probe.invalid/https', 'http://egress-probe.invalid/http', 'http://203.0.113.7/ip'];

let dir, scriptPath, Miniflare, convertV4MiniflareOptions;

before(async () => {
  if (skip) return;
  ({ Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(tools.miniflare).href));
  const esbuild = req(tools.esbuild);
  dir = mkdtempSync(join(tmpdir(), 'egress-workerd-'));
  // Schema: the real migrations, applied locally (--local: no Cloudflare call; telemetry off).
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--env', 'staging', '--persist-to', dir, '--config', CONFIG],
    { cwd: WORKER, stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '' } });
  // The real Worker, wrapped with two probe routes that only this test has.
  const entry = join(dir, 'probe-entry.mjs');
  writeFileSync(entry, `
import worker from ${JSON.stringify(join(WORKER, 'src/index.js'))};
import { isolateEnv, STAGING_FETCH } from ${JSON.stringify(join(WORKER, 'src/egress.js'))};
export default {
  async fetch(req, env, ctx) {
    const p = new URL(req.url).pathname;
    if (p === '/__probe/env') {
      const s = isolateEnv(env);
      const one = await s.DB.prepare('SELECT 1 AS one').first();
      await s.FILES.put('probe/x', 'y');
      const back = await (await s.FILES.get('probe/x')).text();
      const asset = await (await s.ASSETS.fetch(new Request('http://assets/index.html'))).text();
      return Response.json({ keys: Object.keys(s).sort(), one: one.one, r2: back, asset, globalFetchGuarded: globalThis.fetch === STAGING_FETCH });
    }
    if (p === '/__probe/global-fetch') {
      isolateEnv(env);
      const out = {};
      for (const u of ${JSON.stringify(PROBES)}) { try { out[u] = (await fetch(u)).status; } catch (e) { out[u] = 'threw'; } }
      return Response.json(out);
    }
    return worker.fetch(req, env, ctx);
  },
  scheduled: (e, env, ctx) => worker.scheduled(e, env, ctx),
};`);
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'], external: ['node:*'], write: false, logLevel: 'silent' });
  scriptPath = join(dir, 'bundle.mjs');
  writeFileSync(scriptPath, out.outputFiles[0].text);
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

async function start(vars) {
  const outbound = [];
  // Miniflare 5 (beta) takes a new options shape; the familiar v4 one is converted, then every outbound request
  // of the Worker is sent to the capture handler.
  const opts = convertV4MiniflareOptions({
    modules: true, scriptPath, modulesRoot: dir, compatibilityDate: '2025-09-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: STAGING_DB_ID },
    r2Buckets: ['FILES'],
    serviceBindings: { ASSETS: () => new Response('asset-ok') },
    bindings: vars,
  });
  assert.equal(opts.workers.length, 1);
  opts.resourcePersistencePath = join(dir, 'v3');   // where `wrangler d1 migrations apply --persist-to` wrote the schema
  opts.workers[0].dev.outboundService = { type: 'fetcher', handler: (r) => { outbound.push(r.url); return new Response('captured', { status: 599 }); } };
  const mf = new Miniflare(opts);
  const call = async (path, init) => { const r = await mf.dispatchFetch(`http://local${path}`, init); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { mf, outbound, call };
}
const signup = async (call) => {
  const r = await call('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `egress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, password: 'password123' }) });
  assert.ok(r.body?.data?.access_token, `signed in (synthetic account): ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.access_token;
};

test('staging, in workerd: only allowlisted keys reach the code; D1, R2 and ASSETS still work', { skip }, async () => {
  const { mf, outbound, call } = await start(STAGING_VARS);
  try {
    const { body } = await call('/__probe/env');
    assert.deepEqual(body.keys, ['ASSETS', 'BACKUP_CRON', 'DB', 'DEPLOY_ENV', 'FILES', 'MORNING_CRON', 'PBKDF2_ITER', 'PIN_PEPPER', 'SIGNUP_PER_HOUR', 'SITE_URL']);
    for (const k of Object.keys(FAKE_OUTSIDE)) assert.ok(!body.keys.includes(k), `${k} never reaches the code`);
    assert.equal(body.one, 1, 'D1 binding works after isolation');
    assert.equal(body.r2, 'y', 'R2 binding works after isolation');
    assert.equal(body.asset, 'asset-ok', 'ASSETS binding works after isolation');
    assert.equal(body.globalFetchGuarded, true, 'the global fetch is replaced in the staging Worker');
    assert.deepEqual(outbound, []);
  } finally { await mf.dispose(); }
});

test('staging, in workerd: /api/ai with a fake key set makes no outside request; http, https and raw IP are refused; the scheduled jobs send nothing', { skip }, async () => {
  const { mf, outbound, call } = await start(STAGING_VARS);
  try {
    assert.equal((await call('/api/ai/status')).body.data.enabled, false, 'the AI key is not visible on staging');
    const token = await signup(call);
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const ai = await call('/api/ai', { method: 'POST', headers: auth, body: JSON.stringify({ pharmacy: 'p', messages: [{ role: 'user', content: 'hi' }], tools: [] }) });
    assert.equal(ai.status, 501, `AI refused: ${JSON.stringify(ai.body)}`);
    const inv = await call('/api/ai/invoice', { method: 'POST', headers: auth, body: JSON.stringify({ pharmacy: 'p', media_type: 'image/jpeg', data: 'abc' }) });
    assert.equal(inv.status, 501, `AI invoice refused: ${JSON.stringify(inv.body)}`);
    const g = (await call('/__probe/global-fetch')).body;
    for (const u of PROBES) assert.equal(g[u], 403, `${u}: ${g[u]}`);
    const w = await mf.getWorker();
    for (const cron of ['15 * * * *', '0 6 * * *', '*/30 * * * *']) await w.scheduled({ cron });
    assert.deepEqual(outbound, [], 'nothing left the staging Worker');
  } finally { await mf.dispose(); }
});

test('production, in workerd: unchanged — all keys visible, AI shown as available, outbound requests go out (captured here)', { skip }, async () => {
  const { mf, outbound, call } = await start(PROD_VARS);
  try {
    const { body } = await call('/__probe/env');
    for (const k of ['ANTHROPIC_API_KEY', 'WHATSAPP_TOKEN', 'NEW_VENDOR_API_KEY']) assert.ok(body.keys.includes(k), `${k} visible on production`);
    assert.equal(body.globalFetchGuarded, false, 'production keeps the real fetch');
    assert.equal((await call('/api/ai/status')).body.data.enabled, true);
    const g = (await call('/__probe/global-fetch')).body;
    for (const u of PROBES) assert.equal(g[u], 599, `${u} reached the network (captured): ${g[u]}`);
    assert.deepEqual(outbound.map((u) => u.replace(/\/$/, '')), PROBES, 'the capture sees outbound requests, so an empty list on staging means none were made');
  } finally { await mf.dispose(); }
});
