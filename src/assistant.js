// «اسأل صيدليتي»: answers questions about the pharmacy from its own records.
// The answers come only from the tools below — fixed, tested calculations over the data the user is
// already allowed to see on this screen. There is no free SQL and nothing is made up: a tool returns
// the numbers, the period they cover and where they came from, and the text is built from them.
// With an AI model configured on the server, the model only picks which tool to call and words the
// answer; the tools still run here, on this device, with this user's data.
import { normalize } from './pos.js';
import { addDays, startOfDay } from './core.js';
import { periodTotals, overview, trending, profitClasses, supplierPerformance, healthScore, forecast, stockoutPlan, anomalies } from './insights.js';
import { expenseTotals } from './branches-expenses.js';
import { ordersBySupplier } from './ordering.js';

const r2 = (n) => Math.round(n * 100) / 100;
const f = (n, d = 0) => Number(n || 0).toLocaleString('ar-EG', { maximumFractionDigits: d, minimumFractionDigits: d });
const dk = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- Periods ----------
export const PERIODS = { today: 'النهارده', yesterday: 'امبارح', week: 'الأسبوع ده', month: 'الشهر ده', last_month: 'الشهر اللي فات', last_7: 'آخر 7 أيام', last_30: 'آخر 30 يوم', last_90: 'آخر 90 يوم', year: 'السنة دي' };
export function periodRange(p, today = startOfDay()) {
  const t1 = addDays(today, 1);
  switch (p) {
    case 'today': return [today, t1];
    case 'yesterday': return [addDays(today, -1), today];
    case 'week': return [addDays(today, -((today.getDay() + 1) % 7)), t1];
    case 'last_month': return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 1)];
    case 'last_7': return [addDays(today, -6), t1];
    case 'last_90': return [addDays(today, -89), t1];
    case 'year': return [new Date(today.getFullYear(), 0, 1), t1];
    case 'last_30': return [addDays(today, -29), t1];
    default: return [new Date(today.getFullYear(), today.getMonth(), 1), t1];
  }
}
const rangeText = ([a, b]) => `${dk(a)} ← ${dk(addDays(b, -1))}`;

// ---------- Tools ----------
// Each: name, what it does (for the AI model), the input it takes (JSON schema), who may use it,
// and run(ctx, input) → { title, text, table?: { head, rows }, range?, source, tab? }.
// ctx: { data, A, receipts, expenses, purchases, suppliers, chosen, today, role, branchId }.
const period = { type: 'string', enum: Object.keys(PERIODS), description: 'الفترة' };
const findItems = (ctx, q) => {
  const n = normalize(q);
  if (!n) return [];
  const words = n.split(' ');
  return ctx.data.items.filter((i) => words.every((w) => normalize([i.name, i.en, i.generic].filter(Boolean).join(' ')).includes(w) || String(i.code) === q)).slice(0, 10);
};
const soldBy = (ctx, from, to) => {
  const m = new Map();
  const list = new Map(ctx.data.items.map((i) => [i.code, i]));
  for (const s of ctx.data.sales) {
    if (s.date < from || s.date >= to || !list.has(s.code)) continue;
    const it = list.get(s.code);
    const o = m.get(s.code) || { code: s.code, name: it.name, qty: 0, sales: 0, gross: 0 };
    const v = s.qty * (s.price ?? it.price ?? 0) - (s.discount || 0);
    o.qty += s.qty; o.sales += v; o.gross += v - s.qty * (s.cost ?? it.cost ?? 0);
    m.set(s.code, o);
  }
  return [...m.values()];
};

