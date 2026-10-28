import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionState, monthlyPrice } from '../src/subscription.js';

const T = new Date(2026, 9, 28);
const cfg = { grace_days: 7 };

test('free and missing subscriptions never bother the owner', () => {
  assert.equal(subscriptionState({ status: 'free' }, cfg, T).level, 'ok');
  assert.equal(subscriptionState(null, cfg, T).level, 'ok');
});

test('trial: a quiet note, then a warning in the last 3 days', () => {
  assert.deepEqual([subscriptionState({ status: 'trial', trial_ends: '2026-11-07' }, cfg, T).level, subscriptionState({ status: 'trial', trial_ends: '2026-11-07' }, cfg, T).days], ['info', 10]);
  assert.equal(subscriptionState({ status: 'trial', trial_ends: '2026-10-30' }, cfg, T).level, 'warn');
  assert.match(subscriptionState({ status: 'trial', trial_ends: '2026-10-28' }, cfg, T).text, /النهارده/);
});

test('after the end: days of grace, then the dashboard locks (never the cashier)', () => {
  const s = subscriptionState({ status: 'active', paid_until: '2026-10-25' }, cfg, T);
  assert.equal(s.level, 'expired');
  assert.match(s.text, /الكاشير مش هيقف/);
  assert.equal(subscriptionState({ status: 'active', paid_until: '2026-10-20' }, cfg, T).level, 'locked');
  assert.equal(subscriptionState({ status: 'active', paid_until: '2026-10-21' }, cfg, T).level, 'expired', 'the 7th day of grace');
  assert.equal(subscriptionState({ status: 'suspended' }, cfg, T).level, 'locked');
  assert.equal(subscriptionState({ status: 'active', paid_until: '2026-12-01' }, cfg, T).level, 'ok');
  assert.equal(subscriptionState({ status: 'active', paid_until: '2026-11-02' }, cfg, T).level, 'warn');
});

test('price: base plus each extra branch, or the price agreed with that pharmacy', () => {
  assert.equal(monthlyPrice({ price_month: 500, price_branch: 250 }, 3), 1000);
  assert.equal(monthlyPrice({ price_month: 500, price_branch: 250 }, 1), 500);
  assert.equal(monthlyPrice({ price_month: 500 }, 2, 350), 350);
});

test('a payment extends from the end date if still ahead, else from today', async () => {
  const { extendPaid } = await import('../src/subscription.js');
  assert.equal(extendPaid('2026-11-15', 1, T), '2026-12-15');
  assert.equal(extendPaid('2026-10-01', 3, T), '2027-01-28');
  assert.equal(extendPaid('', 12, T), '2027-10-28');
});
