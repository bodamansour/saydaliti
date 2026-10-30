// The owner's insights: overview numbers, trends, profit classes, suppliers, health score,
// forecast, unusual activity, alerts and recommendations — all from the records, nothing guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overview, monthlySeries, categoryPerformance, trending, profitClasses, supplierPerformance, healthScore, forecast, stockoutPlan, anomalies, alerts, recommendations, periodTotals } from '../src/insights.js';

const TODAY = new Date(2026, 9, 30); // Friday 30 Oct 2026
const d = (y, m, day) => new Date(y, m - 1, day);
const items = [
  { code: 'A', name: 'بانادول', category: 'دواء', cost: 40, price: 50, qty: 10 },
  { code: 'B', name: 'كريم', category: 'تجميل', cost: 90, price: 100, qty: 5 },
  { code: 'C', name: 'شاش', category: 'مستلزمات', cost: 12, price: 10, qty: 0, min: 5 },
];

test('totals of a period: sales, cost of what was sold, gross profit', () => {
  const data = { items, sales: [{ date: d(2026, 10, 30), code: 'A', qty: 2, price: 50, cost: 40 }, { date: d(2026, 10, 29), code: 'B', qty: 1, price: 100, discount: 10, cost: 90 }] };
  assert.deepEqual(periodTotals(data, d(2026, 10, 29), d(2026, 10, 31)), { sales: 190, cogs: 170, gross: 20, qty: 3 });
});

test('overview: this month against the same days of last month, receipts and the average receipt', () => {
  const sales = [
    { date: d(2026, 10, 5), code: 'A', qty: 10, price: 50, cost: 40 },
    { date: d(2026, 9, 5), code: 'A', qty: 5, price: 50, cost: 40 },
    { date: d(2026, 9, 30), code: 'A', qty: 100, price: 50, cost: 40 }, // after the 30th of last month? no: Sep has 30 days → counted
  ];
  const o = overview({ items, sales }, { today: TODAY, receipts: [{ kind: 'sale', total: 60, sold_at: '2026-10-10T10:00:00' }, { kind: 'sale', total: 40, sold_at: '2026-10-11T10:00:00' }, { kind: 'return', total: -10, sold_at: '2026-10-12T10:00:00' }] });
  assert.equal(o.month.sales, 500);
  assert.equal(o.month.before, 5250);
  assert.equal(o.receipts.month, 2);
  assert.equal(o.receipts.avg, 50);
  assert.equal(o.out, 1, 'C is out and has a minimum');
  assert.equal(o.stock, 10 * 40 + 5 * 90);
});

test('monthly series and categories', () => {
  const data = { items, sales: [{ date: d(2026, 10, 1), code: 'A', qty: 1, price: 50, cost: 40 }, { date: d(2026, 9, 1), code: 'B', qty: 1, price: 100, cost: 90 }] };
  const m = monthlySeries(data, [{ spent_on: '2026-10-02', kind: 'rent', amount: 5 }], TODAY, 2);
  assert.deepEqual(m.map((x) => [x.key, x.sales, x.gross, x.expenses, x.net]), [['2026-09', 100, 10, 0, 10], ['2026-10', 50, 10, 5, 5]]);
  const c = categoryPerformance(data, d(2026, 9, 1), d(2026, 11, 1));
  assert.deepEqual(c.map((x) => [x.category, x.sales, x.margin]), [['تجميل', 100, 10], ['دواء', 50, 20]]);
});

test('trending: more and less than the 30 days before', () => {
  const sales = [];
  for (let k = 0; k < 10; k++) sales.push({ date: d(2026, 10, 20), code: 'A', qty: 1 }, { date: d(2026, 9, 10), code: 'B', qty: 1 });
  sales.push({ date: d(2026, 9, 15), code: 'A', qty: 2 }, { date: d(2026, 10, 20), code: 'B', qty: 2 });
  const t = trending({ items, sales }, TODAY);
  assert.deepEqual(t.up.map((r) => [r.code, r.before, r.now]), [['A', 2, 10]]);
  assert.deepEqual(t.down.map((r) => [r.code, r.before, r.now]), [['B', 10, 2]]);
});

test('profit classes: stars, volume, niche, weak, and items sold at a loss', () => {
  const sales = [
    { date: d(2026, 10, 1), code: 'A', qty: 20, price: 50, cost: 40 }, // 20%, many
    { date: d(2026, 10, 1), code: 'B', qty: 2, price: 100, cost: 90 }, // 10%, few
    { date: d(2026, 10, 1), code: 'C', qty: 30, price: 10, cost: 12 }, // loss
  ];
  const c = profitClasses({ items, sales }, d(2026, 10, 1), d(2026, 11, 1));
  assert.deepEqual(c.losing.map((r) => r.code), ['C']);
  assert.ok(c.stars.some((r) => r.code === 'A'));
});

