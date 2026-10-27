import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  simplifiedRate, partnerSummary, ledger, UNASSIGNED, profitAt, breakEven, targetFloor, suggestOffer, analyze, mapRow, toDate, parseSheet, DAY, toExport,
} from '../src/core.js';

const today = new Date(2026, 9, 24); // 24 Oct 2026, local midnight
const day = (n) => new Date(2026, 9, 24 + n); // calendar days (DST-safe)
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('simplified tax brackets (Law 6/2025)', () => {
  assert.equal(simplifiedRate(400000), 0.004);
  assert.equal(simplifiedRate(500000), 0.005);
  assert.equal(simplifiedRate(2500000), 0.0075);
  assert.equal(simplifiedRate(9999999), 0.01);
  assert.equal(simplifiedRate(20000000), 0.015);
  assert.equal(simplifiedRate(20000001), null);
});

test('profit per box: the 100 EGP example', () => {
  const p = profitAt(100, { cost: 78 }, { taxRate: 0.0075, overheadRate: 0.10 });
  near(p.tax, 0.75);
  near(p.over, 10);
  near(p.net, 11.25);
  near(p.pct, 11.25);
});

test('break-even and target floor', () => {
  const rates = { taxRate: 0.01, overheadRate: 0.09 };
  const be = breakEven({ cost: 90 }, rates);
  near(be, 100);
  near(profitAt(be, { cost: 90 }, rates).net, 0);
  const tf = targetFloor({ cost: 80 }, rates, 10);
  near(profitAt(tf, { cost: 80 }, rates).pct, 10);
  assert.equal(targetFloor({ cost: 80 }, { taxRate: 0.5, overheadRate: 0.5 }, 10), null);
});

test('offer price never below cost when urgent, never below break-even otherwise', () => {
  const rates = { taxRate: 0.01, overheadRate: 0.10 };
  const urgent = suggestOffer({ cost: 300, price: 320, expDays: 10 }, rates);
  assert.ok(urgent >= 300 && urgent <= 320, String(urgent));
  // break-even (337) is above the price: no discount at all
  assert.equal(suggestOffer({ cost: 300, price: 320, expDays: null }, rates), 320);
  const dead = suggestOffer({ cost: 200, price: 320, expDays: null }, rates);
  assert.ok(dead >= breakEven({ cost: 200 }, rates) && dead <= 320, String(dead));
  const roomy = suggestOffer({ cost: 100, price: 200, expDays: 200 }, rates);
  assert.equal(roomy, 170); // 15% off, still above break-even
});

test('analyze: reorder, expiry risk, dead stock', () => {
  const data = {
    items: [
      { code: 'A', name: 'fast', category: 'دواء', cost: 10, price: 15, qty: 5, expiry: day(400) },
      { code: 'B', name: 'expiring', category: 'تجميل', cost: 100, price: 150, qty: 10, expiry: day(20) },
      { code: 'C', name: 'dead', category: 'تجميل', cost: 50, price: 80, qty: 4, expiry: day(400) },
    ],
    sales: [],
  };
  for (let d = 30; d >= 1; d--) {
    data.sales.push({ date: day(-d), code: 'A', qty: 2 }); // 2/day → 5 in stock lasts 2.5 days
    if (d % 10 === 0) data.sales.push({ date: day(-d), code: 'B', qty: 1 }); // 0.1/day
  }
  const r = analyze(data, { lead: 3, cover: 30 }, today);
  const A = r.rows.find((x) => x.code === 'A');
  const B = r.rows.find((x) => x.code === 'B');
  near(A.rate, 2);
  assert.equal(A.order, 55); // 2*30 - 5
  assert.equal(B.expDays, 20);
  assert.equal(B.atRisk, 8); // expects to sell 2 in 20 days → 8 at risk
  assert.deepEqual(r.deadStock.map((x) => x.code), ['C']);
  assert.deepEqual(r.reorder.map((x) => x.code), ['A']);
});

test('analyze: tax mode and overhead', () => {
  const data = { items: [{ code: 'A', cost: 10, price: 100, qty: 1 }], sales: [] };
  for (let d = 30; d >= 1; d--) data.sales.push({ date: day(-d), code: 'A', qty: 10 }); // 1000/day ≈ 30,000/month
  const r = analyze(data, { taxMode: 'simplified', expenses: 3000 }, today);
  near(r.monthlySales, 30000, 1);
  assert.equal(r.taxRate, 0.004); // ~360k/year
  near(r.overheadRate, 0.1);
  assert.equal(analyze(data, { taxMode: 'unsure' }, today).taxRate, 0);
  assert.equal(analyze(data, { taxMode: 'custom', customTax: 2 }, today).taxRate, 0.02);
});

test('headers in Arabic or English', () => {
  assert.deepEqual(mapRow({ 'الكود': 'X1', 'سعر الشراء': 5, ' Qty ': 3 }), { code: 'X1', cost: 5, qty: 3 });
});

