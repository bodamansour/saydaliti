// The owner's insights: numbers for the overview, trends, profit classes, suppliers, the pharmacy
// health score, demand forecasts, unusual activity, alerts and recommendations.
// Pure and deterministic: every number comes from the pharmacy's own records, nothing is guessed.
// data: app data (items with qty/cost/price/batches, sales [{date, code, qty, price, discount, cost}],
// losses); receipts: cashier receipts (pos_sales rows); expenses: expense rows; today: Date at 00:00.
import { addDays, startOfDay } from './core.js';
import { expenseTotals } from './branches-expenses.js';

const DAY = 86400000;
const r2 = (n) => Math.round(n * 100) / 100;
const dkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sale$ = (s, list) => s.qty * (s.price ?? list.get(s.code) ?? 0) - (s.discount || 0);
const cost$ = (s, cost) => s.qty * (s.cost ?? cost.get(s.code) ?? 0);
const maps = (data) => ({ list: new Map(data.items.map((i) => [i.code, +i.price || 0])), cost: new Map(data.items.map((i) => [i.code, +i.cost || 0])) });

// Sales, cost and gross profit between two days [from, to).
export function periodTotals(data, from, to) {
  const { list, cost } = maps(data);
  let sales = 0, cogs = 0, qty = 0;
  for (const s of data.sales) if (s.date >= from && s.date < to) { sales += sale$(s, list); cogs += cost$(s, cost); qty += s.qty; }
  return { sales: r2(sales), cogs: r2(cogs), gross: r2(sales - cogs), qty: r2(qty) };
}
const growth = (now, before) => (before > 0 ? r2(((now - before) / before) * 100) : null);
export const stockValueOf = (items) => r2(items.reduce((a, i) => a + (i.batches?.length ? i.batches.reduce((x, b) => x + (b.qty > 0 ? b.qty * (b.cost ?? i.cost ?? 0) : 0), 0) : Math.max(0, i.qty || 0) * (i.cost || 0)), 0));

// ---------- The overview ----------
// Today / this week / this month / this year, each compared with the same stretch before it, the
// receipts (count and average), turnover and days of stock left.
export function overview(data, { receipts = [], expenses = [], today = startOfDay(), branchId = 'all' } = {}) {
  const t1 = addDays(today, 1);
  const weekStart = addDays(today, -((today.getDay() + 1) % 7)); // the Egyptian week starts on Saturday
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const span = (from) => {
    const days = Math.round((t1 - from) / DAY);
    const now = periodTotals(data, from, t1);
    const before = periodTotals(data, addDays(from, -days), from);
    return { ...now, before: before.sales, growth: growth(now.sales, before.sales) };
  };
  const monthBefore = (() => { // last month up to the same day
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const to = new Date(today.getFullYear(), today.getMonth() - 1, Math.min(today.getDate(), new Date(today.getFullYear(), today.getMonth(), 0).getDate()) + 1);
    return periodTotals(data, from, to);
  })();
  const month = periodTotals(data, monthStart, t1);
  const exp = expenseTotals(expenses, monthStart, t1, branchId);
  const sold = receipts.filter((x) => x.kind !== 'return');
  const inMonth = sold.filter((x) => new Date(x.sold_at) >= monthStart);
  const year365 = periodTotals(data, addDays(today, -365), t1);
  const firstSale = data.sales.reduce((m, s) => (s.date < m ? s.date : m), today);
  const days = Math.max(1, Math.min(365, Math.round((t1 - firstSale) / DAY)));
  const stock = stockValueOf(data.items);
  const cogsPerDay = year365.cogs / days;
  return {
    today: span(today), week: span(weekStart), month: { ...month, before: monthBefore.sales, growth: growth(month.sales, monthBefore.sales) }, year: span(yearStart),
    receipts: { month: inMonth.length, avg: inMonth.length ? r2(inMonth.reduce((a, x) => a + (+x.total || 0), 0) / inMonth.length) : null },
    expenses: r2(exp.operating), net: r2(month.gross - exp.operating),
    stock, turnover: stock > 0 && year365.cogs > 0 ? r2((year365.cogs / days) * 365 / stock) : null,
    daysOfStock: cogsPerDay > 0 ? Math.round(stock / cogsPerDay) : null, basisDays: days,
    items: data.items.length, inStock: data.items.filter((i) => i.qty > 0).length, out: data.items.filter((i) => i.qty <= 0 && i.min > 0).length,
  };
}