export const TOOLS = [
  { name: 'get_sales_summary', description: 'إجمالي المبيعات وتكلفتها ومجمل الربح لفترة، مقارنة بالفترة اللي قبلها بنفس الطول.', input: { type: 'object', properties: { period } }, roles: ['owner', 'partner', 'accountant'],
    run(ctx, { period: p = 'today' }) {
      const [a, b] = periodRange(p, ctx.today);
      const now = periodTotals(ctx.data, a, b);
      const days = Math.round((b - a) / 86400000);
      const before = periodTotals(ctx.data, addDays(a, -days), a);
      const g = before.sales > 0 ? r2(((now.sales - before.sales) / before.sales) * 100) : null;
      const rc = (ctx.receipts || []).filter((x) => x.kind !== 'return' && new Date(x.sold_at) >= a && new Date(x.sold_at) < b);
      return { title: `مبيعات ${PERIODS[p]}`, range: rangeText([a, b]), source: 'مبيعات برنامج الصيدلية + الكاشير',
        text: `المبيعات ${f(now.sales, 2)} ج (${f(now.qty)} علبة)، مجمل الربح ${f(now.gross, 2)} ج.${g === null ? '' : ` ${g >= 0 ? 'أعلى' : 'أقل'} من المدة اللي قبلها بـ ${f(Math.abs(g), 1)}%.`}${rc.length ? ` فواتير الكاشير ${f(rc.length)} بمتوسط ${f(rc.reduce((x, r) => x + (+r.total || 0), 0) / rc.length, 2)} ج.` : ''}`,
        table: { head: ['', 'المبيعات', 'التكلفة', 'مجمل الربح'], rows: [[PERIODS[p], now.sales, now.cogs, now.gross], ['المدة اللي قبلها', before.sales, before.cogs, before.gross]] }, tab: 'pos' };
    } },
  { name: 'get_profit_summary', description: 'صافي الربح لفترة: مجمل الربح ناقص المصروفات المتسجلة.', input: { type: 'object', properties: { period } }, roles: ['owner', 'partner', 'accountant'],
    run(ctx, { period: p = 'month' }) {
      const [a, b] = periodRange(p, ctx.today);
      const t = periodTotals(ctx.data, a, b);
      const e = expenseTotals(ctx.expenses || [], a, b, ctx.branchId || 'all');
      return { title: `صافي الربح ${PERIODS[p]}`, range: rangeText([a, b]), source: 'المبيعات + المصروفات المتسجلة',
        text: `المبيعات ${f(t.sales, 2)} − تكلفتها ${f(t.cogs, 2)} = مجمل ربح ${f(t.gross, 2)} ج. المصروفات ${f(e.operating, 2)} ج. صافي الربح ${f(t.gross - e.operating, 2)} ج.${e.count ? '' : ' (مفيش مصروفات متسجلة في الفترة دي)'}`,
        table: { head: ['البند', 'جنيه'], rows: [['المبيعات', t.sales], ['تكلفة اللي اتباع', t.cogs], ['مجمل الربح', t.gross], ['المصروفات', r2(e.operating)], ['صافي الربح', r2(t.gross - e.operating)]] }, tab: 'profit' };
    } },
  { name: 'get_top_products', description: 'أكتر الأصناف مبيعاً في فترة: بالكمية أو بالمبيعات أو بالمكسب.', input: { type: 'object', properties: { period, n: { type: 'integer', minimum: 1, maximum: 50 }, by: { type: 'string', enum: ['qty', 'sales', 'profit'] } } }, roles: ['owner', 'partner', 'accountant'],
    run(ctx, { period: p = 'last_30', n = 20, by = 'sales' }) {
      const [a, b] = periodRange(p, ctx.today);
      const key = by === 'qty' ? 'qty' : by === 'profit' ? 'gross' : 'sales';
      const rows = soldBy(ctx, a, b).sort((x, y) => y[key] - x[key]).slice(0, Math.min(50, n));
      const lbl = { qty: 'بالكمية', sales: 'بالمبيعات', profit: 'بالمكسب' }[by];
      return { title: `أكتر ${rows.length} صنف ${lbl} — ${PERIODS[p]}`, range: rangeText([a, b]), source: 'المبيعات',
        text: rows.length ? `الأول «${rows[0].name}» (${f(rows[0].qty)} علبة، ${f(rows[0].sales, 2)} ج).` : 'مفيش مبيعات في الفترة دي.',
        table: { head: ['الصنف', 'علب', 'المبيعات', 'المكسب'], rows: rows.map((r) => [r.name, r2(r.qty), r2(r.sales), r2(r.gross)]) }, tab: 'movers' };
    } },
  { name: 'get_inventory_status', description: 'الأصناف اللي قربت تخلص أو خلصت وبتتباع، ومحتاجة تتطلب.', input: { type: 'object', properties: {} }, roles: ['owner', 'partner', 'device', 'pharmacist', 'accountant', 'stock'],
    run(ctx) {
      const out = ctx.A.rows.filter((r) => r.rate > 0 && r.qty <= 0);
      const rows = ctx.A.reorder.slice(0, 50);
      return { title: 'المخزون اللي محتاج يتطلب', source: 'الرصيد ومعدل البيع',
        text: `${f(ctx.A.reorder.length)} صنف محتاج يتطلب، منهم ${f(out.length)} خلص خالص وهو بيتباع.`,
        table: { head: ['الصنف', 'الرصيد', 'بيتباع في الشهر', 'يكفي (يوم)', 'اطلب'], rows: rows.map((r) => [r.name, r.qty, r2(r.monthly), Number.isFinite(r.daysCover) ? Math.round(r.daysCover) : '—', r.order]) }, tab: 'reorder' };
    } },
  { name: 'get_expiry_report', description: 'الأصناف القريبة من انتهاء الصلاحية والكمية اللي مش هتلحق تتباع وقيمتها.', input: { type: 'object', properties: {} }, roles: ['owner', 'partner', 'device', 'pharmacist', 'accountant', 'stock'],
    run(ctx) {
      const rows = [...ctx.A.expiring].sort((a, b) => b.riskValue - a.riskValue).slice(0, 50);
      return { title: 'قرب ينتهي', source: 'الصلاحية في التشغيلات + معدل البيع',
        text: `${f(ctx.A.expiring.length)} صنف، والفلوس المعرضة للخطر ${f(ctx.A.expiring.reduce((a, r) => a + r.riskValue, 0), 2)} ج (الكمية اللي مش هتلحق تتباع قبل الصلاحية بمعدل البيع الحالي).`,
        table: { head: ['الصنف', 'ينتهي بعد (يوم)', 'الرصيد', 'مش هيلحق', 'القيمة'], rows: rows.map((r) => [r.name, r.expDays, r.qty, r.atRisk, r2(r.riskValue)]) }, tab: 'expiry' };
    } },
  { name: 'get_slow_moving_products', description: 'الأصناف الراكدة (مفيش بيع من 45 يوم أو أكتر) والفلوس الواقفة فيها.', input: { type: 'object', properties: {} }, roles: ['owner', 'partner', 'accountant'],
    run(ctx) {
      const rows = [...ctx.A.deadStock].sort((a, b) => b.value - a.value).slice(0, 50);
      return { title: 'الراكد', source: 'الرصيد وآخر بيع', text: `${f(ctx.A.deadStock.length)} صنف راكد بقيمة ${f(ctx.A.deadStock.reduce((a, r) => a + r.value, 0), 2)} ج بسعر الشراء.`,
        table: { head: ['الصنف', 'الرصيد', 'القيمة', 'آخر بيع'], rows: rows.map((r) => [r.name, r.qty, r2(r.value), r.lastSale ? dk(r.lastSale) : '—']) }, tab: 'dead' };
    } },
  { name: 'compare_periods', description: 'يقارن الشهر ده بالشهر اللي فات (لنفس الأيام) ويشرح الفرق: المبيعات، الهامش، المصروفات، والأصناف اللي فرقت.', input: { type: 'object', properties: {} }, roles: ['owner', 'partner', 'accountant'],
    run(ctx) {
      const today = ctx.today;
      const a1 = new Date(today.getFullYear(), today.getMonth(), 1), b1 = addDays(today, 1);
      const a0 = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const b0 = new Date(today.getFullYear(), today.getMonth() - 1, Math.min(today.getDate(), new Date(today.getFullYear(), today.getMonth(), 0).getDate()) + 1);
      const now = periodTotals(ctx.data, a1, b1), before = periodTotals(ctx.data, a0, b0);
      const e1 = expenseTotals(ctx.expenses || [], a1, b1, ctx.branchId || 'all').operating, e0 = expenseTotals(ctx.expenses || [], a0, b0, ctx.branchId || 'all').operating;
      const m = (t) => (t.sales ? (t.gross / t.sales) * 100 : 0);
      const n1 = new Map(soldBy(ctx, a1, b1).map((r) => [r.code, r])), n0 = soldBy(ctx, a0, b0);
      const drops = n0.map((r) => ({ name: r.name, before: r.gross, now: n1.get(r.code)?.gross || 0 })).map((r) => ({ ...r, diff: r.now - r.before })).filter((r) => r.diff < 0).sort((x, y) => x.diff - y.diff).slice(0, 10);
      const why = [];
      if (!(before.sales > 0)) why.push(`مفيش مبيعات متسجلة في الشهر اللي فات لنفس الأيام، فالمقارنة مش ممكنة. المبيعات الشهر ده ${f(now.sales, 2)} ج.`);
      if (before.sales > 0) why.push(`المبيعات ${now.sales >= before.sales ? 'زادت' : 'قلّت'} ${f(Math.abs(((now.sales - before.sales) / before.sales) * 100), 1)}% (${f(before.sales, 2)} ← ${f(now.sales, 2)} ج).`);
      if (now.sales && before.sales) why.push(`هامش الربح ${f(m(before), 1)}% ← ${f(m(now), 1)}%${Math.abs(m(now) - m(before)) >= 1 ? (m(now) < m(before) ? ': بتبيع بهامش أقل (خصومات أكتر، أو أصناف هامشها ضعيف، أو أسعار شراء زادت).' : '.') : ' (تقريباً زي ما هو).'}`);
      if (e0 || e1) why.push(`المصروفات ${f(e0, 2)} ← ${f(e1, 2)} ج.`);
      if (drops.length) why.push(`أكتر الأصناف اللي مكسبها قلّ: ${drops.slice(0, 5).map((r) => `«${r.name}»`).join('، ')}.`);
      return { title: 'الشهر ده مقابل الشهر اللي فات (نفس الأيام)', range: `${rangeText([a1, b1])} مقابل ${rangeText([a0, b0])}`, source: 'المبيعات + المصروفات',
        text: why.join(' ') || 'مفيش بيانات كفاية للمقارنة.',
        table: { head: ['', 'الشهر اللي فات', 'الشهر ده'], rows: [['المبيعات', before.sales, now.sales], ['مجمل الربح', before.gross, now.gross], ['الهامش %', r2(m(before)), r2(m(now))], ['المصروفات', r2(e0), r2(e1)], ['الصافي', r2(before.gross - e0), r2(now.gross - e1)]] }, tab: 'overview' };
    } },
  { name: 'get_trending_products', description: 'الأصناف اللي الطلب عليها زاد أو قلّ (آخر 30 يوم مقابل الـ 30 اللي قبلهم).', input: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } } }, roles: ['owner', 'partner', 'accountant'],
    run(ctx, { direction = 'down' }) {
      const t = trending(ctx.data, ctx.today)[direction === 'up' ? 'up' : 'down'];
      return { title: direction === 'up' ? 'الطلب زاد' : 'الطلب قلّ', source: 'المبيعات', range: rangeText([addDays(ctx.today, -59), addDays(ctx.today, 1)]),
        text: t.length ? `${f(t.length)} صنف.` : 'مفيش أصناف اتغير الطلب عليها بشكل واضح.',
        table: { head: ['الصنف', 'الـ 30 يوم اللي قبل', 'آخر 30 يوم'], rows: t.map((r) => [r.name, r.before, r.now]) }, tab: 'analysis' };
    } },
  { name: 'get_supplier_comparison', description: 'الموردين: قيمة الطلبيات، المرتجع، وتغيّر أسعارهم.', input: { type: 'object', properties: {} }, roles: ['owner', 'partner', 'accountant'],
    run(ctx) {
      const s = supplierPerformance(ctx.purchases || []);
      return { title: 'الموردين', source: 'فواتير الشراء المتسجلة', text: s.length ? `${f(s.length)} مورد. الأكبر «${s[0].name}» بـ ${f(s[0].value, 2)} ج.` : 'لسه مفيش فواتير شراء متسجلة.',
        table: { head: ['المورد', 'فواتير', 'القيمة', 'مرتجع %', 'تغيّر الأسعار %'], rows: s.map((x) => [x.name, x.invoices, x.value, x.returnedPct, x.priceChangePct ?? '—']) }, tab: 'analysis' };
    } },
  { name: 'get_product_details', description: 'تفاصيل صنف: الرصيد، الأسعار، الصلاحية، معدل البيع، والتوقع.', input: { type: 'object', properties: { query: { type: 'string', description: 'اسم الصنف أو الباركود' } }, required: ['query'] }, roles: ['owner', 'partner', 'device', 'pharmacist', 'accountant', 'stock'],
    run(ctx, { query = '' }) {
      const found = findItems(ctx, query);
      if (!found.length) return { title: 'صنف', text: `مفيش صنف اسمه «${query}».`, source: 'الأصناف' };
      const it = found[0];
      const row = ctx.A.rows.find((r) => r.code === it.code) || it;
      const fc = forecast(ctx.data, it.code, ctx.today, 14);
      const plan = stockoutPlan(it, fc, ctx.today);
      return { title: it.name, source: 'الأصناف والمبيعات',
        text: `الرصيد ${f(it.qty)} علبة، سعر البيع ${f(it.price, 2)} ج، الشراء ${f(it.cost, 2)} ج${it.generic ? `، المادة الفعالة ${it.generic}` : ''}. ${row.rate > 0 ? `بيتباع حوالي ${f(row.monthly, 1)} علبة في الشهر.` : 'مبيتباعش اليومين دول.'} ${fc.enough ? `التوقع: ${f(fc.total, 1)} علبة في الأسبوعين الجايين (خطأ الطريقة دي على آخر 4 أسابيع ${fc.error === null ? '—' : `${f(fc.error)}%`}).${plan ? ` الرصيد يخلص بعد حوالي ${f(plan.daysLeft)} يوم.` : ''}` : `مفيش تاريخ بيع كفاية للتوقع (${f(fc.history)} يوم، محتاج 28).`}`,
        table: found.length > 1 ? { head: ['أصناف تانية بنفس الاسم', 'الرصيد', 'السعر'], rows: found.slice(1).map((x) => [x.name, x.qty, x.price]) } : null, tab: 'items' };
    } },
  { name: 'get_health_score', description: 'مؤشر صحة الصيدلية (استرشادي) وأجزاؤه.', input: { type: 'object', properties: {} }, roles: ['owner', 'partner', 'accountant'],
    run(ctx) {
      const h = healthScore({ rows: ctx.A.rows, data: ctx.data, today: ctx.today, expenses: ctx.expenses || [], branchId: ctx.branchId || 'all' });
      return { title: 'صحة الصيدلية', source: 'طريقة حساب ثابتة ومكتوبة', text: h.score === null ? 'مفيش بيانات كفاية.' : `${h.score}/100 (مؤشر استرشادي مش تقييم رسمي). أضعف جزء: ${h.parts.filter((p) => p.value !== null).sort((a, b) => a.value - b.value)[0]?.label || '—'}.`,
        table: { head: ['الجزء', 'الدرجة', 'بيتحسب إزاي'], rows: h.parts.map((p) => [p.label, p.value ?? '—', p.rule]) }, tab: 'health' };
    } },
  { name: 'get_unusual_activity', description: 'حاجات غريبة تستاهل نظرة (خصومات أو مرتجعات أعلى من المعتاد، فرق الدرج، تغيّر أسعار كبير) بالأرقام، من غير اتهام.', input: { type: 'object', properties: {} }, roles: ['owner'],
    run(ctx) {
      const a = anomalies({ receipts: ctx.receipts || [], shifts: ctx.shifts || [], expenses: ctx.expenses || [], today: ctx.today });
      return { title: 'حاجات تستاهل نظرة', source: 'فواتير الكاشير والورديات والمصروفات (آخر 30 يوم)', text: a.length ? `${f(a.length)} حاجة. دي أرقام بس، مش اتهام لحد.` : 'مفيش حاجة غريبة في آخر 30 يوم.',
        table: { head: ['إيه', 'الأرقام'], rows: a.map((x) => [x.title, x.evidence]) }, tab: 'analysis' };
    } },
  { name: 'create_purchase_draft', description: 'مسودة طلبية لكل مورد من الأصناف اللي محتاجة تتطلب (مش بتتبعت ولا بتتسجل غير لما صاحب الصيدلية يوافق).', input: { type: 'object', properties: {} }, roles: ['owner', 'stock'],
    run(ctx) {
      const groups = ordersBySupplier(ctx.A.reorder, ctx.suppliers || [], ctx.chosen || {});
      const rows = groups.flatMap((g) => g.lines.map((l) => [g.supplier?.name || 'من غير مورد', l.name, l.qty]));
      const total = groups.reduce((a, g) => a + (g.cost || 0), 0);
      return { title: 'مسودة طلبية', source: 'اطلب إيه (الرصيد ومعدل البيع)', text: rows.length ? `${f(rows.length)} صنف على ${f(groups.length)} مورد${total ? `، حوالي ${f(total, 2)} ج` : ''}. دي مسودة بس: راجعها وابعتها من «اطلب إيه».` : 'مفيش أصناف محتاجة تتطلب دلوقتي.',
        table: { head: ['المورد', 'الصنف', 'الكمية'], rows }, tab: 'reorder', draft: true };
    } },
];

