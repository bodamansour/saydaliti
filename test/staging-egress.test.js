// Staging can never reach a real outside service: no WhatsApp message to a patient, no AI call — even if such a
// credential were set on the staging Worker by mistake. Production behaviour is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStaging, isolateEnv, guardedFetch, OUTSIDE_SERVICE_SECRETS, STAGING_ENV_ALLOWLIST, STAGING_FETCH } from '../worker/src/egress.js';
import { OUTSIDE_SERVICE_VARS } from '../worker/scripts/staging-guard.mjs';
import { runReminders } from '../src/reminders-job.js';
import { runMorning } from '../src/morning-job.js';

const CREDS = { WHATSAPP_TOKEN: 'real-looking', WHATSAPP_PHONE_ID: '123', ANTHROPIC_API_KEY: 'k', AI_MODEL: 'm', WHATSAPP_TEMPLATE: 't' };
const STAGING_ENV = { DEPLOY_ENV: 'staging', SITE_URL: 'https://saydaliti-staging.saydalitiapp.workers.dev', MORNING_CRON: '0 6 * * *', ...CREDS };
const PROD_ENV = { SITE_URL: 'https://saydaliti.saydalitiapp.workers.dev', MORNING_CRON: '0 6 * * *', ...CREDS };

test('staging is recognised by either signal; production by neither', () => {
  assert.equal(isStaging(STAGING_ENV), true);
  assert.equal(isStaging({ DEPLOY_ENV: 'staging' }), true, 'the var alone');
  assert.equal(isStaging({ SITE_URL: 'https://saydaliti-staging.x.workers.dev' }), true, 'the staging URL alone (var missing)');
  assert.equal(isStaging(PROD_ENV), false);
  assert.equal(isStaging({}), false);
  assert.equal(isStaging({ DEPLOY_ENV: 'production', SITE_URL: 'https://saydaliti.saydalitiapp.workers.dev' }), false);
});

test('staging: every outside-service credential is removed; production keeps its env untouched', () => {
  const s = isolateEnv(STAGING_ENV);
  for (const k of OUTSIDE_SERVICE_SECRETS) assert.ok(!(k in s), k);
  assert.equal(s.SITE_URL, STAGING_ENV.SITE_URL, 'other vars kept');
  assert.equal(isolateEnv(PROD_ENV), PROD_ENV, 'production: the same object');
  assert.deepEqual([...OUTSIDE_SERVICE_SECRETS].sort(), [...OUTSIDE_SERVICE_VARS].sort(), 'the guard checks the same list');
});

test('staging: outbound requests from the jobs are refused; production passes them through', async () => {
  const calls = [];
  const spy = async (u) => { calls.push(String(u)); return new Response('{}', { status: 200 }); };
  const r = await guardedFetch(STAGING_ENV, spy)('https://graph.facebook.com/v21.0/123/messages', { method: 'POST' });
  assert.equal(r.status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await guardedFetch(PROD_ENV, spy)('https://example.org/x')).status, 200);
  assert.deepEqual(calls, ['https://example.org/x']);
});

// The real job code, wired the way worker/src/index.js wires it: internal:// answered locally, the rest through
// guardedFetch. Reminders are due, so in production this would send.
const due = [{ id: 'r1', kind: 'dose', phone: '201000000000', patient_name: 'Synthetic', pharmacy_name: 'Test', medicine: 'X', times: ['00:00', '06:00', '12:00', '18:00'], next_refill: null }];
function wiring(env, sent) {
  const network = async (u) => { sent.push(String(u)); return new Response('{}', { status: 200 }); };
  return async (u, init) => String(u).startsWith('internal://')
    ? new Response(JSON.stringify(String(u).includes('reminders_feed') ? due : String(u).includes('report_feed') ? [] : null), { status: 200 })
    : guardedFetch(env, network)(u, init);
}
const jobEnv = (env) => ({ ...env, SUPABASE_URL: 'internal://db', SUPABASE_PUBLISHABLE_KEY: 'internal', REPORT_SECRET: 'internal' });

