import { test } from 'node:test';
import assert from 'node:assert/strict';
import { morningReport } from '../src/report.js';

const A = {
  expiring: [{ name: 'سيروم', atRisk: 7, cost: 360, expDays: 65 }, { name: 'نقط أنف', atRisk: 19, cost: 17, expDays: 0 }],
  deadStock: [{ name: 'كريم تفتيح', qty: 12, cost: 180, lastSale: null }],
  reorder: [{ name: 'أوميبرازول', order: 30, cost: 38, daysCover: 0.4 }],
};

test('morning report: totals and sections', () => {
  const t = morningReport(A, { pharmacyName: 'صيدلية أحمد منصور', date: new Date(2026, 9, 25) });
  assert.match(t, /صيدلية أحمد منصور/);
  // 7×360 + 19×17 = 2,843 expiring; 12×180 = 2,160 dead; total 5,003
  assert.match(t, /فلوس في خطر: 5,003 جنيه/);
  assert.match(t, /هتنتهي قبل ما تتباع: 2,843 ج \(2 صنف\)/);
  assert.match(t, /نقط أنف: 19 قطعة، منتهي/);
  assert.match(t, /أوميبرازول: 30 — خلص تقريباً/);
  assert.match(t, /كريم تفتيح: 12 قطعة \(2,160 ج\) — متباعتش خالص/);
});

test('morning report: nothing to do', () => {
  const t = morningReport({ expiring: [], deadStock: [], reorder: [] });
  assert.match(t, /مفيش حاجة محتاجة تتعمل النهارده/);
});

test('morning report: long lists are cut with a pointer to the dashboard', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ name: `صنف ${i}`, atRisk: 1, cost: 10, expDays: 30 }));
  const t = morningReport({ expiring: many, deadStock: [], reorder: [] }, { top: 5 });
  assert.match(t, /و3 صنف تاني في اللوحة/);
});