// ---------- Understanding a question (without an AI model) ----------
// Egyptian Arabic and English keywords → a tool and its input. Unknown → the list of what it can do.
const has = (q, ...words) => words.some((w) => q.includes(w));
export function detectPeriod(q) {
  if (has(q, 'امبارح', 'yesterday')) return 'yesterday';
  if (has(q, 'النهارده', 'انهارده', 'today', 'اليوم')) return 'today';
  if (has(q, 'الشهر اللي فات', 'الشهر الي فات', 'الشهر الماضي', 'last month')) return 'last_month';
  if (has(q, '30 يوم', '٣٠ يوم', 'شهر', 'month') && has(q, 'اخر', 'last')) return 'last_30';
  if (has(q, 'الشهر ده', 'الشهر دا', 'الشهر', 'month')) return 'month';
  if (has(q, '90 يوم', '٩٠ يوم', '3 شهور', 'تلات شهور')) return 'last_90';
  if (has(q, 'الاسبوع', 'الأسبوع', 'week')) return has(q, 'اخر', 'last') ? 'last_7' : 'week';
  if (has(q, 'السنه', 'السنة', 'year')) return 'year';
  return null;
}
export function route(question) {
  const q = normalize(String(question || '').replace(/[؟?!.,،]/g, ' '));
  const p = detectPeriod(q);
  const num = (q.match(/\d+/) || [])[0];
  if (has(q, 'ليه', 'why') && has(q, 'ربح', 'ارباح', 'مكسب', 'مبيعات', 'قلت', 'قل', 'نزل')) return { tool: 'compare_periods', input: {} };
  if (has(q, 'قارن', 'مقارن', 'compare')) return has(q, 'مورد', 'supplier') ? { tool: 'get_supplier_comparison', input: {} } : { tool: 'compare_periods', input: {} };
  if (has(q, 'مسوده', 'طلب شراء', 'طلبيه', 'draft', 'purchase order')) return { tool: 'create_purchase_draft', input: {} };
  if (has(q, 'صلاحي', 'ينتهي', 'تنتهي', 'منتهي', 'expir')) return { tool: 'get_expiry_report', input: {} };
  if (has(q, 'راكد', 'رواكد', 'مبتتباعش', 'slow', 'dead')) return { tool: 'get_slow_moving_products', input: {} };
  if (has(q, 'قلت مبيعات', 'مبيعاتها قلت', 'انخفض', 'زادت', 'الطلب', 'trend')) return { tool: 'get_trending_products', input: { direction: has(q, 'زاد', 'زادت', 'up') ? 'up' : 'down' } };
  if (has(q, 'قربت تخلص', 'خلصت', 'ناقص', 'الحد الادني', 'اطلب', 'low stock', 'out of stock', 'مخزون')) return { tool: 'get_inventory_status', input: {} };
  if (has(q, 'مورد', 'supplier')) return { tool: 'get_supplier_comparison', input: {} };
  if (has(q, 'صحه', 'صحة', 'health', 'مؤشر')) return { tool: 'get_health_score', input: {} };
  if (has(q, 'غريب', 'غلط', 'سرق', 'فرق الدرج', 'unusual', 'anomal')) return { tool: 'get_unusual_activity', input: {} };
  if (has(q, 'اكتر', 'أكثر', 'افضل', 'top', 'best')) return { tool: 'get_top_products', input: { period: p || 'last_30', n: num ? Math.min(50, +num) : 20, by: has(q, 'مكسب', 'ربح', 'profit') ? 'profit' : has(q, 'كميه', 'علب', 'qty') ? 'qty' : 'sales' } };
  if (has(q, 'صافي', 'ربح', 'ارباح', 'مكسب', 'profit')) return { tool: 'get_profit_summary', input: { period: p || 'month' } };
  if (has(q, 'مبيعات', 'بعنا', 'بيع', 'دخل', 'sales', 'تقرير')) return { tool: 'get_sales_summary', input: { period: p || (has(q, 'تقرير') ? 'last_30' : 'today') } };
  const m = q.match(/(?:صنف|رصيد|سعر|كام علبه|عندنا|about|stock of)\s+(.+)/);
  if (m) return { tool: 'get_product_details', input: { query: m[1].trim() } };
  return null;
}