test('suppliers: value, returns and how their prices moved', () => {
  const p = supplierPerformance([
    { supplier_id: 's', supplier_name: 'الأمل', received_on: '2026-09-01', total: 100, lines: [{ code: 'A', qty: 1, cost: 40 }] },
    { supplier_id: 's', supplier_name: 'الأمل', received_on: '2026-10-01', total: 100, lines: [{ code: 'A', qty: 1, cost: 44 }] },
    { supplier_id: 's', supplier_name: 'الأمل', kind: 'return', received_on: '2026-10-02', total: 20, lines: [{ code: 'A', qty: 1 }] },
  ]);
  assert.deepEqual([p[0].invoices, p[0].value, p[0].returnedPct, p[0].priceChangePct], [2, 200, 10, 10]);
});

test('health score: weighted parts with their rules; parts with no data are left out, not guessed', () => {
  const rows = [{ code: 'A', rate: 1, daysCover: 10, value: 400, riskValue: 0 }, { code: 'B', rate: 0, value: 450, dead: true, riskValue: 0 }];
  const h = healthScore({ rows, data: { items, sales: [{ date: d(2026, 10, 1), code: 'A', qty: 10, price: 50, cost: 40 }] }, today: TODAY });
  const part = Object.fromEntries(h.parts.map((p) => [p.key, p.value]));
  assert.equal(part.margin, 80, '20% margin of a 25% target');
  assert.equal(part.availability, 100);
  assert.equal(part.expenses, null, 'no expenses recorded');
  assert.ok(h.score > 0 && h.score <= 100);
  assert.ok(h.missing.includes('المصروفات'));
  assert.ok(h.parts.every((p) => p.rule));
});

test('forecast: day-of-week pattern, an error measured on the last 4 weeks, and no forecast without history', () => {
  const sales = [];
  for (let k = 1; k <= 120; k++) { const day = new Date(2026, 9, 30 - k + 1); sales.push({ date: day, code: 'A', qty: day.getDay() === 5 ? 1 : 3 }); }
  const f = forecast({ items, sales }, 'A', TODAY, 7);
  assert.equal(f.enough, true);
  assert.ok(Math.abs(f.total - (6 * 3 + 1)) < 0.5, `a week: ${f.total}`);
  assert.ok(f.error < 5, 'a steady pattern is predicted well');
  const plan = stockoutPlan({ qty: 10 }, f, TODAY, 30);
  assert.ok(plan.daysLeft >= 3 && plan.daysLeft <= 4);
  assert.equal(forecast({ items, sales: sales.slice(0, 10) }, 'A', TODAY).enough, false);
});

test('unusual activity: a cashier giving much more discount, a drawer that did not match — with the numbers', () => {
  const receipts = [];
  for (let k = 0; k < 12; k++) receipts.push({ kind: 'sale', total: 90, discount: 10, employee_name: 'أ', sold_at: '2026-10-20T10:00:00', number: `a${k}` });
  for (let k = 0; k < 12; k++) receipts.push({ kind: 'sale', total: 100, discount: 0, employee_name: 'ب', sold_at: '2026-10-20T10:00:00', number: `b${k}` });
  const a = anomalies({ receipts, shifts: [{ closed_at: '2026-10-25T22:00:00', expected_cash: 1000, counted_cash: 850, employee_name: 'ب' }], today: TODAY });
  assert.ok(a.some((x) => x.kind === 'discount' && /«أ»/.test(x.title) && /10%/.test(x.evidence)));
  assert.equal(a[0].kind, 'drawer');
  assert.match(a[0].evidence, /1000/);
});

test('alerts and recommendations come with what they are based on', () => {
  const A = { rows: [{ code: 'C', name: 'شاش', rate: 1, qty: 0, expDays: null }], reorder: [], expiring: [{ code: 'A', name: 'بانادول', expDays: 20, atRisk: 3, riskValue: 120 }], deadStock: [{ code: 'B', name: 'كريم', value: 450 }] };
  const al = alerts({ A, overviewData: { month: { growth: -20 } }, today: TODAY });
  assert.deepEqual(al.map((x) => x.level), ['crit', 'warn', 'warn', 'info']);
  const rec = recommendations({ A, classes: { losing: [], volume: [] }, trend: { up: [] }, health: { parts: [] } });
  assert.equal(rec[0].priority, 'high');
  assert.match(rec[0].data, /بانادول/);
  assert.ok(rec.every((r) => r.benefit && r.confidence && r.risk && r.action));
});
