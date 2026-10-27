import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMorning } from '../src/morning-job.js';
import { morningTemplateParams, normalizeEgPhone, parsePhones } from '../src/report.js';
import { settingsFromSaved } from '../src/core.js';

const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pk', REPORT_SECRET: 's', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: '123' };
const now = new Date(2026, 9, 25, 9, 0);
const snapshot = {
  items: [
    { code: 'A', name: 'كريم', cost: 100, price: 150, owner: null },
    { code: 'B', name: 'شامبو', cost: 50, price: 80, owner: null, qty: 4 },
  ],
  batches: [{ code: 'A', qty: 10, expiry: '2026-11-10' }],
  sales: [{ code: 'A', date: '2026-10-20', qty: 1 }],
};

test('phones: Egyptian formats, Arabic digits, duplicates', () => {
  assert.equal(normalizeEgPhone('010 1234 5678'), '201012345678');
  assert.equal(normalizeEgPhone('+201112345678'), '201112345678');
  assert.equal(normalizeEgPhone('00201212345678'), '201212345678');
  assert.equal(normalizeEgPhone('0123'), null);
  assert.deepEqual(parsePhones('01012345678، ٠١٠١٢٣٤٥٦٧٨\n01512345678'), ['201012345678', '201512345678']);
});

test('template params are single-line strings', () => {
  const p = morningTemplateParams({ expiring: [{ atRisk: 2, cost: 100 }], deadStock: [{ qty: 3, cost: 10 }], reorder: [] },
    { pharmacyName: 'صيدلية\nتجربة', link: 'https://x' });
  assert.deepEqual(p, ['صيدلية تجربة', '230', '1', '1', '0', 'https://x']);
});

test('saved settings convert like the dashboard form', () => {
  const s = settingsFromSaved({ taxMode: 'custom', customTax: '2', exRent: '1000', exSal: '500', target: '', expWin: '' });
  assert.deepEqual([s.taxMode, s.customTax, s.expenses, s.target, s.expWin], ['custom', 2, 1500, 10, 90]);
});

test('job is off until every setting exists', async () => {
  const r = await runMorning({ env: { ...env, WHATSAPP_TOKEN: '' }, fetchFn: () => { throw new Error('no calls expected'); } });
  assert.match(r.skipped, /WHATSAPP_TOKEN/);
});

test('job sends the template to each number, skips stale data', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    if (url.includes('report_feed')) {
      return { ok: true, json: async () => [
        { pharmacy_name: 'صيدلية تجربة', settings: { waNumbers: '01012345678, 01112345678', expWin: '90' }, snapshot_at: '2026-10-25T04:00:00Z', data: snapshot },
        { pharmacy_name: 'قديمة', settings: { waNumbers: '01212345678' }, snapshot_at: '2026-10-20T04:00:00Z', data: snapshot },
      ] };
    }
    return { ok: true, status: 200 };
  };
  const r = await runMorning({ env, fetchFn, now });
  assert.equal(r.sent, 2);
  assert.ok(r.results.some((x) => x.pharmacy === 'قديمة' && /old/.test(x.skipped)));
  const wa = calls.filter(([u]) => u.includes('graph.facebook.com'));
  assert.deepEqual(wa.map(([, b]) => b.to), ['201012345678', '201112345678']);
  const params = wa[0][1].template.components[0].parameters.map((x) => x.text);
  assert.equal(params[0], 'صيدلية تجربة');
  assert.equal(params[3], '1'); // شامبو never sold → dead stock
  assert.equal(wa[0][1].template.name, 'saydaliti_morning');
  assert.ok(!JSON.stringify(r).includes('01012345678')); // full numbers never echoed in the job result
});

test('job adds up every branch', async () => {
  const branch2 = { items: [{ code: 'C', name: 'مرطب', cost: 30, price: 45, qty: 6 }], sales: [] };
  const sent = [];
  const fetchFn = async (url, init) => {
    if (url.includes('report_feed')) {
      return { ok: true, json: async () => [{ pharmacy_name: 'صيدلية فروع', settings: { waNumbers: '01012345678' }, snapshot_at: '2026-10-25T04:00:00Z', data: snapshot,
        branch_data: [{ branch: 'الرئيسي', data: snapshot }, { branch: 'الجمهورية', data: branch2 }] }] };
    }
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };
  await runMorning({ env, fetchFn, now });
  const params = sent[0].template.components[0].parameters.map((x) => x.text);
  assert.equal(params[3], '2'); // شامبو (branch 1) + مرطب (branch 2) both dead stock
});