export const EXAMPLES = ['كام مبيعات النهارده؟', 'إيه صافي الربح الشهر ده؟', 'إيه أكتر 20 صنف مبيعاً؟', 'إيه الأصناف اللي قربت تخلص؟', 'إيه المنتجات القريبة من انتهاء الصلاحية؟', 'قارن الشهر ده بالشهر اللي فات', 'إيه الأصناف الراكدة؟', 'ليه الأرباح قلت؟', 'جهز مسودة طلب شراء', 'رصيد بانادول'];

// Runs a tool for this user: unknown tools and tools above the user's role are refused.
export function runTool(name, input, ctx) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { title: 'خطأ', text: `مفيش أداة اسمها ${name}.`, error: true };
  if (!t.roles.includes(ctx.role)) return { title: 'مش مسموح', text: 'الحساب ده مالوش صلاحية على المعلومة دي.', error: true };
  try { return t.run(ctx, input || {}); } catch (e) { return { title: 'خطأ', text: `حصلت مشكلة وهو بيحسب: ${e.message}`, error: true }; }
}
// The tools as the AI model sees them (names, descriptions, inputs), only those this role may use.
export const toolSpecs = (role) => TOOLS.filter((t) => t.roles.includes(role)).map((t) => ({ name: t.name, description: t.description, input_schema: t.input }));

// One question without a model: route it and run the tool.
export function answerLocally(question, ctx) {
  const r = route(question);
  if (!r) return { title: 'مش فاهم السؤال', text: `جرّب سؤال زي: ${EXAMPLES.slice(0, 5).join(' / ')}`, unknown: true };
  return { ...runTool(r.tool, r.input, ctx), tool: r.tool, input: r.input };
}
