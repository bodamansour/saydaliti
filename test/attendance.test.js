import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attendanceReport } from '../src/attendance.js';

// October 2026: the 1st is a Thursday. Friday (5) is the day off.
const at = (d, hh, mm = 0) => new Date(2026, 9, d, hh, mm);
const emp = { id: 'e1', name: 'سارة', shift_start: '09:00', shift_end: '17:00', work_days: [6, 0, 1, 2, 3, 4], grace_minutes: 15 };
const from = new Date(2026, 9, 1);
const to = new Date(2026, 9, 8); // 1–7 Oct
const now = new Date(2026, 9, 25, 12, 0);

test('hours, lateness, absence, early leave, open shift', () => {
  const records = [
    { employee_id: 'e1', check_in: at(1, 9, 5), check_out: at(1, 17, 0) },   // on time (within grace), 7h55m
    { employee_id: 'e1', check_in: at(3, 9, 40), check_out: at(3, 17, 0) },  // 40 min late
    { employee_id: 'e1', check_in: at(4, 9, 0), check_out: at(4, 15, 0) },   // left 2h early
    { employee_id: 'e1', check_in: at(5, 9, 0), check_out: null },            // forgot to clock out
    { employee_id: 'e1', check_in: at(6, 8, 55), check_out: at(6, 13, 0) },  // split shift
    { employee_id: 'e1', check_in: at(6, 14, 0), check_out: at(6, 17, 10) },
    { employee_id: 'other', check_in: at(7, 9, 0), check_out: at(7, 17, 0) },
  ];
  const [r] = attendanceReport([emp], records, from, to, now);
  // Work days 1–7 Oct: Thu 1, Sat 3, Sun 4, Mon 5, Tue 6, Wed 7 (Fri 2 off) = 6
  assert.equal(r.scheduledDays, 6);
  assert.equal(r.daysPresent, 5);
  assert.equal(r.absent, 1); // Wed 7
  assert.equal(r.lateDays, 1);
  assert.equal(r.lateMinutes, 40);
  assert.equal(r.earlyLeaves, 2); // 4 Oct at 15:00, and 6 Oct morning part ends 13:00
  assert.equal(r.openShifts, 1);
  const expected = (7 * 60 + 55 + 7 * 60 + 20 + 6 * 60 + 4 * 60 + 5 + 3 * 60 + 10) / 60;
  assert.ok(Math.abs(r.hours - expected) < 0.01, `${r.hours} vs ${expected}`);
  assert.equal(r.expectedHours, 48);
});

test('today is not counted absent before the shift starts', () => {
  const morning = new Date(2026, 9, 7, 8, 30);
  const [r] = attendanceReport([emp], [], from, to, morning);
  assert.equal(r.scheduledDays, 5); // the 7th not counted yet
  assert.equal(r.absent, 5);
});

test('a new employee is not absent before the day they were added', () => {
  const newbie = { ...emp, id: 'e2', created_at: new Date(2026, 9, 6, 11, 0).toISOString() };
  const recs = [{ employee_id: 'e2', check_in: at(6, 9, 0), check_out: at(6, 17, 0) }];
  const [r] = attendanceReport([newbie], recs, from, to, now);
  assert.equal(r.scheduledDays, 2); // Tue 6 and Wed 7 only
  assert.equal(r.absent, 1); // Wed 7
});