test('staging: patient reminders and the morning report send nothing, even with WhatsApp credentials set', async () => {
  for (const run of [runReminders, runMorning]) {
    const sent = [];
    // As the Worker runs them: credentials stripped first.
    const env = isolateEnv(STAGING_ENV);
    const r = await run({ env: jobEnv(env), fetchFn: wiring(env, sent) });
    assert.deepEqual(sent, [], `${run.name}: nothing left the Worker`);
    assert.match(JSON.stringify(r), /not configured|sent":0/, `${run.name}: ${JSON.stringify(r)}`);
    // Second layer: even if the credentials were NOT stripped, the outbound request is refused.
    const sent2 = [];
    await run({ env: jobEnv(STAGING_ENV), fetchFn: wiring(STAGING_ENV, sent2) });
    assert.deepEqual(sent2, [], `${run.name}: refused by guardedFetch`);
  }
});

test('the Worker itself: a staging cron with WhatsApp credentials set makes no outside request', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); return new Response('{}'); };
  const logs = console.log; console.log = () => {};
  try {
    const { default: worker } = await import('../worker/src/index.js');
    for (const cron of ['15 * * * *', '0 6 * * *', '*/30 * * * *']) {
      const waits = [];
      await worker.scheduled({ cron }, { ...STAGING_ENV }, { waitUntil: (p) => waits.push(p) });
      await Promise.allSettled(waits);
    }
  } finally { globalThis.fetch = realFetch; console.log = logs; }
  assert.deepEqual(calls, []);
});

// ---------- M1: allowlist, every outbound path, production unchanged ----------
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// Every file the Worker can run: all of worker/src plus everything they import by relative path (followed
// recursively), so a new module can't slip past the checks below.
const WORKER_CODE = (() => {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const m of read(rel).matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) visit(relative(ROOT, resolve(ROOT, dirname(rel), m[1])).split(sep).join('/'));
  };
  for (const f of readdirSync(new URL('../worker/src/', import.meta.url)).filter((f) => f.endsWith('.js'))) visit(`worker/src/${f}`);
  return [...seen];
})();
const FAKE_BINDINGS = { DB: { prepare() {} }, FILES: { get() {} }, ASSETS: { fetch() {} } };

test('staging: only allowlisted keys reach the code — a secret with a new name is removed, bindings are kept as they are', () => {
  const raw = { ...STAGING_ENV, ...FAKE_BINDINGS, PIN_PEPPER: 'p', BACKUP_KEY: 'b'.repeat(40), PBKDF2_ITER: '10000',
    NEW_VENDOR_API_KEY: 'fake-not-real', SMS_TOKEN: 'fake', STRIPE_SECRET_KEY: 'fake', SUPABASE_SERVICE_ROLE_KEY: 'fake' };
  const realFetch = globalThis.fetch;
  try {
    const s = isolateEnv(raw);
    assert.deepEqual(Object.keys(s).sort(), Object.keys(raw).filter((k) => STAGING_ENV_ALLOWLIST.includes(k)).sort());
    for (const k of ['NEW_VENDOR_API_KEY', 'SMS_TOKEN', 'STRIPE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', ...OUTSIDE_SERVICE_SECRETS]) assert.ok(!(k in s), `${k} removed`);
    for (const k of ['DB', 'FILES', 'ASSETS']) assert.equal(s[k], raw[k], `${k}: the same binding object`);
    for (const k of ['PIN_PEPPER', 'BACKUP_KEY', 'DEPLOY_ENV', 'SITE_URL', 'MORNING_CRON', 'PBKDF2_ITER']) assert.equal(s[k], raw[k], `${k} kept`);
  } finally { globalThis.fetch = realFetch; }
});

test('the checks below cover the whole Worker, including the job modules it imports', () => {
  for (const f of ['worker/src/index.js', 'worker/src/ai.js', 'worker/src/egress.js', 'src/morning-job.js', 'src/reminders-job.js']) assert.ok(WORKER_CODE.includes(f), f);
});