// The last n months: sales, gross profit, expenses and net (for the chart).
export function monthlySeries(data, expenses = [], today = startOfDay(), n = 12, branchId = 'all') {
  const out = [];
  for (let k = n - 1; k >= 0; k--) {
    const from = new Date(today.getFullYear(), today.getMonth() - k, 1);
    const to = new Date(today.getFullYear(), today.getMonth() - k + 1, 1);
    const t = periodTotals(data, from, to);
    const e = expenseTotals(expenses, from, to, branchId).operating;
    out.push({ key: dkey(from).slice(0, 7), sales: t.sales, gross: t.gross, expenses: r2(e), net: r2(t.gross - e) });
  }
  return out;
}

// Sales and gross profit per category over [from, to).
export function categoryPerformance(data, from, to) {
  const { list, cost } = maps(data);
  const cat = new Map(data.items.map((i) => [i.code, i.category || 'غير محدد']));
  const m = new Map();
  for (const s of data.sales) {
    if (s.date < from || s.date >= to) continue;
    const k = cat.get(s.code) || 'غير محدد';
    const o = m.get(k) || { category: k, sales: 0, gross: 0, items: new Set() };
    o.sales += sale$(s, list); o.gross += sale$(s, list) - cost$(s, cost); o.items.add(s.code);
    m.set(k, o);
  }
  return [...m.values()].map((o) => ({ category: o.category, sales: r2(o.sales), gross: r2(o.gross), margin: o.sales ? r2((o.gross / o.sales) * 100) : 0, items: o.items.size })).sort((a, b) => b.sales - a.sales);
}

// ---------- Trends ----------
// Items selling more or less: the last `days` days against the `days` before (boxes), for items
// with at least `minQty` boxes in one of the two.
export function trending(data, today = startOfDay(), days = 30, minQty = 5) {
  const t1 = addDays(today, 1), mid = addDays(t1, -days), t0 = addDays(mid, -days);
  const now = new Map(), before = new Map();
  for (const s of data.sales) {
    if (s.date >= mid && s.date < t1) now.set(s.code, (now.get(s.code) || 0) + s.qty);
    else if (s.date >= t0 && s.date < mid) before.set(s.code, (before.get(s.code) || 0) + s.qty);
  }
  const byCode = new Map(data.items.map((i) => [i.code, i]));
  const rows = [];
  for (const code of new Set([...now.keys(), ...before.keys()])) {
    const a = now.get(code) || 0, b = before.get(code) || 0;
    if (Math.max(a, b) < minQty || !byCode.has(code)) continue;
    rows.push({ code, name: byCode.get(code).name, now: r2(a), before: r2(b), change: b > 0 ? r2(((a - b) / b) * 100) : null, diff: r2(a - b) });
  }
  return {
    up: rows.filter((r) => r.diff > 0 && (r.change === null || r.change >= 25)).sort((x, y) => y.diff - x.diff).slice(0, 20),
    down: rows.filter((r) => r.diff < 0 && r.change <= -25).sort((x, y) => x.diff - y.diff).slice(0, 20),
  };
}

