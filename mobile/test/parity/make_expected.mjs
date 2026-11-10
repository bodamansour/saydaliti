// The app's numbers must be the website's numbers. This script builds one varied pharmacy (two branches,
// uploads, cashier receipts and returns, purchases and returns to suppliers, stock moves, expenses, the
// treasury) and works it out with the website's own code (src/*.js), the same way the dashboard does
// (src/app.js setView and render). test/parity_test.dart works out the same scenario in Dart and must
// get the same answers.
//   node mobile/test/parity/make_expected.mjs   → mobile/test/parity/scenario.json and expected.json
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, expiryBands, fromExport, ledger, settingsFromSaved, startOfDay } from '../../../src/core.js';
import { liveData, stockValue, supplierBalances } from '../../../src/inventory.js';
import { overview } from '../../../src/insights.js';
import { mergeBranches, monthlyFromRecorded } from '../../../src/branches-expenses.js';
import { treasury } from '../../../src/treasury.js';
import { ordersBySupplier, orderMessage } from '../../../src/ordering.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// A fixed, repeatable "random" (mulberry32).
let seed = 20261110;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (list) => list[Math.floor(rnd() * list.length)];
const NOW = new Date(2026, 10, 10, 18, 30, 0); // 10 November 2026, 18:30 local time
const TODAY = startOfDay(NOW);
const iso = (d) => d.toISOString();
const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n, h = 10) => { const d = new Date(TODAY); d.setDate(d.getDate() - n); d.setHours(h, int(0, 59), 0, 0); return d; };
let idn = 0;
const id = (p) => `${p}-${String(++idn).padStart(5, '0')}`;

const CATS = ['دواء', 'تجميل', 'مستلزمات', null, 'Medicine'];
const OWNERS = [null, 'Partner A', 'Partner B'];
const BRANCHES = [{ id: 'b1', name: 'الفرع الرئيسي' }, { id: 'b2', name: 'فرع المعادي' }];

// ---------- Two uploads from the pharmacy program, one per branch ----------
function upload(n, branch) {
  const items = [], batches = [], sales = [], purchases = [], losses = [];
  for (let i = 0; i < n; i++) {
    const code = String(1000 + i);
    const cost = int(5, 400) + (rnd() < 0.3 ? 0.25 : 0);
    const item = { code, name: `صنف ${code}`, category: pick(CATS), cost, price: Math.round(cost * (1.1 + rnd() * 0.4) * 100) / 100, owner: pick(OWNERS) };
    if (rnd() < 0.2) item.min = int(2, 20);
    if (rnd() < 0.15) item.strips = int(2, 4);
    const style = rnd();
    if (style < 0.55) { // batches with expiry
      const k = int(1, 3);
      for (let j = 0; j < k; j++) {
        const exp = daysAgo(-int(-20, 500));
        batches.push({ code, qty: int(0, 30), expiry: rnd() < 0.8 ? dayStr(exp) : `${exp.getDate()}/${exp.getMonth() + 1}/${exp.getFullYear()}`, ...(rnd() < 0.5 ? { cost: cost + int(-3, 3) } : {}), ...(rnd() < 0.2 ? { price: item.price + 1 } : {}) });
      }
    } else if (style < 0.85) { item.qty = int(-2, 40); item.expiry = rnd() < 0.6 ? dayStr(daysAgo(-int(-10, 400))) : null; } // one stock figure
    else item.qty = null;
    items.push(item);
    const selling = rnd();
    if (selling > 0.25) {
      const k = int(1, 12);
      for (let j = 0; j < k; j++) {
        const qty = int(1, 6);
        sales.push({ code, date: dayStr(daysAgo(int(1, 200))), qty, amount: Math.round(qty * item.price * (rnd() < 0.2 ? 0.9 : 1) * 100) / 100, ...(rnd() < 0.1 ? { discount: 2 } : {}), ...(rnd() < 0.3 ? { cost: cost } : {}) });
      }
    }
    if (rnd() < 0.2) purchases.push({ code, date: dayStr(daysAgo(int(5, 90))), qty: int(5, 20), cost });
    if (rnd() < 0.05) losses.push({ code, date: dayStr(daysAgo(int(5, 90))), qty: int(1, 3), reason: 'تالف' });
  }
  // A few unusual lines: an Excel date, an empty date, a zero quantity.
  sales.push({ code: '1000', date: 46000, qty: 1, amount: 10 });
  sales.push({ code: '1001', date: '', qty: 2, amount: 10 });
  sales.push({ code: '1002', date: dayStr(daysAgo(3)), qty: 0, amount: 10 });
  return { exportedAt: iso(daysAgo(20)), branch, items, batches, sales, purchases, losses };
}
const SNAP = {
  b1: { created_at: iso(daysAgo(20, 9)), data: upload(260, 'b1') },
  b2: { created_at: iso(daysAgo(12, 9)), data: upload(140, 'b2') },
};

