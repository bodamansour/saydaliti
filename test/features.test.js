import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortagePlan, cheapestSeen, priceCompare, cairoClock, parseTimes, dueReminders, advanceRefill } from '../src/features.js';

const d = (s) => new Date(`${s}T00:00:00`);
// Cairo is UTC+3 on these dates (summer time in 2026 runs until the last Thursday of October).
const cairo = (s) => new Date(`${s}+03:00`);

test('shortage plan: stock-up covers 60 days, unknown items are kept but marked', () => {
  const rows = [{ code: 'A', name: 'إنسولين', qty: 4, rate: 0.5, daysCover: 8, cost: 300 }, { code: 'B', name: 'شراب', qty: 10, rate: 0, daysCover: Infinity, cost: 20 }];
  const plan = shortagePlan([
    { id: 1, code: 'A', name: 'إنسولين' },
    { id: 2, name: 'شراب' },
    { id: 3, name: 'صنف مش عندي' },
    { id: 4, code: 'A', name: 'x', status: 'resolved' },
  ], rows);
  assert.equal(plan.length, 3);
  assert.equal(plan[0].code, 'A');
  assert.equal(plan[0].stockUp, 26);
  assert.equal(plan[0].cost, 7800);
  assert.equal(plan[1].found, true);
  assert.equal(plan[1].stockUp, 0);
  assert.equal(plan[2].found, false);
});

test('cheapest market price in the last 45 days', () => {
  const m = cheapestSeen([
    { code: 'C1', price: 300, seen_on: '2026-10-20', source: 'صيدلية العزبي' },
    { code: 'C1', price: 280, seen_on: '2026-10-25', source: 'موقع' },
    { code: 'C1', price: 200, seen_on: '2026-07-01', source: 'قديم' },
    { code: 'C2', price: 50, seen_on: '2026-10-26', source: '' },
  ], d('2026-10-27'));
  assert.equal(m.get('C1').price, 280);
  assert.equal(m.get('C1').source, 'موقع');
  const cmp = priceCompare([{ code: 'C1', price: 320 }, { code: 'C2', price: 45 }, { code: 'C3', price: 10 }], m);
  assert.equal(cmp.length, 2);
  assert.equal(cmp[0].code, 'C1');
  assert.equal(cmp[0].diff, 40);
  assert.ok(cmp[1].diff < 0);
});

test('Cairo clock', () => {
  assert.deepEqual(cairoClock(new Date('2026-10-27T06:30:00Z')), { date: '2026-10-27', minutes: 9 * 60 + 30 });
  assert.equal(cairoClock(new Date('2026-10-27T22:30:00Z')).date, '2026-10-28');
});

test('dose times from free text', () => {
  assert.deepEqual(parseTimes('9 ص، 9 م'), ['09:00', '21:00']);
  assert.deepEqual(parseTimes('08:30, 14:00 ,٢٢:١٥'), ['08:30', '14:00', '22:15']);
  assert.deepEqual(parseTimes('25:00'), []);
});

test('dose reminder goes out once within the hour after its time', () => {
  const r = { id: 1, kind: 'dose', dose_times: ['09:00', '21:00'], last_sent_at: null };
  assert.equal(dueReminders([r], cairo('2026-10-27T08:50:00')).length, 0);
  assert.equal(dueReminders([r], cairo('2026-10-27T09:05:00')).length, 1);
  assert.equal(dueReminders([r], cairo('2026-10-27T09:59:00')).length, 1);
  assert.equal(dueReminders([r], cairo('2026-10-27T10:20:00')).length, 1, 'a late run still sends');
  assert.equal(dueReminders([r], cairo('2026-10-27T10:31:00')).length, 0, 'too late');
  const sent = { ...r, last_sent_at: cairo('2026-10-27T09:05:00').toISOString() };
  assert.equal(dueReminders([sent], cairo('2026-10-27T09:40:00')).length, 0, 'not twice');
  assert.equal(dueReminders([sent], cairo('2026-10-27T10:20:00')).length, 0, 'not twice on a late run');
  const close = { ...r, dose_times: ['09:00', '10:00'], last_sent_at: cairo('2026-10-27T09:05:00').toISOString() };
  assert.equal(dueReminders([close], cairo('2026-10-27T10:05:00'))[0].dueTime, '10:00', 'next dose an hour later');
  assert.equal(dueReminders([sent], cairo('2026-10-27T21:10:00')).length, 1, 'evening dose');
  assert.equal(dueReminders([{ ...r, active: false }], cairo('2026-10-27T09:05:00')).length, 0);
});

test('refill reminder the day before, once', () => {
  const r = { id: 2, kind: 'refill', next_refill: '2026-11-01', refill_every_days: 30, last_sent_at: null };
  assert.equal(dueReminders([r], cairo('2026-10-30T10:00:00')).length, 0);
  assert.equal(dueReminders([r], cairo('2026-10-31T10:00:00')).length, 1);
  assert.equal(dueReminders([r], cairo('2026-11-03T10:00:00')).length, 1, 'missed days still send');
  const sent = { ...r, last_sent_at: cairo('2026-10-31T10:00:00').toISOString() };
  assert.equal(dueReminders([sent], cairo('2026-10-31T18:00:00')).length, 0);
});

test('refill date moves forward after sending', () => {
  assert.equal(advanceRefill('2026-11-01', 30, d('2026-10-31')).getTime(), d('2026-12-01').getTime());
  assert.equal(advanceRefill('2026-09-01', 30, d('2026-10-31')).getTime(), d('2026-11-30').getTime());
});