// ---------- Profit classes ----------
// Each item that sold in [from, to) by volume and margin: stars (sells a lot, good margin),
// volume (sells a lot, thin margin), niche (sells little, good margin), weak (little and thin),
// losing (sold below cost). "A lot" and "good" = above the median of the items that sold.
export function profitClasses(data, from, to) {
  const { list, cost } = maps(data);
  const m = new Map();
  for (const s of data.sales) {
    if (s.date < from || s.date >= to) continue;
    const o = m.get(s.code) || { qty: 0, sales: 0, cogs: 0 };
    o.qty += s.qty; o.sales += sale$(s, list); o.cogs += cost$(s, cost);
    m.set(s.code, o);
  }
  const byCode = new Map(data.items.map((i) => [i.code, i]));
  const rows = [...m].filter(([c, o]) => byCode.has(c) && o.sales > 0 && o.cogs > 0).map(([code, o]) => ({ code, name: byCode.get(code).name, qty: r2(o.qty), sales: r2(o.sales), gross: r2(o.sales - o.cogs), margin: r2(((o.sales - o.cogs) / o.sales) * 100) }));
  const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  const mq = med(rows.map((r) => r.qty)), mm = med(rows.map((r) => r.margin));
  const out = { stars: [], volume: [], niche: [], weak: [], losing: [], medianQty: mq, medianMargin: mm };
  for (const r of rows) {
    if (r.gross < 0) out.losing.push(r);
    else if (r.qty >= mq && r.margin >= mm) out.stars.push(r);
    else if (r.qty >= mq) out.volume.push(r);
    else if (r.margin >= mm) out.niche.push(r);
    else out.weak.push(r);
  }
  for (const k of ['stars', 'volume', 'niche', 'weak']) out[k].sort((a, b) => b.gross - a.gross);
  out.losing.sort((a, b) => a.gross - b.gross);
  return out;
}

// ---------- Suppliers ----------
// Per supplier: deliveries, value, how many items, returns (share of value), and the change in the
// buying price of the items bought from them more than once (first vs last price).
export function supplierPerformance(purchases) {
  const m = new Map();
  for (const p of purchases) {
    const k = p.supplier_id || `name:${p.supplier_name}`;
    const o = m.get(k) || { name: p.supplier_name || 'من غير مورد', invoices: 0, value: 0, returned: 0, items: new Set(), prices: new Map(), last: null };
    if (p.kind === 'return') o.returned += +p.total || 0;
    else {
      o.invoices += 1; o.value += +p.total || 0;
      if (!o.last || String(p.received_on) > o.last) o.last = String(p.received_on);
      for (const l of p.lines || []) {
        o.items.add(String(l.code));
        if (+l.cost > 0) { const list = o.prices.get(String(l.code)) || []; list.push([String(p.received_on), +l.cost]); o.prices.set(String(l.code), list); }
      }
    }
    m.set(k, o);
  }
  return [...m.values()].map((o) => {
    const changes = [...o.prices.values()].filter((l) => l.length > 1).map((l) => { l.sort((a, b) => a[0].localeCompare(b[0])); return (l.at(-1)[1] - l[0][1]) / l[0][1]; });
    return { name: o.name, invoices: o.invoices, value: r2(o.value), items: o.items.size, returnedPct: o.value ? r2((o.returned / o.value) * 100) : 0, priceChangePct: changes.length ? r2((changes.reduce((a, x) => a + x, 0) / changes.length) * 100) : null, last: o.last };
  }).sort((a, b) => b.value - a.value);
}