test('every env key the Worker code reads is either allowlisted, a removed outside-service credential, or added by jobEnv', () => {
  const JOB_ENV = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'REPORT_SECRET'];   // set by jobEnv() in index.js, after isolateEnv
  const keys = new Set();
  for (const f of WORKER_CODE) for (const m of read(f).matchAll(/env\??\.([A-Z][A-Z0-9_]+)/g)) keys.add(m[1]);
  for (const f of ['src/morning-job.js', 'src/reminders-job.js']) for (const m of read(f).match(/REQUIRED = \[([^\]]*)\]/)[1].matchAll(/'([A-Z_]+)'/g)) keys.add(m[1]);
  const unknown = [...keys].filter((k) => !STAGING_ENV_ALLOWLIST.includes(k) && !OUTSIDE_SERVICE_SECRETS.includes(k) && !JOB_ENV.includes(k) && k !== 'WHATSAPP_LANG');
  assert.deepEqual(unknown, [], `decide for each: allowlist it (staging needs it) or treat it as an outside-service credential`);
  assert.match(read('worker/src/index.js'), /const jobEnv = \(env\) => \(\{ \.\.\.env, SUPABASE_URL: 'internal:\/\/db'/, 'jobEnv points the jobs at the Worker itself');
  // No other way to read env (e.g. env[name]) except the jobs' REQUIRED check.
  // (egress.js itself copies the allowlisted keys with env[k].)
  for (const f of WORKER_CODE.filter((f) => f !== 'worker/src/egress.js')) for (const line of read(f).split('\n').filter((l) => /\benv\[/.test(l))) assert.match(line, /REQUIRED\.filter\(\(k\) => !env\[k\]\)/, `${f}: ${line.trim()}`);
});

test('every outbound call in the Worker goes through an injected or guarded fetch; no sockets, WebSockets or captured fetch', () => {
  for (const f of WORKER_CODE.filter((f) => f !== 'worker/src/egress.js')) {
    const code = read(f).replace(/^\s*\/\/.*$/gm, '');
    for (const line of code.split('\n').filter((l) => /\bfetch\b/.test(l))) {
      assert.match(line, /fetchImpl|fetchFn|guardedFetch|env\.ASSETS\.fetch\(req\)|async fetch\(req, env(, ctx)?\)|internalFetch\(env\)/, `${f}: unexpected fetch use: ${line.trim()}`);
    }
    assert.doesNotMatch(code, /cloudflare:sockets|\bconnect\(|new WebSocket|EmailMessage|globalThis\.fetch|const \w+ = fetch\b/, `${f}: an outbound path the guard does not cover`);
  }
  const index = read('worker/src/index.js');
  assert.match(index, /aiChat\(env, await contextOf\(env, req\), req, \{ fetchImpl: guardedFetch\(env\) \}\)/, '/api/ai gets guardedFetch');
  assert.match(index, /aiInvoice\(env, await contextOf\(env, req\), req, \{ fetchImpl: guardedFetch\(env\) \}\)/, '/api/ai/invoice gets guardedFetch');
});

test('staging: the global fetch refuses http and https (the real fetch is never called); production keeps the real fetch', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  const spy = async (u) => { calls.push(String(u)); return new Response('{}', { status: 200 }); };
  try {
    globalThis.fetch = spy;
    isolateEnv({ ...STAGING_ENV, ...FAKE_BINDINGS });
    assert.equal(globalThis.fetch, STAGING_FETCH, 'installed on staging');
    for (const u of ['https://api.anthropic.com/v1/messages', 'http://203.0.113.7/x', 'https://graph.facebook.com/v21.0/1/messages', new Request('https://example.org/r')]) {
      const r = await fetch(u, { method: 'POST', body: '{}' });
      assert.equal(r.status, 403, String(u));
    }
    assert.deepEqual(calls, [], 'the real fetch was never reached');
    // Only the second signal (DEPLOY_ENV missing): still staging.
    globalThis.fetch = spy;
    isolateEnv({ SITE_URL: 'https://saydaliti-staging.saydalitiapp.workers.dev', ...FAKE_BINDINGS });
    assert.equal(globalThis.fetch, STAGING_FETCH, 'installed by the URL signal alone');
    // Production: nothing replaced, the same env object, the real fetch called.
    globalThis.fetch = spy;
    const prod = { ...PROD_ENV, ...FAKE_BINDINGS };
    assert.equal(isolateEnv(prod), prod);
    assert.equal(globalThis.fetch, spy, 'production: global fetch untouched');
    await guardedFetch(prod)('https://api.anthropic.com/v1/messages');
    assert.deepEqual(calls, ['https://api.anthropic.com/v1/messages'], 'production: the AI call goes out as before');
  } finally { globalThis.fetch = realFetch; }
});