// ---------- What was done here after the uploads ----------
const catalog = [];
for (let i = 0; i < 25; i++) {
  const code = rnd() < 0.6 ? String(1000 + int(0, 259)) : `N${i}`;
  catalog.push({ id: id('cat'), code, name: `اسم جديد ${i}`, category: pick(['دواء', 'تجميل', null]), price: rnd() < 0.7 ? int(10, 300) : null, cost: rnd() < 0.5 ? int(5, 200) : null,
    strips: rnd() < 0.2 ? int(1, 3) : null, pills: null, generic: rnd() < 0.3 ? 'Paracetamol' : null, maker: null, min_qty: rnd() < 0.3 ? int(0, 8) : null, tax_pct: rnd() < 0.1 ? 14 : null,
    image_at: null, created_at: iso(daysAgo(int(1, 40))), updated_at: rnd() < 0.5 ? iso(daysAgo(int(0, 10))) : null });
}
const SUPPLIERS = [
  { id: 's1', name: 'Ibn Sina', phone: '201000000001', discounts: { all: 2, medicine: 5 } },
  { id: 's2', name: 'United', phone: '', discounts: { all: 3, cosmetics: 10 } },
  { id: 's3', name: 'Pharmaoverseas', phone: '201000000003', discounts: { all: '' } },
];
const purchases = [];
for (let i = 0; i < 40; i++) {
  const branch = pick(['b1', 'b2', null]);
  const ret = rnd() < 0.15;
  const lines = [];
  for (let j = int(1, 5); j > 0; j--) {
    const code = rnd() < 0.9 ? String(1000 + int(0, 259)) : `P${i}`;
    lines.push({ code, name: `مشتريات ${code}`, qty: int(1, 20), bonus: rnd() < 0.3 ? int(1, 3) : 0, cost: rnd() < 0.9 ? int(5, 300) : 0, price: rnd() < 0.5 ? int(10, 350) : 0,
      expiry: rnd() < 0.8 ? dayStr(daysAgo(-int(30, 600))) : null, ...(rnd() < 0.2 ? { lot: `L${int(1, 99)}` } : {}) });
  }
  const s = pick([...SUPPLIERS, null]);
  const total = lines.reduce((a, l) => a + l.qty * l.cost, 0);
  const created = daysAgo(int(0, 30), int(8, 22));
  purchases.push({ id: id('pur'), branch_id: branch, supplier_id: s?.id ?? null, supplier_name: s?.name ?? (rnd() < 0.5 ? 'مورد بالاسم' : null), invoice_no: `I${i}`,
    received_on: dayStr(created), lines, total, paid: rnd() < 0.5 ? total : int(0, Math.max(0, Math.floor(total))), note: null, kind: ret ? 'return' : 'purchase', created_at: iso(created) });
}
const sales = [];
for (let i = 0; i < 160; i++) {
  const branch = pick(['b1', 'b1', 'b2', null]);
  const lines = [];
  for (let j = int(1, 4); j > 0; j--) {
    const code = String(1000 + int(0, 259));
    const per = rnd() < 0.15 ? int(2, 3) : 1;
    lines.push({ code, name: `صنف ${code}`, qty: int(1, 4), price: int(5, 300) + (rnd() < 0.3 ? 0.5 : 0), discount: rnd() < 0.15 ? int(1, 5) : 0, ...(per > 1 ? { per } : {}), ...(rnd() < 0.1 ? { bp: int(10, 200) } : {}) });
  }
  const sold = daysAgo(int(0, 25), int(8, 23));
  const total = lines.reduce((a, l) => a + l.price * l.qty - l.discount, 0);
  sales.push({ id: id('pos'), branch_id: branch, number: i + 1, sold_at: iso(sold), kind: 'sale', lines, total, discount: rnd() < 0.1 ? 5 : 0, paid: total,
    payment: pick(['cash', 'cash', 'card', 'wallet', 'credit']), credit: 0, return_of: null, is_void: false });
}
// Returns of some of those receipts (whole and partial), and one with no receipt.
for (const s of sales.filter(() => rnd() < 0.1)) {
  const lines = s.lines.slice(0, 1).map((l) => ({ ...l, qty: Math.max(1, l.qty - (rnd() < 0.5 ? 1 : 0)) }));
  const total = -lines.reduce((a, l) => a + l.price * l.qty - l.discount, 0);
  sales.push({ id: id('ret'), branch_id: s.branch_id, number: 1000 + sales.length, sold_at: iso(new Date(Date.parse(s.sold_at) + 3600000)), kind: 'return', lines, total, discount: 0, paid: total,
    payment: s.payment, credit: 0, return_of: s.id, is_void: rnd() < 0.3 });
}
sales.push({ id: id('ret'), branch_id: 'b1', number: 9999, sold_at: iso(daysAgo(2, 15)), kind: 'return', lines: [{ code: '1005', name: 'x', qty: 1, price: 20, discount: 0 }], total: -20, discount: 0, paid: -20, payment: 'cash', credit: 0, return_of: null, note: 'من غير فاتورة', is_void: false });
const moves = [];
for (let i = 0; i < 60; i++) {
  const kind = pick(['count', 'damaged', 'expired', 'withdrawal', 'return', 'transfer']);
  const neg = kind === 'damaged' || kind === 'expired' || kind === 'withdrawal' || rnd() < 0.5;
  const row = { id: id('mv'), branch_id: pick(['b1', 'b2', null]), code: rnd() < 0.95 ? String(1000 + int(0, 259)) : `M${i}`, qty: (neg ? -1 : 1) * int(1, 8), kind, cost: rnd() < 0.4 ? int(5, 100) : null,
    ref: null, note: null, person: kind === 'withdrawal' ? 'Partner A' : null, happened_at: iso(daysAgo(int(0, 25), int(8, 22))), created_at: iso(daysAgo(0)) };
  // Most moves name a batch's expiry (or say "no expiry"); a few do not say at all.
  if (rnd() < 0.85) row.expiry = rnd() < 0.6 ? dayStr(daysAgo(-int(10, 400))) : null;
  moves.push(row);
}
const expenses = [];
for (let i = 0; i < 45; i++) {
  const d = daysAgo(int(0, 120), int(9, 21));
  expenses.push({ id: id('ex'), branch_id: pick(['b1', 'b2', null]), spent_on: dayStr(d), kind: pick(['electricity', 'rent', 'salaries', 'other', 'withdrawal', 'supplies']), amount: int(50, 3000) + 0.5, note: null, person: null, shift_id: null, created_at: iso(d) });
}
const cashMoves = [
  { id: id('cm'), branch_id: null, moved_at: iso(daysAgo(18, 20)), kind: 'count', amount: 15000, note: null, created_by: 'u1', created_at: iso(daysAgo(18, 20)) },
  { id: id('cm'), branch_id: null, moved_at: iso(daysAgo(9, 21)), kind: 'count', amount: 22000.5, note: null, created_by: 'u1', created_at: iso(daysAgo(9, 21)) },
  { id: id('cm'), branch_id: null, moved_at: iso(daysAgo(6, 12)), kind: 'to_bank', amount: 5000, note: null, created_by: 'u1', created_at: iso(daysAgo(6, 12)) },
  { id: id('cm'), branch_id: null, moved_at: iso(daysAgo(4, 12)), kind: 'from_bank', amount: 1200, note: null, created_by: 'u1', created_at: iso(daysAgo(4, 12)) },
  { id: id('cm'), branch_id: null, moved_at: iso(daysAgo(1, 12)), kind: 'adjust', amount: -35.25, note: null, created_by: 'u1', created_at: iso(daysAgo(1, 12)) },
];
const supplierPayments = [];
for (let i = 0; i < 12; i++) { const s = pick(SUPPLIERS); const d = daysAgo(int(0, 30)); supplierPayments.push({ id: id('sp'), supplier_id: s.id, supplier_name: s.name, paid_on: dayStr(d), amount: int(100, 5000), note: null, created_at: iso(d) }); }
const customerPayments = [];
for (let i = 0; i < 10; i++) { const d = daysAgo(int(0, 30)); customerPayments.push({ id: id('cp'), customer_id: 'c1', amount: int(20, 900), paid_on: dayStr(d), note: null, created_at: iso(d) }); }
const settings = { phName: 'صيدلية التجربة', taxMode: 'simplified', exRent: '3000', exUtil: 800, exSal: '', target: '12', expWin: '120', lead: '2', cover: '', suppliers: SUPPLIERS,
  supplierFor: { 1003: 's3', 1010: 's2', N1: 'missing' } };