// ---------- Pharmacy health score ----------
// A guide, not a measurement: six parts, each scored 0–100 by a stated rule, weighted. The rules
// (and why) are written next to each part so the owner can see what moves the score.
export const HEALTH_PARTS = [
  ['margin', 'هامش الربح', 25, 'مجمل الربح ÷ المبيعات آخر 90 يوم: 25% أو أكتر = 100، صفر أو أقل = 0'],
  ['expiry', 'خسارة الصلاحية', 20, 'قيمة اللي ممكن ينتهي قبل ما يتباع ÷ قيمة المخزون: 0% = 100، 10% أو أكتر = 0'],
  ['dead', 'المخزون الراكد', 15, 'قيمة الراكد (45+ يوم من غير بيع) ÷ قيمة المخزون: 0% = 100، 40% أو أكتر = 0'],
  ['availability', 'توفر الأصناف', 15, 'الأصناف اللي بتتباع ورصيدها مكفّي أسبوع أو أكتر ÷ كل الأصناف اللي بتتباع'],
  ['turnover', 'دوران المخزون', 15, 'المخزون بيلف كام مرة في السنة: 8 مرات أو أكتر = 100، مرة أو أقل = 0'],
  ['expenses', 'المصروفات', 10, 'المصروفات ÷ مجمل الربح الشهر ده: 30% أو أقل = 100، 100% أو أكتر = 0'],
];
const lin = (x, good, bad) => Math.round(Math.max(0, Math.min(100, ((x - bad) / (good - bad)) * 100)));
export function healthScore({ rows, data, today = startOfDay(), expenses = [], branchId = 'all' }) {
  const t1 = addDays(today, 1);
  const p90 = periodTotals(data, addDays(today, -90), t1);
  const stock = stockValueOf(data.items);
  const risk = rows.reduce((a, r) => a + (r.riskValue || 0), 0);
  const dead = rows.filter((r) => r.dead).reduce((a, r) => a + (r.value || 0), 0);
  const selling = rows.filter((r) => r.rate > 0);
  const ok = selling.filter((r) => r.daysCover >= 7).length;
  const ov = overview(data, { expenses, today, branchId });
  const parts = {
    margin: p90.sales > 0 ? lin((p90.gross / p90.sales) * 100, 25, 0) : null,
    expiry: stock > 0 ? lin((risk / stock) * 100, 0, 10) : null,
    dead: stock > 0 ? lin((dead / stock) * 100, 0, 40) : null,
    availability: selling.length ? Math.round((ok / selling.length) * 100) : null,
    turnover: ov.turnover !== null ? lin(ov.turnover, 8, 1) : null,
    expenses: ov.month.gross > 0 && expenses.length ? lin((ov.expenses / ov.month.gross) * 100, 30, 100) : null,
  };
  const known = HEALTH_PARTS.filter(([k]) => parts[k] !== null);
  const w = known.reduce((a, [, , wt]) => a + wt, 0);
  const score = w ? Math.round(known.reduce((a, [k, , wt]) => a + parts[k] * wt, 0) / w) : null;
  return { score, parts: HEALTH_PARTS.map(([k, label, weight, rule]) => ({ key: k, label, weight, rule, value: parts[k] })), missing: HEALTH_PARTS.filter(([k]) => parts[k] === null).map(([, l]) => l) };
}

// ---------- Demand forecast ----------
// Boxes a day for the next `days` days: the average of the last 8 weeks, shaped by the day of the
// week (Friday is not Sunday). The error of the same method on the last 4 weeks (predicted from the
// 8 weeks before them) says how far to trust it. Fewer than 28 days of sales: no forecast.
export function forecast(data, code, today = startOfDay(), days = 14) {
  const c = String(code);
  const daily = new Map();
  for (const s of data.sales) if (String(s.code) === c) { const k = dkey(s.date); daily.set(k, (daily.get(k) || 0) + s.qty); }
  const first = data.sales.reduce((m, s) => (String(s.code) === c && s.date < m ? s.date : m), today);
  const history = Math.round((addDays(today, 1) - first) / DAY);
  if (history < 28) return { enough: false, history };
  const model = (end) => { // trained on the 56 days before `end`
    const byDow = Array(7).fill(0), nDow = Array(7).fill(0);
    let tot = 0;
    for (let k = 1; k <= 56; k++) { const d = addDays(end, -k); const q = daily.get(dkey(d)) || 0; byDow[d.getDay()] += q; nDow[d.getDay()] += 1; tot += q; }
    const avg = tot / 56;
    const factor = byDow.map((q, i) => (avg > 0 && nDow[i] ? q / nDow[i] / avg : 1));
    return { avg, at: (d) => avg * factor[d.getDay()] };
  };
  // Backtest: predict the last 28 days from the 56 before them.
  const testEnd = addDays(today, -27);
  const m0 = model(testEnd);
  let err = 0, act = 0;
  for (let k = 0; k < 28; k++) { const d = addDays(testEnd, k); const a = daily.get(dkey(d)) || 0; err += Math.abs(a - m0.at(d)); act += a; }
  const m = model(addDays(today, 1));
  const next = Array.from({ length: days }, (_, k) => { const d = addDays(today, k + 1); return { day: dkey(d), qty: r2(m.at(d)) }; });
  const total = r2(next.reduce((a, x) => a + x.qty, 0));
  return { enough: true, history, perDay: r2(m.avg), next, total, error: act > 0 ? r2((err / act) * 100) : null };
}
// When the shelf runs out at the forecast pace, and how much to order to cover `cover` days.
export function stockoutPlan(item, fc, today = startOfDay(), cover = 30) {
  if (!fc?.enough || !(fc.perDay > 0)) return null;
  const daysLeft = Math.max(0, (item.qty || 0) / fc.perDay);
  return { daysLeft: Math.round(daysLeft), date: dkey(addDays(today, Math.floor(daysLeft))), order: Math.max(0, Math.ceil(fc.perDay * cover - (item.qty || 0))) };
}

