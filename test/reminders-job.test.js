import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReminders } from '../src/reminders-job.js';

const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pk', REPORT_SECRET: 's', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: '123' };
const feed = [
  { id: 'r1', kind: 'dose', medicine: 'جلوكوفاج 1000', dose_times: ['09:00', '21:00'], last_sent_at: null, patient_name: 'أم محمد', phone: '201012345678', pharmacy_name: 'صيدلية أحمد منصور' },
  { id: 'r2', kind: 'refill', medicine: 'كونكور 5', refill_every_days: 30, next_refill: '2026-10-28', last_sent_at: null, patient_name: 'عم حسن', phone: '201112345678', pharmacy_name: 'صيدلية أحمد منصور' },
  { id: 'r3', kind: 'dose', medicine: 'x', dose_times: ['14:00'], last_sent_at: null, patient_name: 'y', phone: '201212345678', pharmacy_name: 'z' },
];

test('off until configured', async () => {
  const r = await runReminders({ env: { ...env, WHATSAPP_PHONE_ID: '' }, fetchFn: () => { throw new Error('no calls'); } });
  assert.match(r.skipped, /WHATSAPP_PHONE_ID/);
});

test('sends due reminders and marks them, advancing the refill date', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push([url, body]);
    if (url.endsWith('reminders_feed')) return { ok: true, json: async () => feed };
    return { ok: true, status: 200 };
  };
  const r = await runReminders({ env, fetchFn, now: new Date('2026-10-27T09:10:00+03:00') });
  assert.equal(r.sent, 2);
  const wa = calls.filter(([u]) => u.includes('graph.facebook.com')).map(([, b]) => b);
  assert.deepEqual(wa.map((b) => [b.to, b.template.name]), [['201012345678', 'saydaliti_dose'], ['201112345678', 'saydaliti_refill']]);
  assert.deepEqual(wa[0].template.components[0].parameters.map((p) => p.text), ['أم محمد', 'صيدلية أحمد منصور', 'جلوكوفاج 1000']);
  const mark = calls.find(([u]) => u.endsWith('mark_reminders_sent'))[1];
  assert.deepEqual(mark.p_items, [{ id: 'r1', next_refill: null }, { id: 'r2', next_refill: '2026-11-27' }]);
  assert.ok(!JSON.stringify(r).includes('201012345678'));
});

test('a failed send is not marked, so it retries next run', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push(url);
    if (url.endsWith('reminders_feed')) return { ok: true, json: async () => [feed[0]] };
    return { ok: false, status: 400 };
  };
  const r = await runReminders({ env, fetchFn, now: new Date('2026-10-27T09:10:00+03:00') });
  assert.equal(r.sent, 0);
  assert.ok(!calls.some((u) => u.endsWith('mark_reminders_sent')));
});