test('dates: Egyptian dd/mm/yyyy, Excel serial, ISO', () => {
  assert.equal(toDate('05/11/2026').getMonth(), 10); // 5 Nov
  assert.equal(toDate('5-11-26').getFullYear(), 2026);
  assert.equal(toDate(45000).getUTCFullYear(), 2023);
  assert.equal(toDate('2026-10-24').getDate(), 24);
  assert.equal(toDate(''), null);
  assert.equal(toDate('not a date'), null);
});

test('parseSheet detects items vs sales', () => {
  const items = parseSheet([{ 'الكود': 'A', 'الصنف': 'x', 'سعر الشراء': 10, 'سعر البيع': 12, 'الكمية': 3, 'الصلاحية': '01/01/2027' }]);
  assert.equal(items.items.length, 1);
  assert.equal(items.items[0].expiry.getFullYear(), 2027);
  const sales = parseSheet([{ 'التاريخ': '20/10/2026', 'الكود': 'A', 'الكمية': 2 }, { 'التاريخ': '', 'الكود': 'A', 'الكمية': 1 }]);
  assert.equal(sales.sales.length, 1);
});

test('partners: totals split per owner, shared costs by share of sales', () => {
  const data = {
    items: [
      { code: 'A', owner: 'الشريك أ', cost: 80, price: 100, qty: 10 },
      { code: 'B', owner: 'الشريك ب', cost: 40, price: 50, qty: 4 },
      { code: 'C', cost: 10, price: 20, qty: 1 },
    ],
    sales: [],
  };
  for (let d = 30; d >= 1; d--) { data.sales.push({ date: day(-d), code: 'A', qty: 1 }, { date: day(-d), code: 'B', qty: 2 }); }
  // monthly sales: A 3000 + B 3000 = 6000; expenses 600 → 10% each
  const A = analyze(data, { expenses: 600 }, today);
  const s = partnerSummary(A);
  const a = s.find((x) => x.owner === 'الشريك أ');
  const b = s.find((x) => x.owner === 'الشريك ب');
  near(a.monthlySales, 3000, 1);
  near(a.monthlyNet, 30 * (100 - 80 - 10), 1); // 300
  near(b.monthlyNet, 60 * (50 - 40 - 5), 1); // 300
  near(a.stockVal, 800);
  assert.ok(s.some((x) => x.owner === UNASSIGNED));
  near(a.monthlyNet + b.monthlyNet, 6000 - 30 * 80 - 60 * 40 - 600, 1); // shares add up to the whole
});

test('parseSheet reads the owner column', () => {
  const r = parseSheet([{ 'الصنف': 'x', 'سعر الشراء': 1, 'الشريك': 'محمد' }, { 'الصنف': 'y', 'سعر الشراء': 1 }]);
  assert.equal(r.items[0].owner, 'محمد');
  assert.equal(r.items[1].owner, UNASSIGNED);
});

test('parseSheet: sales with real price/discount, purchases, losses', () => {
  const s = parseSheet([{ 'التاريخ': '20/10/2026', 'الكود': 'A', 'الكمية': 2, 'السعر': 90, 'الخصم': 5 }]);
  assert.deepEqual([s.sales[0].price, s.sales[0].discount], [90, 5]);
  const p = parseSheet([{ 'التاريخ': '01/10/2026', 'الكود': 'A', 'الكمية': 10, 'سعر الشراء': 70 }]);
  assert.equal(p.purchases[0].cost, 70);
  const l = parseSheet([{ 'التاريخ': '05/10/2026', 'الكود': 'A', 'الكمية': 1, 'السبب': 'منتهي' }]);
  assert.equal(l.losses[0].reason, 'منتهي');
});

test('ledger: bought, sold, discount, losses, net', () => {
  const data = {
    items: [{ code: 'A', name: 'a', owner: 'x', cost: 70, price: 100 }],
    purchases: [{ date: day(-20), code: 'A', qty: 10, cost: 70 }],
    sales: [
      { date: day(-10), code: 'A', qty: 2 }, // 200 at list price
      { date: day(-5), code: 'A', qty: 1, price: 90 }, // 10 off
      { date: day(-4), code: 'A', qty: 1, discount: 5 }, // 5 off
      { date: day(-60), code: 'A', qty: 9 }, // outside the period
    ],
    losses: [{ date: day(-3), code: 'A', qty: 1, reason: 'منتهي' }],
  };
  const L = ledger(data, { taxRate: 0.01, overheadRate: 0.1 }, day(-30), today);
  const t = L.totals;
  assert.equal(t.bought, 700);
  assert.equal(t.soldQty, 4);
  assert.equal(t.listValue, 400);
  assert.equal(t.discount, 15);
  assert.equal(t.revenue, 385);
  assert.equal(t.cogs, 280);
  assert.equal(t.lost, 70);
  near(t.net, 385 - 280 - 3.85 - 38.5 - 70); // -7.35: the expired box turned a profit into a loss
});

