// Staging can never reach a real outside service: no WhatsApp message to a patient, no AI call — even if such a
// credential were set on the staging Worker by mistake. Production behaviour is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStaging, isolateEnv, guardedFetch, OUTSIDE_SERVICE_SECRETS } from '../worker/src/egress.js';
import { OUTSIDE_SERVICE_VARS } from '../worker/scripts/staging-guard.mjs';
import { runReminders } from '../src/reminders-job.js';
import { runMorning } from '../src/morning-job.js';

const CREDS = { WHATSAPP_TOKEN: 'real-looking', WHATSAPP_PHONE_ID: '123', ANTHROPIC_API_KEY: 'k', AI_MODEL: 'm', WHATSAPP_TEMPLATE: 't' };
const STAGING_ENV = { DEPLOY_ENV: 'staging', SITE_URL: 'https://saydaliti-staging.mosaedapp.workers.dev', MORNING_CRON: '0 6 * * *', ...CREDS };
const PROD_ENV = { SITE_URL: 'https://saydaliti.mosaedapp.workers.dev', MORNING_CRON: '0 6 * * *', ...CREDS };

test('staging is recognised by either signal; production by neither', () => {
  assert.equal(isStaging(STAGING_ENV), true);
  assert.equal(isStaging({ DEPLOY_ENV: 'staging' }), true, 'the var alone');
  assert.equal(isStaging({ SITE_URL: 'https://saydaliti-staging.x.workers.dev' }), true, 'the staging URL alone (var missing)');
  assert.equal(isStaging(PROD_ENV), false);
  assert.equal(isStaging({}), false);
  assert.equal(isStaging({ DEPLOY_ENV: 'production', SITE_URL: 'https://saydaliti.mosaedapp.workers.dev' }), false);
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