// ---------- Unusual activity ----------
// Things worth a look, each with the numbers behind it. Never a verdict about a person: a cashier
// with many returns may simply work the busy shift.
export function anomalies({ receipts = [], shifts = [], priceChanges = [], expenses = [], today = startOfDay(), days = 30 } = {}) {
  const from = addDays(today, -days);
  const recent = receipts.filter((x) => new Date(x.sold_at) >= from);
  const out = [];
  // Per cashier: share of money given as discount, and share returned.
  const by = new Map();
  for (const x of recent) {
    const k = x.employee_name || 'من غير اسم';
    const o = by.get(k) || { sales: 0, disc: 0, ret: 0, n: 0 };
    if (x.kind === 'return') o.ret += -(+x.total || 0); else { o.sales += +x.total || 0; o.disc += +x.discount || 0; o.n += 1; }
    by.set(k, o);
  }
  const all = [...by.values()].reduce((a, o) => ({ sales: a.sales + o.sales, disc: a.disc + o.disc, ret: a.ret + o.ret }), { sales: 0, disc: 0, ret: 0 });
  const avgDisc = all.sales + all.disc > 0 ? all.disc / (all.sales + all.disc) : 0;
  const avgRet = all.sales > 0 ? all.ret / all.sales : 0;
  if (by.size > 1) for (const [name, o] of by) {
    if (o.n < 10) continue;
    const d = o.disc / (o.sales + o.disc || 1), r = o.ret / (o.sales || 1);
    if (d >= Math.max(0.05, avgDisc * 2)) out.push({ kind: 'discount', level: 'warn', title: `خصومات «${name}» أعلى من المعتاد`, evidence: `${r2(d * 100)}% من مبيعاته خصم، والمتوسط ${r2(avgDisc * 100)}% (آخر ${days} يوم، ${o.n} فاتورة).` });
    if (r >= Math.max(0.05, avgRet * 2)) out.push({ kind: 'returns', level: 'warn', title: `مرتجعات «${name}» أعلى من المعتاد`, evidence: `${r2(r * 100)}% من مبيعاته اترجعت، والمتوسط ${r2(avgRet * 100)}% (آخر ${days} يوم).` });
  }
  // Single receipts with a big discount.
  for (const x of recent) if (x.kind !== 'return' && +x.discount > 0 && +x.discount >= 0.3 * ((+x.total || 0) + (+x.discount || 0)) && +x.discount >= 20) out.push({ kind: 'big-discount', level: 'info', title: `فاتورة ${x.number} بخصم كبير`, evidence: `خصم ${r2(+x.discount)} ج على ${r2((+x.total || 0) + (+x.discount || 0))} ج${x.employee_name ? ` (${x.employee_name})` : ''}.` });
  // Drawer counts that did not match.
  for (const s of shifts) {
    if (!s.closed_at || new Date(s.closed_at) < from || s.counted_cash == null || s.expected_cash == null) continue;
    const diff = r2(+s.counted_cash - +s.expected_cash);
    if (Math.abs(diff) >= 20) out.push({ kind: 'drawer', level: Math.abs(diff) >= 100 ? 'crit' : 'warn', title: `فرق في الدرج ${diff} ج`, evidence: `وردية ${s.employee_name || ''} اتقفلت ${String(s.closed_at).slice(0, 16).replace('T', ' ')}: المتوقع ${r2(+s.expected_cash)} والمعدود ${r2(+s.counted_cash)}.` });
  }
  // Big price moves between the last two uploads.
  for (const c of priceChanges) if (c.priceMoved && Math.abs(c.pct) >= 30) out.push({ kind: 'price', level: 'info', title: `سعر «${c.name}» اتغير ${r2(c.pct)}%`, evidence: `من ${r2(c.oldPrice)} لـ ${r2(c.newPrice)} ج.` });
  // A month of expenses well above the months before.
  const monthTotal = (k) => { const a = new Date(today.getFullYear(), today.getMonth() - k, 1), b = new Date(today.getFullYear(), today.getMonth() - k + 1, 1); return expenseTotals(expenses, a, b).operating; };
  const prev = [1, 2, 3].map(monthTotal).filter((x) => x > 0);
  const cur = monthTotal(0);
  if (prev.length >= 2 && cur > 1.5 * (prev.reduce((a, x) => a + x, 0) / prev.length)) out.push({ kind: 'expenses', level: 'warn', title: 'مصروفات الشهر ده أعلى من المعتاد', evidence: `${r2(cur)} ج، ومتوسط الشهور اللي فاتت ${r2(prev.reduce((a, x) => a + x, 0) / prev.length)} ج.` });
  const rank = { crit: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ---------- Alerts ----------
// Everything that needs the owner now, in one list, highest priority first. Each alert has a stable
// key so one that was read stays read until something new happens.
export function alerts({ A, overviewData, anomaliesList = [], pending = 0, stuck = 0, today = startOfDay() }) {
  const out = [];
  const add = (key, level, title, detail, tab) => out.push({ key, level, title, detail, tab });
  const expired = A.rows.filter((r) => r.expDays !== null && r.expDays <= 0 && r.qty > 0);
  if (expired.length) add(`expired:${expired.length}`, 'crit', `${expired.length} صنف في الرف منتهي الصلاحية`, expired.slice(0, 5).map((r) => r.name).join('، '), 'expiry');
  const soon = A.expiring.filter((r) => r.expDays > 0);
  if (soon.length) add(`expiring:${soon.length}:${dkey(today)}`, 'warn', `${soon.length} صنف ممكن ينتهي قبل ما يتباع`, `فلوس معرضة للخطر ${r2(soon.reduce((a, r) => a + r.riskValue, 0))} ج`, 'expiry');
  const out0 = A.rows.filter((r) => r.rate > 0 && r.qty <= 0);
  if (out0.length) add(`out:${out0.length}`, 'crit', `${out0.length} صنف بيتباع ورصيده خلص`, out0.slice(0, 5).map((r) => r.name).join('، '), 'reorder');
  const low = A.reorder.filter((r) => r.qty > 0);
  if (low.length) add(`low:${low.length}`, 'warn', `${low.length} صنف محتاج يتطلب`, low.slice(0, 5).map((r) => r.name).join('، '), 'reorder');
  if (A.deadStock.length) add(`dead:${A.deadStock.length}`, 'info', `${A.deadStock.length} صنف راكد`, `فلوس واقفة ${r2(A.deadStock.reduce((a, r) => a + r.value, 0))} ج`, 'dead');
  if (overviewData?.month?.growth !== null && overviewData?.month?.growth <= -15) add(`decline:${dkey(today).slice(0, 7)}`, 'warn', `المبيعات أقل من الشهر اللي فات بـ ${Math.abs(overviewData.month.growth)}%`, 'لنفس الأيام من الشهر.', 'overview');
  for (const a of anomaliesList) add(`anomaly:${a.kind}:${a.title}`, a.level, a.title, a.evidence, 'analysis');
  if (stuck) add(`stuck:${stuck}`, 'crit', `${stuck} عملية مارفعتش`, 'السيرفر رفضها: راجعها من «مستني».', null);
  else if (pending) add(`pending:${pending}`, 'info', `${pending} عملية مستنية النت`, 'هتترفع لوحدها لما النت يرجع.', null);
  const rank = { crit: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ---------- Recommendations ----------
// Concrete things to do, each with the data behind it, the expected benefit, how sure we are, and the
// risk. key is stable so an accepted or dismissed one does not come back for the same reason.
export function recommendations({ A, classes, trend, health }) {
  const out = [];
  const add = (r) => out.push(r);
  const offer = A.expiring.filter((r) => r.atRisk > 0).sort((a, b) => b.riskValue - a.riskValue).slice(0, 5);
  if (offer.length) add({ key: `offer:${offer.map((r) => r.code).join(',')}`, priority: 'high', title: 'اعمل عرض على أصناف قربت تنتهي', data: offer.map((r) => `${r.name}: ${r.atRisk} علبة (${r2(r.riskValue)} ج)`).join('، '), benefit: `تنقذ لحد ${r2(offer.reduce((a, r) => a + r.riskValue, 0))} ج بدل ما تبقى تالف`, confidence: 'عالية: الكمية محسوبة من معدل البيع الفعلي', action: 'افتح «قرب ينتهي» واحسب عرض لكل صنف', risk: 'العرض بيقلل المكسب في الصنف ده', tab: 'expiry' });
  if (A.deadStock.length) { const top = [...A.deadStock].sort((a, b) => b.value - a.value).slice(0, 5); add({ key: `dead:${top.map((r) => r.code).join(',')}`, priority: 'medium', title: 'رجّع أو صفّي الراكد', data: top.map((r) => `${r.name}: ${r2(r.value)} ج`).join('، '), benefit: `فلوس ترجع للدورة: ${r2(top.reduce((a, r) => a + r.value, 0))} ج`, confidence: 'عالية: مفيش بيع منهم من 45 يوم أو أكتر', action: 'رجّعهم للمورد («مرتجع للمورد») أو اعمل عليهم عرض', risk: 'بعض الأصناف موسمية وممكن تتطلب تاني', tab: 'dead' }); }
  if (classes?.losing?.length) add({ key: `losing:${classes.losing.map((r) => r.code).join(',')}`, priority: 'high', title: 'أصناف بتتباع بخسارة', data: classes.losing.slice(0, 5).map((r) => `${r.name}: ${r2(r.gross)} ج`).join('، '), benefit: 'وقف الخسارة في كل علبة', confidence: 'متوسطة: لو سعر الشراء المتسجل قديم، الخسارة ممكن تكون مش حقيقية', action: 'راجع سعر البيع وسعر الشراء للأصناف دي', risk: 'لو السعر رسمي مش هتقدر تغيّره، اتفاوض مع المورد', tab: 'analysis' });
  if (classes?.volume?.length) add({ key: `volume:${classes.volume.slice(0, 5).map((r) => r.code).join(',')}`, priority: 'medium', title: 'أصناف بتتباع كتير بهامش ضعيف', data: classes.volume.slice(0, 5).map((r) => `${r.name}: هامش ${r.margin}%`).join('، '), benefit: 'أي خصم من المورد عليهم بيفرق في المكسب كله', confidence: 'عالية', action: 'قارن أسعار الموردين عليهم واطلب خصم أكبر', risk: 'قليل', tab: 'analysis' });
  if (trend?.up?.length) add({ key: `up:${trend.up.slice(0, 5).map((r) => r.code).join(',')}`, priority: 'medium', title: 'أصناف الطلب عليها زاد', data: trend.up.slice(0, 5).map((r) => `${r.name}: ${r.before} ← ${r.now}`).join('، '), benefit: 'متخلصش منك وقت الطلب', confidence: 'متوسطة: ممكن تكون زيادة مؤقتة', action: 'زوّد الكمية في الطلبية الجاية', risk: 'لو الزيادة مؤقتة ممكن يركد', tab: 'reorder' });
  const weak = health?.parts?.filter((p) => p.value !== null && p.value < 50) || [];
  for (const p of weak) add({ key: `health:${p.key}`, priority: 'low', title: `حسّن «${p.label}» في مؤشر الصحة`, data: `${p.label}: ${p.value}/100. ${p.rule}`, benefit: 'المؤشر كله يعلى', confidence: 'المؤشر استرشادي', action: 'شوف التفاصيل في «صحة الصيدلية»', risk: '—', tab: 'health' });
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
}
