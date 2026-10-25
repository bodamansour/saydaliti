import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStore } from '../src/attendance-store.js';
import { attendanceReport } from '../src/attendance.js';

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test('clock in, clock out, wrong PIN, duplicate PIN, PIN never stored', async () => {
  let t = new Date(2026, 9, 25, 9, 4);
  const storage = memory();
  const s = createLocalStore({ now: () => t, storage });
  await s.addEmployee({ name: 'سارة', pin: '1234' });
  await assert.rejects(s.addEmployee({ name: 'علي', pin: '1234' }), /مستخدم/);
  await assert.rejects(s.addEmployee({ name: 'علي', pin: '12' }), /4 لـ 6/);
  await assert.rejects(s.clock('9999'), /الكود غلط/);

  const a = await s.clock('1234');
  assert.deepEqual([a.name, a.action], ['سارة', 'in']);
  t = new Date(2026, 9, 25, 17, 2);
  const b = await s.clock('1234');
  assert.equal(b.action, 'out');

  assert.ok(!storage.getItem('saydaliti-attendance-v1').includes('1234'));
  const [emp] = await s.listEmployees();
  assert.equal(emp.pin_hash, undefined);

  const recs = await s.records(new Date(2026, 9, 1), new Date(2026, 10, 1));
  assert.equal(recs.length, 1);
  const [r] = attendanceReport([emp], recs, new Date(2026, 9, 25), new Date(2026, 9, 26), new Date(2026, 9, 25, 18));
  assert.ok(Math.abs(r.hours - (7 + 58 / 60)) < 0.01);
});

test('owner fixes a forgotten clock-out', async () => {
  let t = new Date(2026, 9, 24, 9, 0);
  const s = createLocalStore({ now: () => t, storage: memory() });
  await s.addEmployee({ name: 'محمد', pin: '5555' });
  await s.clock('5555');
  const [r] = await s.records(new Date(2026, 9, 1), new Date(2026, 10, 1));
  await assert.rejects(s.fixCheckout(r.id, new Date(2026, 9, 24, 8, 0)), /بعد الحضور/);
  await s.fixCheckout(r.id, new Date(2026, 9, 24, 17, 0));
  t = new Date(2026, 9, 25, 9, 0);
  assert.equal((await s.clock('5555')).action, 'in'); // new shift, not a clock-out of yesterday
});

test('data survives a reload', async () => {
  const storage = memory();
  const s1 = createLocalStore({ now: () => new Date(2026, 9, 25, 9), storage });
  await s1.addEmployee({ name: 'نور', pin: '4321' });
  await s1.clock('4321');
  const s2 = createLocalStore({ now: () => new Date(2026, 9, 25, 17), storage });
  assert.equal((await s2.clock('4321')).action, 'out');
});