test('batches: oldest sells first, risk counted per batch', () => {
  // 1 unit/day. Batch A: 10 units expiring in 20 days → all sell. Batch B: 30 units expiring in 25 days:
  // 25 units sell in 25 days, the first 10 from A, so 15 from B → 15 of B at risk. Batch C: far away.
  const data = {
    items: [{ code: 'X', name: 'x', cost: 10, price: 12, qty: 0, batches: [
      { qty: 30, expiry: day(25) }, { qty: 10, expiry: day(20) }, { qty: 50, expiry: day(400) },
    ] }],
    sales: Array.from({ length: 30 }, (_, i) => ({ date: day(-30 + i), code: 'X', qty: 1 })),
  };
  const [x] = analyze(data, {}, today).rows;
  assert.equal(x.qty, 90);
  assert.equal(x.atRisk, 15);
  assert.equal(x.expDays, 25); // first batch actually at risk
  assert.deepEqual(x.batchRisk.map((b) => b.atRisk), [0, 15, 0]);
});

test('batches: a single expiry behaves like one batch', () => {
  const one = { code: 'Y', name: 'y', cost: 1, price: 2, qty: 10, expiry: day(20) };
  const two = { code: 'Y', name: 'y', cost: 1, price: 2, qty: 0, batches: [{ qty: 10, expiry: day(20) }] };
  const sales = [{ date: day(-10), code: 'Y', qty: 7 }];
  assert.equal(analyze({ items: [one], sales }, {}, today).rows[0].atRisk, analyze({ items: [two], sales }, {}, today).rows[0].atRisk);
});

test('connector export → analyze → morning report (end to end)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fromExport } = await import('../src/core.js');
  const { morningReport } = await import('../src/report.js');
  const data = fromExport(JSON.parse(readFileSync(new URL('./fixtures/export.json', import.meta.url), 'utf8')));
  const sun = data.items.find((i) => i.code === '202');
  assert.equal(sun.qty, 11);
  assert.equal(sun.batches.length, 2);
  assert.equal(data.items[0].owner, UNASSIGNED);
  near(data.sales[0].price, 51);
  const A = analyze(data, { expWin: 90 }, today);
  assert.deepEqual(A.reorder.map((r) => r.code), ['101']); // 42 sold in ~14+ days, 3 left
  assert.deepEqual(A.expiring.map((r) => r.code), ['202']); // the batch expiring end of November
  assert.deepEqual(A.deadStock.map((r) => r.code), ['303']); // never sold
  const t = morningReport(A, { pharmacyName: 'تجربة', date: today });
  assert.match(t, /Sun cream SPF50/);
  assert.match(t, /Panadol Extra/);
  assert.match(t, /Old hair oil/);
});

test('toExport → fromExport keeps the numbers (shared snapshot round trip)', async () => {
  const { toExport, fromExport } = await import('../src/core.js');
  const data = {
    items: [
      { code: 'A', name: 'a', category: 'تجميل', owner: 'x', cost: 10, price: 20, qty: 5, expiry: day(30) },
      { code: 'B', name: 'b', category: 'دواء', owner: UNASSIGNED, cost: 5, price: 7, qty: 9, expiry: null, batches: [{ qty: 4, expiry: day(10) }, { qty: 5, expiry: day(200) }] },
    ],
    sales: [{ date: day(-3), code: 'A', qty: 2, price: 18 }, { date: day(-2), code: 'B', qty: 1 }, { date: day(-1), code: 'A', qty: 1, discount: 2 }],
    purchases: [{ date: day(-20), code: 'A', qty: 8, cost: 10 }],
    losses: [{ date: day(-5), code: 'B', qty: 1, reason: 'تالف' }],
  };
  const back = fromExport(JSON.parse(JSON.stringify(toExport(data))));
  const rates = { taxRate: 0.01, overheadRate: 0.1 };
  assert.deepEqual(ledger(back, rates).totals, ledger(data, rates).totals);
  const a1 = analyze(data, {}, today).rows.map((r) => [r.code, r.qty, r.atRisk, r.order]);
  const a2 = analyze(back, {}, today).rows.map((r) => [r.code, r.qty, r.atRisk, r.order]);
  assert.deepEqual(a2, a1);
});

test('toExport drops invisible control characters the database refuses', () => {
  const out = toExport({ items: [{ code: 'A1\u0000', name: 'بانادول\u0000 ', category: 'x\u0007', owner: null, cost: 1, price: 2, qty: 3, expiry: null }], sales: [{ code: 'A1\u0000', date: new Date(2026, 0, 2), qty: 1, price: 2 }] });
  assert.equal(out.items[0].code, 'A1');
  assert.equal(out.items[0].name, 'بانادول');
  assert.equal(out.items[0].category, 'x');
  assert.equal(out.sales[0].code, 'A1');
  assert.ok(!JSON.stringify(out).includes('\\u0000'));
});