// The website loads every table newest first (src/app.js loadTable).
const newest = (col) => (a, b) => String(b[col] ?? '').localeCompare(String(a[col] ?? ''));
catalog.sort(newest('created_at')); purchases.sort(newest('received_on')); sales.sort(newest('sold_at')); moves.sort(newest('happened_at'));
expenses.sort(newest('spent_on')); cashMoves.sort(newest('moved_at')); supplierPayments.sort(newest('paid_on')); customerPayments.sort(newest('paid_on'));

const scenario = { now: NOW.getTime(), branches: BRANCHES, mainBranchId: 'b1', settings, snapshots: SNAP, catalog, purchases, sales, moves, expenses, cashMoves, supplierPayments, customerPayments };

// ---------- The dashboard's numbers (src/app.js) ----------
const key = (id) => id ?? 'main';
const inBranch = (b) => (r) => (r.branch_id ?? 'b1') === (b?.id ?? null);
const round = (n) => (n === null || n === undefined ? null : Number.isFinite(n) ? n : String(n));
const ms = (d) => (d ? d.getTime() : null);

function view(branch) {
  const shown = branch === 'all' ? BRANCHES : BRANCHES.filter((b) => key(b.id) === branch);
  const parts = shown.map((b) => {
    const s = SNAP[key(b.id)];
    const mine = inBranch(b);
    return liveData(s ? fromExport(s.data) : null, s?.created_at, { catalog, purchases: purchases.filter(mine), sales: sales.filter(mine), moves: moves.filter(mine) });
  }).filter((d) => d.items.length);
  const data = mergeBranches(parts) || { items: [], sales: [], purchases: [], losses: [], drawings: [] };
  const branchId = branch === 'all' ? 'all' : shown[0].id;
  let s = settingsFromSaved(Object.fromEntries(['phName', 'waNumbers', 'taxMode', 'customTax', 'exRent', 'exUtil', 'exSal', 'exOther', 'target', 'expWin', 'lead', 'cover']
    .map((f) => [f, settings[f] === undefined ? { customTax: '1', target: '10', expWin: '90', lead: '3', cover: '30', taxMode: 'unsure' }[f] ?? '' : settings[f] === null ? '' : String(settings[f])])));
  const recorded = monthlyFromRecorded(expenses, TODAY, 90, branchId);
  if (recorded) s = { ...s, expenses: recorded, expensesRecorded: true };
  const A = analyze(data, s, TODAY);
  const receipts = sales.filter((x) => branch === 'all' || inBranch({ id: shown[0].id })(x));
  const o = overview(data, { receipts, expenses, today: TODAY, branchId });
  const span = (x) => ({ sales: x.sales, cogs: x.cogs, gross: x.gross, qty: x.qty, before: x.before, growth: x.growth });
  const L = ledger(data, A, new Date(TODAY.getFullYear(), TODAY.getMonth(), 1), new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + 1)).totals;
  const groups = ordersBySupplier(A.reorder, SUPPLIERS, settings.supplierFor);
  return {
    settings: { taxMode: s.taxMode, customTax: s.customTax, expenses: s.expenses, target: s.target, expWin: s.expWin, lead: s.lead, cover: s.cover },
    items: [...data.items].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)).map((i) => [i.code, i.name, i.category, i.owner, i.qty, stockValue(i), ms(i.expiry), i.price, i.cost, i.batches?.length ?? 0, i.min ?? null, i.strips ?? null]),
    sales: [data.sales.length, data.sales.reduce((a, x) => a + x.qty, 0), data.sales.reduce((a, x) => a + (x.cost ?? 0), 0), data.sales.reduce((a, x) => a + (x.discount ?? 0), 0)],
    purchases: [data.purchases.length, data.purchases.reduce((a, x) => a + x.qty * x.cost, 0)],
    losses: [data.losses.length, data.losses.reduce((a, x) => a + x.qty * (x.cost ?? 0), 0)],
    drawings: [data.drawings.length, data.drawings.reduce((a, x) => a + x.value, 0)],
    analysis: {
      periodDays: A.periodDays, monthlySales: A.monthlySales, overheadRate: A.overheadRate, taxRate: A.taxRate, above: A.aboveSimplifiedCeiling,
      reorder: A.reorder.map((r) => [r.code, r.order, round(r.daysCover), r.belowMin]),
      expiring: A.expiring.map((r) => [r.code, r.atRisk, r.expDays, r.riskValue]),
      dead: A.deadStock.map((r) => [r.code, r.value, r.lastSale]),
      movers: A.movers.slice(0, 30).map((r) => [r.code, r.revenue, r.sold]),
    },
    bands: expiryBands(A.expiring, s.expWin).map((b) => [b.key, b.label, b.items, b.atRisk, b.value]),
    overview: { today: span(o.today), week: span(o.week), month: span(o.month), year: span(o.year), receiptsMonth: o.receipts.month, receiptAvg: o.receipts.avg, expenses: o.expenses, net: o.net,
      stock: o.stock, turnover: o.turnover, daysOfStock: o.daysOfStock, basisDays: o.basisDays, items: o.items, inStock: o.inStock, out: o.out },
    ledger: L,
    orders: groups.map((g) => [g.supplier?.id ?? null, g.lines.map((l) => [l.code, l.qty, l.unit, l.pct]), g.cost, g.saved]),
    message: groups.length ? orderMessage(groups[0], { pharmacyName: 'صيدلية التجربة', branchName: branch === 'all' ? '' : shown[0].name }) : null,
  };
}

const T = treasury({ moves: cashMoves, sales, customerPayments, expenses, supplierPayments, purchases }, NOW.getTime());
const expected = {
  views: Object.fromEntries(['all', 'b1', 'b2'].map((b) => [b, view(b)])),
  treasury: { since: T.since, start: T.start, parts: T.parts, cashIn: T.cashIn, cashOut: T.cashOut, balance: T.balance },
  suppliers: supplierBalances(purchases, supplierPayments).map((b) => [b.id, b.name, b.invoices, b.bought, b.returned, b.paid, b.due, b.last]),
};
writeFileSync(join(HERE, 'scenario.json'), JSON.stringify(scenario));
writeFileSync(join(HERE, 'expected.json'), JSON.stringify(expected));
const v = expected.views.all;
console.log(`scenario: ${v.items.length} items, ${v.sales[0]} sale lines; to order ${v.analysis.reorder.length}, expiring ${v.analysis.expiring.length}, dead ${v.analysis.dead.length}; treasury ${T.balance}`);
