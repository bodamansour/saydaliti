import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  simplifiedRate, partnerSummary, UNASSIGNED, profitAt, breakEven, targetFloor, suggestOffer, analyze, mapRow, toDate, parseSheet, DAY,
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
