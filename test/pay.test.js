// Online subscription payment (Paymob): the amount comes from the server's prices, the checkout is asked of
// Paymob, and the months are added only after a correctly signed success message, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated } from './helpers/d1-fake.js';
import { payStart, payWebhook, paymobHmac, payReady } from '../worker/src/pay.js';
import { payAmount } from '../src/subscription.js';

const KEYS = { PAYMOB_SECRET_KEY: 'sk_test', PAYMOB_PUBLIC_KEY: 'pk_test', PAYMOB_INTEGRATION_IDS: '111, 222', PAYMOB_HMAC: 'hmac-secret' };
const P = 'ph-1', U = 'user-1';
function setup({ status = 'trial', trial_ends = '2026-11-20', paid_until = null, plan = null } = {}) {
  const DB = migrated();
  DB.raw.exec(`INSERT INTO pharmacies (id, name, timezone, settings, created_at) VALUES ('${P}', 'صيدلية النور', 'Africa/Cairo', '{}', '2026-01-01');
    INSERT INTO branches (id, pharmacy_id, name, created_at) VALUES ('b1', '${P}', 'الرئيسي', '2026-01-01'), ('b2', '${P}', 'التاني', '2026-01-02');
    UPDATE app_config SET price_month = 300, price_branch = 100, plans = '{"pro":{"name":"Pro","price_month":500,"price_year":5000,"features":["core"],"max_branches":3,"max_users":5}}' WHERE id = 1;`);
  DB.prepare('INSERT INTO subscriptions (pharmacy_id, status, trial_ends, paid_until, plan, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(P, status, trial_ends, paid_until, plan, '2026-01-01').run();
  return { DB, ...KEYS };
}
const owner = { user: { id: U, email: 'o@x.eg' }, roles: new Map([[P, 'owner']]) };
const paymob = (calls) => async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return new Response(JSON.stringify({ client_secret: 'cs_123' }), { status: 201 }); };

async function signed(env, obj) {
  const h = await paymobHmac(obj, env.PAYMOB_HMAC);
  return [new Request('https://x/api/pay/webhook', { method: 'POST', body: JSON.stringify({ type: 'TRANSACTION', obj }) }), new URL(`https://x/api/pay/webhook?hmac=${h}`)];
}
const txn = (ref, cents, over = {}) => ({ id: 9001, amount_cents: cents, created_at: '2026-11-13T10:00:00', currency: 'EGP', error_occured: false, has_parent_transaction: false,
  integration_id: 111, is_3d_secure: true, is_auth: false, is_capture: false, is_refunded: false, is_standalone_payment: true, is_voided: false,
  order: { id: 77, merchant_order_id: ref }, owner: 5, pending: false, source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' }, success: true, ...over });

test('the price: the plan\'s, a year at the yearly price, else base plus branches', () => {
  const cfg = { price_month: 300, price_branch: 100, plans: { pro: { price_month: 500, price_year: 5000 } } };
  assert.equal(payAmount({ sub: { plan: 'pro' }, cfg, months: 1 }), 500);
  assert.equal(payAmount({ sub: { plan: 'pro' }, cfg, months: 12 }), 5000);
  assert.equal(payAmount({ sub: {}, cfg, branches: 2, months: 1 }), 400);
  assert.equal(payAmount({ sub: { price_month: 250 }, cfg, branches: 2, months: 12 }), 3000);
  assert.equal(payAmount({ sub: {}, cfg: {}, months: 1 }), 0);
});

test('off without the keys; owner only; the server sets the amount', async () => {
  const env = setup();
  assert.equal(payReady({}), false);
  await assert.rejects(payStart({ DB: env.DB }, owner, { pharmacy: P, months: 1 }), /not configured/);
  await assert.rejects(payStart(env, { ...owner, roles: new Map([[P, 'pharmacist']]) }, { pharmacy: P, months: 1 }), /not allowed/);
  await assert.rejects(payStart(env, owner, { pharmacy: P, months: 3 }), /bad request/);
  const calls = [];
  const r = await payStart(env, owner, { pharmacy: P, months: 1, amount: 1 }, { fetchImpl: paymob(calls), site: 'https://tablix.example' });
  assert.equal(r.amount, 400, 'base 300 + one more branch 100; the page\'s amount is ignored');
  assert.match(r.url, /^https:\/\/accept\.paymob\.com\/unifiedcheckout\/\?publicKey=pk_test&clientSecret=cs_123$/);
  assert.equal(calls[0].url, 'https://accept.paymob.com/v1/intention/');
  assert.equal(calls[0].auth, 'Token sk_test');
  assert.equal(calls[0].body.amount, 40000);
  assert.deepEqual(calls[0].body.payment_methods, [111, 222]);
  assert.equal(calls[0].body.notification_url, 'https://tablix.example/api/pay/webhook');
  const row = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(calls[0].body.special_reference).first();
  assert.equal(row.status, 'pending'); assert.equal(row.amount_cents, 40000); assert.equal(row.months, 1);
});

test('a signed success adds the months once, after the trial; a bad signature or amount adds nothing', async () => {
  const env = setup();
  const calls = [];
  await payStart(env, owner, { pharmacy: P, months: 12 }, { fetchImpl: paymob(calls) });
  const ref = calls[0].body.special_reference;
  const today = new Date('2026-11-13T00:00:00');
  // Unsigned or tampered: refused.
  const [req0] = await signed(env, txn(ref, 480000));
  await assert.rejects(payWebhook(env, req0, new URL('https://x/api/pay/webhook?hmac=00'), { today }), /bad signature/);
  // Signed, but less money than asked for: not paid.
  const [rq1, u1] = await signed(env, txn(ref, 100));
  assert.deepEqual(await payWebhook(env, rq1, u1, { today }), { paid: false });
  // Signed success: a year after the trial's end.
  const [rq2, u2] = await signed(env, txn(ref, 480000));
  const r = await payWebhook(env, rq2, u2, { today });
  assert.deepEqual(r, { paid: true, until: '2027-11-20' });
  const sub = await env.DB.prepare('SELECT status, paid_until FROM subscriptions WHERE pharmacy_id = ?').bind(P).first();
  assert.deepEqual(sub, { status: 'active', paid_until: '2027-11-20' });
  // The same message again: nothing more.
  const [rq3, u3] = await signed(env, txn(ref, 480000));
  assert.deepEqual(await payWebhook(env, rq3, u3, { today }), { paid: true, again: true });
  assert.equal((await env.DB.prepare('SELECT paid_until FROM subscriptions WHERE pharmacy_id = ?').bind(P).first()).paid_until, '2027-11-20');
});

test('paid ahead adds after the end; a suspended pharmacy stays suspended', async () => {
  for (const [status, expect] of [['active', 'active'], ['suspended', 'suspended']]) {
    const env = setup({ status, trial_ends: null, paid_until: '2026-12-01' });
    const calls = [];
    await payStart(env, owner, { pharmacy: P, months: 1 }, { fetchImpl: paymob(calls) });
    const [rq, u] = await signed(env, txn(calls[0].body.special_reference, 40000));
    assert.equal((await payWebhook(env, rq, u, { today: new Date('2026-11-13T00:00:00') })).until, '2027-01-01');
    assert.equal((await env.DB.prepare('SELECT status FROM subscriptions WHERE pharmacy_id = ?').bind(P).first()).status, expect);
  }
});
