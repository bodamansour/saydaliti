import { analyze, profitAt, targetFloor, suggestOffer, parseSheet, startOfDay, addDays, partnerSummary, ownersOf, ledger, fromExport, toExport, settingsFromSaved } from './core.js';
import { mergeBranches, expenseTotals, monthlyFromRecorded, EXPENSE_KINDS, kindLabel } from './branches-expenses.js';
import { pickSupplier, ordersBySupplier, orderMessage, priceChanges, recurringSuggestions, itemKind } from './ordering.js';
import { getSession, signOut, renderSignIn, renderPharmacyChoice, ROLE_LABEL, rememberSettings } from './session.js';
import { arabicError } from './supabase-store.js';
import { morningReport } from './report.js';
import { suggestMapping } from './mapping.js';
import { shortagePlan, cheapestSeen, priceCompare, parseTimes } from './features.js';
import { normalizeEgPhone } from './report.js';
import { kvGet, kvSet, enqueue, flush, pending, stuck, onOutboxChange, isOnline, registerServiceWorker } from './offline.js';
import { daySummary, PAYMENTS } from './pos.js';

const $ = (id) => document.getElementById(id);
const TODAY = startOfDay();
const fmt = (n, d = 0) => (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const egp = (n) => `<span class="n">${fmt(n)}</span> ج`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const EMPTY = () => ({ items: [], sales: [], purchases: [], losses: [], real: true });

async function readFiles(files) {
  const json = files.find((f) => f.name.toLowerCase().endsWith('.json'));
  if (json) {
    const data = fromExport(JSON.parse((await json.text()).replace(/^﻿/, '')));
    if (!data.items.length) throw new Error('الملف ده مفيهوش أصناف. اتأكد إنه data.json اللي طلع من الوصلة.');
    return data;
  }
  if (typeof XLSX === 'undefined') throw new Error('مكتبة قراية Excel مش محمّلة. افتح البرنامج مرة وإنت على النت، وبعدها هتشتغل من غيره.');
  const items = [], sales = [], purchases = [], losses = [];
  for (const f of files) {
    const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
    for (const name of wb.SheetNames) {
      const parsed = parseSheet(XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' }));
      items.push(...parsed.items); sales.push(...parsed.sales); purchases.push(...parsed.purchases); losses.push(...parsed.losses);
    }
  }
  if (!items.length) throw new Error('ملقتش أصناف في الملف. اتأكد إن فيه أعمدة زي «الصنف» و«سعر الشراء» و«الكمية».');
  return { items, sales, purchases, losses, real: true };
}

// ---------- Settings & saved prices ----------
const SKEY = 'saydaliti-settings-v1';
const MKEY = 'saydaliti-market-v1';
const fields = ['phName', 'waNumbers', 'taxMode', 'customTax', 'exRent', 'exUtil', 'exSal', 'exOther', 'target', 'expWin', 'lead', 'cover'];
const store = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
// Cheapest price seen outside, per item: shared through the database (migration 008), else kept on this device.
let MARKET = store.get(MKEY, {});
function refreshMarket() {
  if (!FEATURES_READY || SESS.mode !== 'member') { MARKET = store.get(MKEY, {}); return; }
  MARKET = Object.fromEntries([...cheapestSeen(PRICES, TODAY)].map(([code, p]) => [code, +p.price]));
}
const setMarket = (code, v) => {
  if (FEATURES_READY && SESS.mode === 'member') { if (v > 0) addPrice({ code, price: v, source: 'سعر شفته برا', seen_on: isoDay(TODAY) }); return; }
  if (v > 0) MARKET[code] = v; else delete MARKET[code]; store.set(MKEY, MARKET);
};

// ---------- State ----------
let SESS = { mode: 'local' };
let BRANCHES = [];               // [{ id, name }]; id null = the single branch before migration 007
let BRANCH = 'all';              // 'all' or a branch key
const SNAP = new Map();          // branch key -> { at, data }
let DATA = EMPTY();              // what the dashboard shows (one branch, or all merged)
let EXPENSES = [];               // recorded expenses (server + not yet uploaded)
let EXP_READY = true;            // false until the expenses table exists in the database
let CALC_CODE = null;
let TAB = store.get('saydaliti-tab-v1', 'reorder');
let OWNER = 'all';
let PERIOD = 'thisMonth';
let EXP_PERIOD = 'thisMonth';
const OFFERS = new Map();

const key = (id) => id ?? 'main';
const branchName = (k) => BRANCHES.find((b) => key(b.id) === k)?.name ?? 'الفرع الرئيسي';
const isOwner = () => SESS.role === 'owner';
const multi = () => BRANCHES.length > 1;

function settings() {
  const s = settingsFromSaved(Object.fromEntries(fields.map((f) => [f, $(f).value])));
  const recorded = EXP_READY ? monthlyFromRecorded(EXPENSES, TODAY, 90, BRANCH === 'all' ? 'all' : BRANCH_ID()) : null;
  return recorded ? { ...s, expenses: recorded, expensesRecorded: true } : s;
}
const BRANCH_ID = () => (BRANCH === 'all' ? null : BRANCHES.find((b) => key(b.id) === BRANCH)?.id ?? null);

// Four sections, each with its own tabs (13 tabs in one row was too much on a phone).
const SECTIONS = [
  ['stock', 'المخزون', [['reorder', 'اطلب إيه'], ['expiry', 'قرب ينتهي'], ['dead', 'راكد'], ['shortages', 'نواقص السوق'], ['movers', 'الأكتر سحباً'], ['morning', 'تقرير الصبح']]],
  ['money', 'الفلوس', [['pos', 'مبيعات الكاشير'], ['expenses', 'المصروفات'], ['books', 'الحسابات'], ['partners', 'الشركاء'], ['calc', 'حاسبة المكسب']]],
  ['sell', 'البيع', [['offers', 'العروض'], ['prices', 'أسعار السوق'], ['changes', 'أسعار اتغيرت']]],
  ['patients', 'المرضى', [['patients', 'تذكير المرضى']]],
];
const TABS = SECTIONS.flatMap(([, , tabs]) => tabs);
const sectionOf = (tab) => SECTIONS.find(([, , tabs]) => tabs.some(([id]) => id === tab)) ?? SECTIONS[0];
const visibleSections = () => SECTIONS.filter(([id]) => id !== 'patients' || isOwner());
const LAST_TAB = {}; // last tab opened in each section
const NEEDS_DATA = new Set(['reorder', 'expiry', 'dead', 'offers', 'books', 'morning', 'movers', 'partners', 'calc', 'changes']);

function taxNote(A, s) {
  if (s.taxMode === 'simplified') {
    if (A.aboveSimplifiedCeiling) return 'مبيعاتك السنوية المتوقعة فوق 20 مليون، يعني غالباً مش داخل النظام المبسط. اختار «نسبة أكتبها بنفسي».';
    return `مبيعاتك السنوية المتوقعة حوالي ${fmt(A.monthlySales * 12)} ج، فالضريبة ${fmt(A.taxRate * 100, 2)}% من المبيعات (قانون 6 لسنة 2025). اتأكد من المحاسب إنك مسجّل على النظام ده.`;
  }
  if (s.taxMode === 'custom') return `بنحسب ${fmt(A.taxRate * 100, 2)}% من المبيعات ضرايب.`;
  return 'الضرايب مش داخلة في الحسبة. اسأل محاسبك عن نظام صيدليتك وغيّر الاختيار.';
}

const nameCell = (r, extra = '') => `<td class="name">${esc(r.name)} ${extra}<span class="cat">${esc(r.category)} · ${esc(r.owner)}</span></td>`;
const table = (head, body) => body.length
  ? `<div class="tablebox"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table></div>`
  : '<div class="tablebox"><p class="empty">مفيش أصناف هنا دلوقتي.</p></div>';

function emptyState() {
  const where = BRANCH === 'all' ? (multi() ? 'لأي فرع' : 'للصيدلية') : `في «${esc(branchName(BRANCH))}»`;
  return `<div class="card emptybox"><h3>لسه مفيش بيانات ${where}</h3>
    <p>${isOwner() ? 'ارفع ملفات Excel من برنامج الصيدلية (الأصناف والمبيعات)، أو ملف <code>data.json</code> اللي بتطلعه الوصلة. البيانات بتتحفظ، وبتفتح بعد كده حتى من غير نت.' : 'صاحب الصيدلية لسه مرفعش بيانات.'}</p>
    ${isOwner() ? `<label class="btn primary" for="file">ارفع البيانات</label>` : ''}
    <p class="note">تقدر تسجّل المصروفات من دلوقتي من تبويب «المصروفات».</p></div>`;
}

function render() {
  const s = settings();
  const full = analyze(DATA, s, TODAY);
  const owners = ownersOf(DATA.items);
  if (OWNER !== 'all' && !owners.includes(OWNER)) OWNER = 'all';
  $('ownerSel').innerHTML = `<option value="all">كل الشركاء</option>${owners.map((o) => `<option value="${esc(o)}" ${o === OWNER ? 'selected' : ''}>${esc(o)}</option>`).join('')}`;
  $('ownerWrap').hidden = owners.length < 2;
  const only = (arr) => (OWNER === 'all' ? arr : arr.filter((r) => r.owner === OWNER));
  const A = { ...full, rows: only(full.rows), reorder: only(full.reorder), expiring: only(full.expiring), deadStock: only(full.deadStock), movers: only(full.movers) };
  $('taxNote').textContent = taxNote(A, s);
  $('customTaxWrap').hidden = s.taxMode !== 'custom';
  const has = DATA.items.length > 0;
  const offerRows = [...new Map([...A.expiring, ...A.deadStock].map((r) => [r.code, r])).values()];
  const stockVal = A.rows.reduce((a, r) => a + r.qty * r.cost, 0);
  const riskVal = A.expiring.reduce((a, r) => a + r.atRisk * r.cost, 0);
  const deadVal = A.deadStock.reduce((a, r) => a + r.qty * r.cost, 0);
  const monthExp = EXP_READY ? expenseTotals(EXPENSES, new Date(TODAY.getFullYear(), TODAY.getMonth(), 1), addDays(TODAY, 1), BRANCH === 'all' ? 'all' : BRANCH_ID()) : null;

  $('tiles').hidden = !has && !monthExp?.count;
  $('tiles').innerHTML = `
    <div class="tile acc"><span class="k">بضاعة على الرف (بسعر الشراء)</span><span class="v">${fmt(stockVal)}</span><span class="s">${A.rows.length} صنف</span></div>
    <div class="tile crit"><span class="k">ممكن تنتهي قبل ما تتباع</span><span class="v">${fmt(riskVal)}</span><span class="s">${A.expiring.length} صنف خلال ${s.expWin} يوم</span></div>
    <div class="tile warn"><span class="k">فلوس واقفة في راكد</span><span class="v">${fmt(deadVal)}</span><span class="s">${A.deadStock.length} صنف من غير بيع 45+ يوم</span></div>
    <div class="tile"><span class="k">مصروفات الشهر ده</span><span class="v">${fmt(monthExp?.operating ?? 0)}</span><span class="s">${monthExp?.withdrawals ? `ومسحوبات ${fmt(monthExp.withdrawals)} ج` : `${A.reorder.length} صنف محتاج يتطلب`}</span></div>`;

  const nChanged = PREV_DATA ? priceChanges(PREV_DATA.items, DATA.items).length : 0;
  const counts = { reorder: A.reorder.length, expiry: A.expiring.length, dead: A.deadStock.length, offers: offerRows.length, movers: A.movers.length, partners: owners.length, ...(nChanged ? { changes: nChanged } : {}) };
  if (!TABS.some(([id]) => id === TAB) || (TAB === 'patients' && !isOwner())) TAB = 'reorder';
  const [secId, , secTabs] = sectionOf(TAB);
  LAST_TAB[secId] = TAB;
  store.set('saydaliti-tab-v1', TAB);
  const urgent = { stock: has ? A.reorder.length + A.expiring.length : 0 };
  $('sections').innerHTML = visibleSections().map(([id, t]) => `<button class="sec" data-sec="${id}" aria-pressed="${id === secId}">${t}${urgent[id] ? `<span class="cnt">${urgent[id]}</span>` : ''}</button>`).join('');
  $('tabs').hidden = secTabs.length < 2;
  $('tabs').innerHTML = secTabs.map(([id, t]) => `<button class="tab" role="tab" data-tab="${id}" aria-selected="${id === TAB}">${t}${has && counts[id] !== undefined ? `<span class="cnt">${counts[id]}</span>` : ''}</button>`).join('');

  let html;
  if (TAB === 'expenses') html = renderExpenses();
  else if (TAB === 'pos') html = renderPosSales();
  else if (TAB === 'shortages') html = renderShortages(full);
  else if (TAB === 'prices') html = renderPrices(A);
  else if (TAB === 'changes' && has) html = renderPriceChanges();
  else if (TAB === 'patients') html = renderPatients();
  else if (!has && NEEDS_DATA.has(TAB)) html = emptyState();
  else if (TAB === 'reorder') {
    html = renderReorder(A, s);
  } else if (TAB === 'expiry') {
    html = '<p>الكمية اللي غالباً مش هتتباع قبل الصلاحية على حسب سرعة السحب. اعمل عليها عرض، أو رجّعها للمخزن لو ينفع.</p>' + table(
      ['الصنف', 'الصلاحية', 'في الرف', 'متوقع يتباع', 'في خطر', 'قيمتها', ''],
      A.expiring.map((r) => `<tr>${nameCell(r)}<td><span class="pill ${r.expDays <= 30 ? 'crit' : 'warn'}">${r.expDays <= 0 ? 'منتهي' : `بعد ${fmt(r.expDays)} يوم`}</span></td><td class="n">${fmt(r.qty)}</td><td class="n">${fmt(r.qty - r.atRisk)}</td><td class="n"><b>${fmt(r.atRisk)}</b></td><td>${egp(r.atRisk * r.cost)}</td><td><button class="btn" data-calc="${esc(r.code)}">احسب عرض</button></td></tr>`));
  } else if (TAB === 'dead') {
    html = '<p>أصناف متباعتش من 45 يوم أو أكتر. متطلبش منها تاني، وفكّر في عرض عليها.</p>' + table(
      ['الصنف', 'آخر بيع', 'في الرف', 'فلوس واقفة', ''],
      A.deadStock.map((r) => `<tr>${nameCell(r)}<td>${r.lastSale === null ? '<span class="pill crit">ولا مرة</span>' : `<span class="pill warn">من ${fmt(r.lastSale)} يوم</span>`}</td><td class="n">${fmt(r.qty)}</td><td>${egp(r.qty * r.cost)}</td><td><button class="btn" data-calc="${esc(r.code)}">احسب عرض</button></td></tr>`));
  } else if (TAB === 'movers') {
    html = `<p>مرتبة بالفلوس اللي دخلت منها في آخر ${A.periodDays} يوم.</p>` + table(
      ['الصنف', 'اتباع', 'في الشهر', 'المبيعات', 'مكسبك الصافي في العلبة'],
      A.movers.map((r) => { const p = profitAt(r.price, r, A); return `<tr>${nameCell(r)}<td class="n">${fmt(r.sold)}</td><td class="n">${fmt(r.monthly, 1)}</td><td>${egp(r.revenue)}</td><td><span class="pill ${p.net < 0 ? 'crit' : p.pct < s.target ? 'warn' : 'ok'}"><span class="n">${fmt(p.net, 2)}</span> ج · <span class="n">${fmt(p.pct, 0)}%</span></span></td></tr>`; }));
  } else if (TAB === 'offers') {
    html = renderOffers(A, offerRows);
  } else if (TAB === 'morning') {
    const name = SESS.pharmacy?.name || 'الصيدلية';
    html = `<p>ملخص اليوم في رسالة واحدة: الفلوس اللي في خطر، تطلب إيه، وتعمل عرض على إيه. انسخه وابعته على واتساب${OWNER !== 'all' ? ` (ده لبضاعة ${esc(OWNER)} بس)` : ''}${BRANCH !== 'all' && multi() ? ` (${esc(branchName(BRANCH))})` : ''}.</p>
      <div class="card msg"><textarea id="morningMsg" aria-label="تقرير الصبح" style="min-height:320px">${esc(morningReport(A, { pharmacyName: name, shortages: FEATURES_READY ? shortagePlan(SHORTAGES, A.rows).filter((x) => x.found) : [], priceChanged: nChanged }))}</textarea>
      <div class="row"><button class="btn primary" id="copyMorning">انسخ التقرير</button><span class="note" id="copyMorningNote"></span></div></div>`;
  } else if (TAB === 'books') {
    html = renderBooks(full, only);
  } else if (TAB === 'partners') {
    const ps = partnerSummary(full);
    const tot = ps.reduce((a, p) => ({ s: a.s + p.monthlySales, n: a.n + p.monthlyNet }), { s: 0, n: 0 });
    html = `<p>كل شريك وبضاعته. المصاريف والضرايب متقسمة على الشركاء بنسبة مبيعات كل واحد. صاحب كل صنف بيتحدد من عمود «الشريك» في ملف الأصناف.</p>` + table(
      ['الشريك', 'أصناف', 'بضاعته (بسعر الشراء)', 'مبيعاته في الشهر', 'مكسبه الصافي في الشهر', 'في خطر الصلاحية', 'راكد'],
      ps.map((p) => `<tr><td><b>${esc(p.owner)}</b></td><td class="n">${fmt(p.items)}</td><td>${egp(p.stockVal)}</td><td>${egp(p.monthlySales)} <span class="muted n">${fmt(tot.s ? p.monthlySales / tot.s * 100 : 0)}%</span></td><td><span class="pill ${p.monthlyNet < 0 ? 'crit' : 'ok'}"><span class="n">${fmt(p.monthlyNet)}</span> ج</span></td><td>${egp(p.riskVal)}</td><td>${egp(p.deadVal)}</td></tr>`));
  } else {
    html = renderCalc(A, s);
  }
  $('panel').innerHTML = html;
  if (has && TAB === 'calc') bindCalc(A, s);
  if (has && TAB === 'offers') bindOffers(offerRows);
  if (TAB === 'patients' && isOwner() && FEATURES_READY) bindPatients();
}

const PERIODS = [['thisMonth', 'الشهر ده'], ['lastMonth', 'الشهر اللي فات'], ['last90', 'آخر 3 شهور'], ['all', 'كل الفترة']];
function periodRange(p) {
  const y = TODAY.getFullYear(), m = TODAY.getMonth();
  if (p === 'thisMonth') return [new Date(y, m, 1), addDays(TODAY, 1)];
  if (p === 'lastMonth') return [new Date(y, m - 1, 1), new Date(y, m, 1)];
  if (p === 'last90') return [addDays(TODAY, -90), addDays(TODAY, 1)];
  return [null, null];
}
const periodSelect = (id, cur) => `<label class="owner">الفترة<select id="${id}">${PERIODS.map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;

function renderBooks(full, only) {
  const [from, to] = periodRange(PERIOD);
  const L = ledger(DATA, full, from, to);
  const rows = only(L.rows);
  const t = rows.reduce((a, r) => { for (const k of Object.keys(a)) a[k] += r[k]; return a; }, { bought: 0, listValue: 0, discount: 0, revenue: 0, cogs: 0, lost: 0, tax: 0, overhead: 0, net: 0 });
  const E = EXP_READY && OWNER === 'all' ? expenseTotals(EXPENSES, from, to, BRANCH === 'all' ? 'all' : BRANCH_ID()) : null;
  const actual = E && E.count > 0;
  const line = (label, v, cls = '') => `<div class="${cls}"><span>${label}</span><span class="n">${fmt(v, 2)}</span></div>`;
  const noPurch = !(DATA.purchases || []).length;
  const net = actual ? t.revenue - t.cogs - t.tax - t.lost - E.operating : t.net;
  return `<div class="row">${periodSelect('periodSel', PERIOD)}</div>
  <div class="calc">
    <div class="card"><h3>الملخص</h3><div class="ledger">
      ${line('اشتريت بضاعة بـ', t.bought)}
      ${line('المبيعات بسعر البيع الأصلي', t.listValue)}
      ${line('− خصومات عملتها', t.discount)}
      ${line('= اللي دخل فعلاً', t.revenue, 'tot')}
      ${line('− تكلفة البضاعة اللي اتباعت', t.cogs)}
      ${line('− الضرايب', t.tax)}
      ${actual ? line('− المصروفات المتسجلة (كهربا، إيجار، مرتبات…)', E.operating) : line('− نصيب المصاريف (من التقدير الشهري)', t.overhead)}
      ${line('− خسارة هالك ومنتهي', t.lost)}
      ${line('مكسبك الصافي', net, 'tot')}
      ${actual && E.withdrawals ? `${line('− مسحوبات', E.withdrawals)}${line('اللي فاضل في الصيدلية', net - E.withdrawals, 'tot')}` : ''}
    </div>
    ${!actual ? '<p class="note">المصاريف هنا تقدير من الإعدادات. سجّل المصروفات الفعلية في تبويب «المصروفات» وهتتحسب بالظبط.</p>' : ''}
    ${OWNER !== 'all' ? '<p class="note">المصروفات المتسجلة بتظهر لما تختار «كل الشركاء».</p>' : ''}</div>
    <div class="card"><h3>اللي ضيّع فلوس</h3><div class="ledger">
      ${line('الخصومات', t.discount)}${line('الهالك والمنتهي', t.lost)}
      ${line('المجموع', t.discount + t.lost, 'tot')}
    </div>
    <p class="note">${t.revenue > 0 ? `الخصم والهالك أكلوا ${fmt((t.discount + t.lost) / (t.revenue + t.discount) * 100, 1)}% من مبيعاتك.` : 'مفيش مبيعات في الفترة دي.'}</p>
    ${noPurch ? '<p class="note">«اشتريت بكام» محتاج ملف المشتريات (التاريخ، الكود، الكمية، سعر الشراء).</p>' : ''}
    </div>
  </div>` + table(
    ['الصنف', 'اشتريت', 'اتباع', 'خصومات', 'دخل فعلاً', 'هالك', 'المكسب الصافي'],
    rows.map((r) => `<tr>${nameCell(r)}<td>${egp(r.bought)}</td><td class="n">${fmt(r.soldQty)}</td><td>${r.discount ? egp(r.discount) : '<span class="muted">—</span>'}</td><td>${egp(r.revenue)}</td><td>${r.lost ? `<span class="pill crit">${egp(r.lost)}</span>` : '<span class="muted">—</span>'}</td><td><span class="pill ${r.net < 0 ? 'crit' : 'ok'}"><span class="n">${fmt(r.net)}</span> ج</span></td></tr>`));
}

// ---------- Expenses ----------
function renderExpenses() {
  if (!EXP_READY) return '<div class="card emptybox"><h3>المصروفات محتاجة تحديث قاعدة البيانات</h3><p>التحديث ده بيضيف جدول المصروفات والفروع. بعد ما يتعمل، الصفحة دي هتشتغل على طول.</p></div>';
  const [from, to] = periodRange(EXP_PERIOD);
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  const T = expenseTotals(EXPENSES, from, to, bid);
  const list = EXPENSES.filter((e) => (bid === 'all' || e.branch_id === bid))
    .filter((e) => { const d = new Date(`${e.spent_on}T00:00:00`); return (!from || d >= from) && (!to || d < to); })
    .sort((a, b) => b.spent_on.localeCompare(a.spent_on) || String(b.created_at).localeCompare(String(a.created_at)));
  const E = EDIT_EXP ? EXPENSES.find((x) => x.id === EDIT_EXP) : null;
  if (EDIT_EXP && !E) EDIT_EXP = null;
  const defBranch = E ? key(E.branch_id) : BRANCH !== 'all' ? BRANCH : key(BRANCHES[0]?.id);
  const form = isOwner() ? `<form id="expForm" class="card stack${E ? ' editing' : ''}">
      <h3>${E ? 'عدّل المصروف' : 'سجّل مصروف أو مسحوبات'}</h3>
      <div class="grid2">
        <label>النوع<select id="expKind">${EXPENSE_KINDS.map(([v, t]) => `<option value="${v}" ${E?.kind === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>المبلغ (جنيه)<input id="expAmount" type="number" inputmode="decimal" min="0.01" step="0.01" required value="${E ? esc(+E.amount) : ''}"></label>
        <label>التاريخ<input id="expDate" type="date" value="${E ? esc(E.spent_on) : isoDay(TODAY)}" max="${isoDay(TODAY)}" required></label>
        ${multi() ? `<label>الفرع<select id="expBranch">${BRANCHES.map((b) => `<option value="${esc(key(b.id))}" ${key(b.id) === defBranch ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>` : ''}
        <label class="span2">ملاحظة (اختياري)<input id="expNote" maxlength="300" placeholder="مثلاً: فاتورة كهربا شهر 10، أو سحب أحمد" value="${esc(E?.note || '')}"></label>
      </div>
      <div class="row"><button class="btn primary" type="submit">${E ? 'احفظ التعديل' : 'احفظ'}</button>${E ? '<button class="btn" type="button" id="expCancel">إلغاء</button>' : ''}<span class="note" id="expMsg" role="status"></span></div>
      <p class="note">المسحوبات فلوس خرجت من الصيدلية لصاحبها أو لشريك. مش بتتحسب مصروف، بس بتظهر في الحسابات عشان تعرف فاضل كام.</p>
    </form>` : '<p class="note">صاحب الصيدلية بس اللي بيسجّل المصروفات.</p>';
  const kinds = EXPENSE_KINDS.filter(([k]) => T.byKind[k]).map(([k, t]) => `<div><span>${k === 'withdrawal' ? 'مسحوبات' : t}</span><span class="n">${fmt(T.byKind[k], 2)}</span></div>`).join('');
  const rows = list.map((e) => `<tr class="${e.pending ? 'pend' : ''}"><td class="n">${esc(e.spent_on)}</td><td>${egp(+e.amount)}</td><td>${esc(e.kind === 'withdrawal' ? 'مسحوبات' : kindLabel(e.kind))}${e.pending ? ' <span class="pill warn">مستني النت</span>' : ''}</td>${multi() ? `<td>${esc(branchName(key(e.branch_id)))}</td>` : ''}<td class="muted">${esc(e.note || '')}</td>${isOwner() ? `<td class="acts"><button class="btn" data-editexp="${esc(e.id)}">عدّل</button> <button class="btn" data-delexp="${esc(e.id)}" aria-label="امسح">امسح</button></td>` : ''}</tr>`);
  const fixed = isOwner() ? recurringSuggestions(EXPENSES, TODAY).filter((x) => bid === 'all' || x.branch_id === bid) : [];
  const fixedCard = fixed.length ? `<div class="card stack" id="fixedCard"><h3>مصاريف ثابتة لسه متسجلتش الشهر ده</h3>
      <p class="note">زي الشهر اللي فات. لو المبلغ اتغير، سجّلهم وعدّل اللي اتغير.</p>
      <div class="ledger">${fixed.map((x) => `<div><span>${esc(kindLabel(x.kind))}${x.note ? ` · ${esc(x.note)}` : ''}${multi() ? ` · ${esc(branchName(key(x.branch_id)))}` : ''}</span><span class="n">${fmt(x.amount, 2)}</span></div>`).join('')}</div>
      <div class="row"><button class="btn primary" type="button" id="addFixed">سجّلهم للشهر ده</button></div></div>` : '';
  return `${fixedCard}<div class="calc">
    ${form}
    <div class="card"><div class="row" style="justify-content:space-between"><h3>المجموع</h3>${periodSelect('expPeriodSel', EXP_PERIOD)}</div>
      <div class="ledger">${kinds || '<div><span class="muted">مفيش مصروفات في الفترة دي.</span><span></span></div>'}
        <div class="tot"><span>المصروفات (من غير المسحوبات)</span><span class="n">${fmt(T.operating, 2)}</span></div>
        ${T.withdrawals ? `<div class="tot"><span>المسحوبات</span><span class="n">${fmt(T.withdrawals, 2)}</span></div>` : ''}
      </div></div>
  </div>` + (rows.length
    ? `<div class="tablebox"><table><thead><tr><th>التاريخ</th><th>المبلغ</th><th>النوع</th>${multi() ? '<th>الفرع</th>' : ''}<th>ملاحظة</th>${isOwner() ? '<th></th>' : ''}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '');
}

let EDIT_EXP = null; // id of the expense being edited

// The database keeps expenses append-only, so an edit is saved as "delete the old one, add the new one".
async function insertExpense(fields) {
  const row = { id: crypto.randomUUID(), pharmacy_id: SESS.pharmacy.id, created_by: SESS.user.id, ...fields };
  EXPENSES.push({ ...row, created_at: new Date().toISOString(), pending: true });
  await saveExpenseCache();
  await enqueue('expense', row);
}
async function removeExpense(id) {
  EXPENSES = EXPENSES.filter((x) => x.id !== id);
  await saveExpenseCache();
  await enqueue('deleteExpense', { id });
}

async function addExpense(ev) {
  ev.preventDefault();
  const amount = Math.round((+$('expAmount').value || 0) * 100) / 100;
  const date = $('expDate').value;
  if (!(amount > 0)) { $('expMsg').textContent = 'اكتب المبلغ.'; return; }
  if (!date || date > isoDay(TODAY)) { $('expMsg').textContent = 'اختار تاريخ النهارده أو قبله.'; return; }
  const bk = multi() ? $('expBranch').value : key(BRANCHES[0]?.id);
  const editing = EDIT_EXP;
  if (editing) await removeExpense(editing);
  EDIT_EXP = null;
  await insertExpense({ branch_id: bk === 'main' ? null : bk, spent_on: date, kind: $('expKind').value, amount, note: $('expNote').value.trim() || null });
  render();
  $('expMsg').textContent = `${editing ? 'اتعدّل.' : 'اتسجل.'}${isOnline() ? '' : ' هيترفع أول ما النت يرجع.'}`;
  sync();
}

async function addFixedExpenses() {
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  const list = recurringSuggestions(EXPENSES, TODAY).filter((x) => bid === 'all' || x.branch_id === bid);
  for (const x of list) await insertExpense({ branch_id: x.branch_id, spent_on: isoDay(x.spent_on), kind: x.kind, amount: x.amount, note: x.note });
  render();
  $('expMsg').textContent = `اتسجل ${list.length} مصروف ثابت للشهر ده.${isOnline() ? '' : ' هيترفعوا أول ما النت يرجع.'}`;
  sync();
}

async function deleteExpense(id) {
  const e = EXPENSES.find((x) => x.id === id);
  if (!e || !confirm(`تمسح ${kindLabel(e.kind)} بـ ${fmt(+e.amount)} جنيه بتاريخ ${e.spent_on}؟`)) return;
  if (EDIT_EXP === id) EDIT_EXP = null;
  await removeExpense(id);
  render(); sync();
}

const expCacheKey = () => `exp:${SESS.pharmacy.id}`;
const saveExpenseCache = () => kvSet(expCacheKey(), EXPENSES);

async function loadExpenses() {
  const queued = await pending();
  const pendingIds = new Set(queued.filter((q) => q.type === 'expense').map((q) => q.payload.id));
  const deleted = new Set(queued.filter((q) => q.type === 'deleteExpense').map((q) => q.payload.id));
  let server = null;
  if (isOnline()) {
    const { data, error } = await SESS.client.from('expenses').select('id, branch_id, spent_on, kind, amount, note, created_at')
      .eq('pharmacy_id', SESS.pharmacy.id).gte('spent_on', isoDay(addDays(TODAY, -400))).order('spent_on', { ascending: false }).limit(5000);
    if (error && !/fetch|network/i.test(error.message)) { EXP_READY = false; return; }
    if (!error) server = data;
  }
  const cached = await kvGet(expCacheKey(), []);
  const base = server ?? cached.filter((e) => !e.pending);
  const local = cached.filter((e) => e.pending && pendingIds.has(e.id) && !base.some((b) => b.id === e.id));
  EXPENSES = [...base.filter((e) => !deleted.has(e.id)).map((e) => ({ ...e, pending: false })), ...local];
  EXP_READY = true;
  await saveExpenseCache();
}

// ---------- Suppliers and orders (kept in the shared pharmacy settings, no extra tables) ----------
const SUPPLIERS = () => SESS.pharmacy?.settings?.suppliers || [];
const CHOSEN = () => SESS.pharmacy?.settings?.supplierFor || {};
let EDIT_SUP = null;
let SUP_OPEN = false; // the suppliers box stays as the owner left it across re-renders

// Settings are one shared object (form fields, suppliers, chosen supplier per item): merge, then save.
async function saveShared(patch) {
  SESS.pharmacy.settings = { ...(SESS.pharmacy.settings || {}), ...patch };
  rememberSettings(SESS.pharmacy.settings);
  await enqueue('settings', { p_pharmacy: SESS.pharmacy.id, p_settings: SESS.pharmacy.settings });
  sync();
}

function renderReorder(A, s) {
  const sup = SUPPLIERS();
  const chosen = CHOSEN();
  const supCell = (r) => {
    if (!sup.length) return '';
    const p = pickSupplier(r, sup, chosen);
    if (!isOwner()) return `<td>${esc(p.supplier.name)}${p.pct ? ` <span class="muted n">−${fmt(p.pct, 1)}%</span>` : ''}</td>`;
    return `<td><select class="supsel" data-supfor="${esc(r.code)}" aria-label="المورد لـ ${esc(r.name)}">${sup.map((x) => `<option value="${esc(x.id)}" ${x.id === p.supplier.id ? 'selected' : ''}>${esc(x.name)} (−${fmt(pickSupplier(r, [x]).pct, 1)}%)</option>`).join('')}</select></td>`;
  };
  const costCell = (r) => {
    const p = sup.length ? pickSupplier(r, sup, chosen) : null;
    const full = r.order * r.cost;
    if (!p?.pct) return `<td>${egp(full)}</td>`;
    return `<td>${egp(full * (1 - p.pct / 100))} <span class="muted strike n">${fmt(full)}</span></td>`;
  };
  const head = ['الصنف', 'في الرف', 'بيتسحب في الشهر', 'هيخلص بعد', 'اطلب', ...(sup.length ? ['المورد'] : []), 'التكلفة'];
  const body = A.reorder.map((r) => `<tr>${nameCell(r, SHORT_CODES.has(r.code) ? '<span class="pill crit">ناقص في السوق</span>' : '')}<td class="n">${fmt(r.qty)}</td><td class="n">${fmt(r.monthly, 1)}</td><td><span class="pill ${r.daysCover <= s.lead ? 'crit' : 'warn'}">${r.daysCover < 1 ? 'خلص تقريباً' : `${fmt(r.daysCover)} يوم`}</span></td><td class="n"><b>${fmt(r.order)}</b></td>${supCell(r)}${costCell(r)}</tr>`);
  let orders = '';
  if (A.reorder.length) {
    const groups = ordersBySupplier(A.reorder, sup, chosen);
    const bname = multi() && BRANCH !== 'all' ? branchName(BRANCH) : '';
    orders = `<h3>الطلبيات${sup.length ? ' حسب المورد' : ''}</h3><div class="orders">${groups.map((g, i) => {
      const msg = orderMessage(g, { pharmacyName: SESS.pharmacy?.name || 'الصيدلية', branchName: bname });
      return `<div class="card msg"><div class="row" style="justify-content:space-between"><b>${esc(g.supplier?.name || (sup.length ? 'من غير مورد' : 'الطلبية'))}</b>
        <span class="muted">${fmt(g.lines.length)} صنف · ${egp(g.cost)}${g.saved > 0.5 ? ` · وفّرت <span class="n">${fmt(g.saved)}</span> ج` : ''}</span></div>
        <textarea readonly id="orderMsg${i}" aria-label="رسالة الطلبية">${esc(msg)}</textarea>
        <div class="row"><button class="btn primary" type="button" data-wa="${i}" data-phone="${esc(g.supplier?.phone || '')}">ابعتها على واتساب</button><button class="btn" type="button" data-copyorder="${i}">انسخ</button><span class="note" id="orderNote${i}"></span></div></div>`;
    }).join('')}</div>`;
  }
  const hint = !sup.length ? `<p class="note">${isOwner() ? 'ضيف الموردين وخصم كل واحد تحت، والبرنامج هيختارلك أرخص مورد لكل صنف ويقسم الطلبية عليهم.' : 'صاحب الصيدلية لسه مضافش موردين.'}</p>` : '';
  return `<p>أصناف هتخلص خلال ${s.lead + 7} يوم أو أقل على حسب سرعة سحبها. الكمية المقترحة تكفيك ${s.cover} يوم.</p>`
    + table(head, body) + orders + hint + renderSuppliers();
}

function renderSuppliers() {
  const sup = SUPPLIERS();
  const E = EDIT_SUP ? sup.find((x) => x.id === EDIT_SUP) : null;
  const pct = (v) => (v === undefined || v === null || v === '' ? '' : esc(v));
  const list = sup.length ? `<div class="tablebox"><table><thead><tr><th>المورد</th><th>واتساب</th><th>الخصم العادي</th><th>أدوية</th><th>تجميل</th><th>مستلزمات</th>${isOwner() ? '<th></th>' : ''}</tr></thead><tbody>${sup.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td class="n">${x.phone ? `…${esc(String(x.phone).slice(-4))}` : '<span class="muted">—</span>'}</td>
    ${['all', 'medicine', 'cosmetics', 'supplies'].map((k) => `<td class="n">${x.discounts?.[k] !== undefined && x.discounts[k] !== '' ? `${fmt(+x.discounts[k], 1)}%` : '<span class="muted">—</span>'}</td>`).join('')}
    ${isOwner() ? `<td class="acts"><button class="btn" type="button" data-editsup="${esc(x.id)}">عدّل</button> <button class="btn" type="button" data-delsup="${esc(x.id)}">امسح</button></td>` : ''}</tr>`).join('')}</tbody></table></div>` : '';
  const form = isOwner() ? `<form id="supForm" class="stack" style="margin-top:10px">
      <b>${E ? `عدّل ${esc(E.name)}` : 'مورد جديد'}</b>
      <div class="grid2">
        <label>اسم المورد<input id="supName" maxlength="80" required value="${esc(E?.name || '')}" placeholder="مثلاً: مخزن الأمل"></label>
        <label>رقم الواتساب (اختياري)<input id="supPhone" type="tel" inputmode="tel" value="${E?.phone ? esc('0' + String(E.phone).slice(2)) : ''}" placeholder="01xxxxxxxxx"></label>
        <label>الخصم العادي %<input id="supAll" type="number" min="0" max="100" step="0.1" value="${pct(E?.discounts?.all)}" placeholder="مثلاً 5"></label>
        <label>خصم الأدوية % (لو مختلف)<input id="supMed" type="number" min="0" max="100" step="0.1" value="${pct(E?.discounts?.medicine)}"></label>
        <label>خصم التجميل % (لو مختلف)<input id="supCos" type="number" min="0" max="100" step="0.1" value="${pct(E?.discounts?.cosmetics)}"></label>
        <label>خصم المستلزمات % (لو مختلف)<input id="supSup" type="number" min="0" max="100" step="0.1" value="${pct(E?.discounts?.supplies)}"></label>
      </div>
      <div class="row"><button class="btn primary" type="submit">${E ? 'احفظ التعديل' : 'ضيف المورد'}</button>${E ? '<button class="btn" type="button" id="supCancel">إلغاء</button>' : ''}<span class="note" id="supMsg" role="status"></span></div>
      <p class="note">الخصم هنا إضافي على سعر الشراء. لو مورد معين بيدّي صنف أرخص، اختاره للصنف ده من القايمة في الجدول فوق.</p>
    </form>` : '';
  return `<details class="help" id="supBox" ${E || !sup.length || SUP_OPEN ? 'open' : ''}><summary>الموردين وخصوماتهم (${fmt(sup.length)})</summary>${list}${form}</details>`;
}

async function saveSupplier(e) {
  e.preventDefault();
  const msg = (t) => { $('supMsg').textContent = t; };
  const name = $('supName').value.trim();
  if (!name) return msg('اكتب اسم المورد.');
  const rawPhone = $('supPhone').value.trim();
  const phone = rawPhone ? normalizeEgPhone(rawPhone) : '';
  if (rawPhone && !phone) return msg('رقم الواتساب لازم يبقى رقم موبايل مصري صحيح، أو سيبه فاضي.');
  const num = (id) => { const v = $(id).value.trim(); return v === '' ? undefined : Math.max(0, Math.min(100, +v || 0)); };
  const discounts = Object.fromEntries([['all', num('supAll') ?? 0], ['medicine', num('supMed')], ['cosmetics', num('supCos')], ['supplies', num('supSup')]].filter(([, v]) => v !== undefined));
  const sup = [...SUPPLIERS()];
  if (EDIT_SUP) {
    const i = sup.findIndex((x) => x.id === EDIT_SUP);
    if (i >= 0) sup[i] = { ...sup[i], name, phone, discounts };
  } else {
    if (sup.some((x) => x.name === name)) return msg('المورد ده موجود.');
    sup.push({ id: crypto.randomUUID().slice(0, 8), name, phone, discounts });
  }
  EDIT_SUP = null;
  SUP_OPEN = true;
  await saveShared({ suppliers: sup });
  render();
  $('supMsg') && ($('supMsg').textContent = isOnline() ? 'اتحفظ.' : 'اتحفظ على الجهاز، وهيترفع أول ما النت يرجع.');
}

async function deleteSupplier(id) {
  const x = SUPPLIERS().find((y) => y.id === id);
  if (!x || !confirm(`تمسح ${x.name} من الموردين؟`)) return;
  const supplierFor = Object.fromEntries(Object.entries(CHOSEN()).filter(([, v]) => v !== id));
  await saveShared({ suppliers: SUPPLIERS().filter((y) => y.id !== id), supplierFor });
  render();
}

async function chooseSupplier(code, id) {
  const r = DATA.items.find((i) => i.code === code);
  const best = r && pickSupplier(r, SUPPLIERS());
  const supplierFor = { ...CHOSEN() };
  // Picking the supplier the app would pick anyway just clears the manual choice.
  if (best && best.supplier.id === id) delete supplierFor[code]; else supplierFor[code] = id;
  await saveShared({ supplierFor });
  render();
}

// ---------- Price changes between the last two uploads ----------
let PREV_DATA = null;
function renderPriceChanges() {
  const ch = PREV_DATA ? priceChanges(PREV_DATA.items, DATA.items) : [];
  const shown = BRANCH === 'all' ? BRANCHES.map((b) => SNAP.get(key(b.id))).filter(Boolean) : [SNAP.get(BRANCH)].filter(Boolean);
  const when = (iso) => new Date(iso).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
  const prevAt = shown.map((x) => x.prev?.at).filter(Boolean).sort().pop();
  const curAt = shown.map((x) => x.at).filter(Boolean).sort().pop();
  if (!PREV_DATA) return '<div class="card emptybox"><h3>محتاج ملفين على الأقل</h3><p>البرنامج بيقارن آخر ملف اترفع باللي قبله. أول ما ترفع بيانات تاني (أو الوصلة ترفع لوحدها بكره)، الأصناف اللي سعرها اتغير هتظهر هنا.</p></div>';
  const rows = ch.map((c) => `<tr>${nameCell(c)}
    <td>${c.priceMoved ? `<span class="n">${fmt(c.oldPrice, 2)}</span> ← <b class="n">${fmt(c.newPrice, 2)}</b> <span class="pill ${c.pct > 0 ? 'warn' : 'ok'}"><span class="n">${c.pct > 0 ? '+' : ''}${fmt(c.pct, 0)}%</span></span>` : '<span class="muted">زي ما هو</span>'}</td>
    <td>${c.costMoved ? `<span class="n">${fmt(c.oldCost, 2)}</span> ← <b class="n">${fmt(c.newCost, 2)}</b>` : '<span class="muted">زي ما هو</span>'}</td>
    <td class="n">${fmt(c.qty)}</td>
    <td><span class="pill ${c.newMargin < 0 ? 'crit' : c.newMargin < c.oldMargin ? 'warn' : 'ok'}"><span class="n">${fmt(c.oldMargin, 2)}</span> ← <span class="n">${fmt(c.newMargin, 2)}</span></span></td></tr>`);
  return `<p>الأصناف اللي سعر بيعها أو سعر شرائها اتغير بين آخر ملفين اترفعوا (${prevAt ? when(prevAt) : '—'} و${curAt ? when(curAt) : '—'}).</p>
    <p class="note">اتأكد إن سعر البيع في برنامج الصيدلية مطابق للسعر المكتوب على العلبة اللي بتبيعها، وراجع سعر العروض على الأصناف دي.</p>`
    + (rows.length ? `<div class="tablebox"><table><thead><tr><th>الصنف</th><th>سعر البيع</th><th>سعر الشراء</th><th>في الرف</th><th>مكسب العلبة</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
      : '<div class="tablebox"><p class="empty">مفيش أسعار اتغيرت بين آخر ملفين.</p></div>');
}

// ---------- Cashier receipts (migration 009) ----------
let POS_SALES = [];
let POS_READY = true;
let POS_PERIOD = 'thisMonth';
function renderPosSales() {
  if (!POS_READY) return '<div class="card emptybox"><h3>مبيعات الكاشير محتاجة تحديث قاعدة البيانات</h3><p>التحديث <code>009</code> بيضيف جدول فواتير الكاشير. الكاشير نفسه بيشتغل ويحفظ الفواتير على الجهاز لحد ما التحديث يتعمل، وبعدها بترفع لوحدها.</p><a class="btn primary" href="./cashier.html">افتح الكاشير</a></div>';
  const [from, to] = periodRange(POS_PERIOD);
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  const list = POS_SALES.filter((x) => (bid === 'all' || (x.branch_id ?? null) === bid))
    .filter((x) => { const d = new Date(x.sold_at); return (!from || d >= from) && (!to || d < to); })
    .sort((a, b) => String(b.sold_at).localeCompare(String(a.sold_at)));
  const sum = daySummary(list);
  const pay = (k) => PAYMENTS.find(([p]) => p === k)?.[1] ?? k;
  // Best sellers through the cashier in this period.
  const byItem = new Map();
  for (const x of list) for (const l of x.lines || []) {
    const sign = x.kind === 'return' ? -1 : 1;
    const o = byItem.get(l.code) || { name: l.name, qty: 0, value: 0 };
    o.qty += sign * l.qty; o.value += sign * (l.price * l.qty - (l.discount || 0));
    byItem.set(l.code, o);
  }
  const top = [...byItem.values()].sort((a, b) => b.value - a.value).slice(0, 10);
  return `<div class="row" style="justify-content:space-between">${periodSelect('posPeriodSel', POS_PERIOD)}${isOwner() ? '<a class="btn primary" href="./cashier.html">افتح الكاشير</a>' : ''}</div>
  <div class="calc">
    <div class="card"><h3>المجموع</h3><div class="ledger">
      <div><span>فواتير</span><span class="n">${fmt(sum.receipts)}</span></div>
      <div><span>مبيعات</span><span class="n">${fmt(sum.sales, 2)}</span></div>
      ${sum.returns ? `<div><span>مرتجعات (${fmt(sum.returns)})</span><span class="n">${fmt(sum.returned, 2)}</span></div>` : ''}
      <div><span>خصومات</span><span class="n">${fmt(sum.discount, 2)}</span></div>
      ${Object.entries(sum.byPayment).map(([k, v]) => `<div><span>${esc(pay(k))}</span><span class="n">${fmt(v, 2)}</span></div>`).join('')}
      <div class="tot"><span>الصافي</span><span class="n">${fmt(sum.net, 2)}</span></div></div></div>
    <div class="card"><h3>الأكتر بيعاً من الكاشير</h3><div class="ledger">${top.map((t) => `<div><span>${esc(t.name)} <span class="muted n">× ${fmt(t.qty)}</span></span><span class="n">${fmt(t.value, 2)}</span></div>`).join('') || '<div><span class="muted">لسه مفيش مبيعات في الفترة دي.</span><span></span></div>'}</div></div>
  </div>
  <p class="note">الفواتير دي من شاشة الكاشير بس. لحد ما الكاشير يبقى البرنامج الأساسي، مبيعات برنامج الصيدلية بتفضل هي اللي بتتحسب في الطلبيات والحسابات.</p>`
  + (list.length ? `<div class="tablebox"><table><thead><tr><th>رقم</th><th>الوقت</th>${multi() ? '<th>الفرع</th>' : ''}<th>النوع</th><th>الأصناف</th><th>الإجمالي</th><th>الدفع</th></tr></thead><tbody>${list.slice(0, 300).map((x) => `<tr><td class="n">${esc(x.number)}</td>
      <td class="n">${new Date(x.sold_at).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</td>
      ${multi() ? `<td>${esc(branchName(key(x.branch_id)))}</td>` : ''}<td>${x.kind === 'return' ? '<span class="pill warn">مرتجع</span>' : 'بيع'}</td>
      <td class="n">${fmt((x.lines || []).reduce((a, l) => a + l.qty, 0))}</td><td class="n">${fmt(x.total, 2)}</td><td>${esc(pay(x.payment))}</td></tr>`).join('')}</tbody></table></div>` : '');
}

// ---------- Shortages, market prices, patient reminders (migration 008) ----------
let FEATURES_READY = true;
let SHORTAGES = [], PRICES = [], PATIENTS = [], REMINDERS = [];
let SHORT_CODES = new Set();
const LISTS = { shortages: () => SHORTAGES, market_prices: () => PRICES, patients: () => PATIENTS, reminders: () => REMINDERS, pos_sales: () => POS_SALES };
const cacheKey = (table) => `${table}:${SESS.pharmacy.id}`;
const needUpdate = () => '<div class="card emptybox"><h3>الجزء ده محتاج تحديث قاعدة البيانات</h3><p>التحديث بيضيف جداول النواقص وأسعار السوق وتذكير المرضى. بعد ما يتطبق، الصفحة دي هتشتغل على طول.</p></div>';
const itemOptions = () => `<datalist id="itemList">${[...DATA.items].sort((a, b) => a.name.localeCompare(b.name, 'ar')).map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>`;
const findItem = (name) => DATA.items.find((i) => i.name.trim() === String(name).trim());

function refreshDerived() {
  refreshMarket();
  SHORT_CODES = new Set(SHORTAGES.filter((x) => x.status !== 'resolved').map((x) => x.code || findItem(x.name)?.code).filter(Boolean));
}

// Server rows, plus local changes still waiting in the outbox; falls back to the copy on this device.
async function loadTable(table, cols, order = 'created_at') {
  const q = await pending();
  const mine = (t) => (e) => e.payload?.table === table && e.type === t;
  const ins = q.filter(mine('insert')).map((e) => ({ ...e.payload.row, pending: true }));
  const del = new Set(q.filter(mine('delete')).map((e) => e.payload.id));
  const upd = q.filter(mine('update'));
  let rows = null;
  if (isOnline()) {
    const { data, error } = await SESS.client.from(table).select(cols).eq('pharmacy_id', SESS.pharmacy.id).order(order, { ascending: false }).limit(5000);
    if (error && !/fetch|network/i.test(error.message)) throw Object.assign(new Error(error.message), { missing: true });
    if (!error) rows = data;
  }
  if (!rows) rows = (await kvGet(cacheKey(table), [])).filter((r) => !r.pending);
  rows = rows.filter((r) => !del.has(r.id));
  for (const r of ins) if (!rows.some((x) => x.id === r.id)) rows.push(r);
  for (const u of upd) { const r = rows.find((x) => x.id === u.payload.id); if (r) Object.assign(r, u.payload.patch); }
  await kvSet(cacheKey(table), rows);
  return rows;
}

async function loadFeatures() {
  try {
    [SHORTAGES, PRICES] = await Promise.all([
      loadTable('shortages', 'id, code, name, note, status, created_at, resolved_at'),
      loadTable('market_prices', 'id, code, price, source, seen_on, created_by, created_at', 'seen_on'),
    ]);
    try { POS_SALES = await loadTable('pos_sales', 'id, branch_id, number, sold_at, kind, lines, total, discount, paid, payment', 'sold_at'); POS_READY = true; } catch (e) { if (e.missing) POS_READY = false; }
    if (isOwner()) {
      [PATIENTS, REMINDERS] = await Promise.all([
        loadTable('patients', 'id, name, phone, active, created_at'),
        loadTable('reminders', 'id, patient_id, medicine, kind, dose_times, refill_every_days, next_refill, active, last_sent_at, created_at'),
      ]);
    }
    FEATURES_READY = true;
  } catch (e) {
    if (e.missing) { FEATURES_READY = false; POS_READY = false; }
  }
  refreshDerived();
}

async function localInsert(table, row) {
  const full = { id: crypto.randomUUID(), pharmacy_id: SESS.pharmacy.id, created_by: SESS.user.id, ...row };
  LISTS[table]().push({ ...full, pending: true, created_at: new Date().toISOString() });
  await kvSet(cacheKey(table), LISTS[table]());
  await enqueue('insert', { table, row: full });
  refreshDerived(); render(); sync();
  return full;
}
async function localUpdate(table, id, patch) {
  const r = LISTS[table]().find((x) => x.id === id);
  if (r) Object.assign(r, patch);
  await kvSet(cacheKey(table), LISTS[table]());
  await enqueue('update', { table, id, patch });
  refreshDerived(); render(); sync();
}
async function localDelete(table, id) {
  const list = LISTS[table]();
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
  if (table === 'patients') REMINDERS = REMINDERS.filter((r) => r.patient_id !== id); // the database removes them too
  await kvSet(cacheKey(table), list);
  if (table === 'patients') await kvSet(cacheKey('reminders'), REMINDERS);
  await enqueue('delete', { table, id });
  refreshDerived(); render(); sync();
}
const savedNote = () => (isOnline() ? 'اتسجل.' : 'اتسجل على الجهاز، وهيترفع أول ما النت يرجع.');
const pendingPill = (r) => (r.pending ? ' <span class="pill warn">مستني النت</span>' : '');

// ----- Market shortages -----
function renderShortages(full) {
  if (!FEATURES_READY) return needUpdate();
  const plan = shortagePlan(SHORTAGES, full.rows);
  const resolved = SHORTAGES.filter((x) => x.status === 'resolved').length;
  const form = isOwner() ? `<form id="shortForm" class="card stack">
      <h3>صنف ناقص في السوق</h3>
      <p class="note">لما صنف يختفي من المخازن، سجّله هنا. البرنامج هيقولك معاك منه كام ويكفيك قد إيه، وأول ما يتوفر تاني اطلب الكمية المقترحة عشان متتزنقش لو اختفى تاني.</p>
      <div class="grid2"><label>الصنف<input id="shortName" list="itemList" required maxlength="160" placeholder="اكتب أو اختار من أصنافك"></label>
      <label>ملاحظة (اختياري)<input id="shortNote" maxlength="300" placeholder="مثلاً: مش موجود عند ابن سينا والمتحدة"></label></div>
      <div class="row"><button class="btn primary" type="submit">ضيفه للنواقص</button><span class="note" id="shortMsg" role="status"></span></div>
      ${itemOptions()}</form>` : '';
  const rows = plan.map((x) => `<tr><td class="name">${esc(x.found ? x.row.name : x.name)}${pendingPill(x)}${x.note ? `<span class="cat">${esc(x.note)}</span>` : ''}</td>
    <td class="n">${x.found ? fmt(x.qty) : '<span class="muted">—</span>'}</td>
    <td>${!x.found ? '<span class="muted">مش في أصنافك</span>' : x.daysCover === Infinity ? '<span class="muted">مبيتسحبش</span>' : `<span class="pill ${x.daysCover <= 14 ? 'crit' : x.daysCover <= 30 ? 'warn' : 'ok'}">${x.daysCover < 1 ? 'خلص تقريباً' : `${fmt(x.daysCover)} يوم`}</span>`}</td>
    <td class="n"><b>${x.found && x.stockUp ? fmt(x.stockUp) : '—'}</b></td><td>${x.found && x.stockUp ? egp(x.cost) : '<span class="muted">—</span>'}</td>
    ${isOwner() ? `<td><button class="btn" data-shortok="${esc(x.id)}">اتوفر</button> <button class="btn" data-shortdel="${esc(x.id)}" aria-label="امسح">امسح</button></td>` : ''}</tr>`);
  return form + (rows.length
    ? `<div class="tablebox"><table><thead><tr><th>الصنف</th><th>في الرف</th><th>يكفيك</th><th>اطلب لما يتوفر (يكفي شهرين)</th><th>التكلفة</th>${isOwner() ? '<th></th>' : ''}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '<div class="tablebox"><p class="empty">مفيش نواقص متسجلة دلوقتي.</p></div>')
    + (resolved ? `<p class="note">${fmt(resolved)} صنف اتوفر تاني واتشال من القايمة.</p>` : '')
    + '<p class="note">الأصناف دي بتظهر عليها علامة «ناقص في السوق» في «اطلب إيه»، وفي تقرير الصبح.</p>';
}
async function addShortage(e) {
  e.preventDefault();
  const name = $('shortName').value.trim();
  if (!name) return;
  const it = findItem(name);
  if (SHORTAGES.some((x) => x.status !== 'resolved' && (x.code ? x.code === it?.code : x.name === name))) { $('shortMsg').textContent = 'الصنف ده موجود في النواقص.'; return; }
  await localInsert('shortages', { code: it?.code ?? null, name: it?.name ?? name, note: $('shortNote').value.trim() || null, status: 'active' });
  $('shortMsg').textContent = savedNote();
}

// ----- Market prices -----
function renderPrices(A) {
  if (!FEATURES_READY) return needUpdate();
  const cheapest = cheapestSeen(PRICES, TODAY);
  const cmp = priceCompare(A.rows, cheapest);
  const form = `<form id="priceForm" class="card stack">
      <h3>سجّل سعر شفته برا</h3>
      <p class="note">أسعار التجميل والمستلزمات حرة. سجّل السعر اللي شفته في صيدلية تانية أو موقع، وكل الشركاء هيشوفوه. البرنامج بياخد أرخص سعر في آخر 45 يوم.</p>
      <div class="grid2"><label>الصنف<input id="priceName" list="itemList" required placeholder="اختار من أصنافك"></label>
      <label>السعر (جنيه)<input id="priceVal" type="number" inputmode="decimal" min="0.01" step="0.01" required></label>
      <label>فين؟<input id="priceSrc" maxlength="80" placeholder="مثلاً: صيدلية العزبي، أو موقع"></label>
      <label>إمتى؟<input id="priceDate" type="date" value="${isoDay(TODAY)}" max="${isoDay(TODAY)}" required></label></div>
      <div class="row"><button class="btn primary" type="submit">احفظ السعر</button><span class="note" id="priceMsg" role="status"></span></div>
      ${itemOptions()}</form>`;
  const rows = cmp.map((r) => `<tr>${nameCell(r)}<td class="n">${fmt(r.price, 2)}</td><td class="n">${fmt(r.market, 2)}</td>
    <td class="muted">${esc(r.source || '—')} · <span class="n">${esc(String(r.seenOn).slice(0, 10))}</span></td>
    <td>${r.diff > 0.009 ? `<span class="pill warn">أغلى بـ <span class="n">${fmt(r.pct, 0)}%</span></span>` : r.diff < -0.009 ? '<span class="pill ok">أرخص</span>' : '<span class="pill ok">زيه</span>'}</td>
    <td><button class="btn" data-calc="${esc(r.code)}">احسب</button></td></tr>`);
  const recent = [...PRICES].sort((a, b) => String(b.seen_on).localeCompare(String(a.seen_on)) || String(b.created_at).localeCompare(String(a.created_at))).slice(0, 15);
  const names = new Map(DATA.items.map((i) => [i.code, i.name]));
  const hist = recent.map((p) => `<tr><td>${esc(names.get(p.code) || p.code)}${pendingPill(p)}</td><td class="n">${fmt(+p.price, 2)}</td><td class="muted">${esc(p.source || '—')}</td><td class="n">${esc(String(p.seen_on).slice(0, 10))}</td>
    <td>${isOwner() || p.created_by === SESS.user.id ? `<button class="btn" data-pricedel="${esc(p.id)}" aria-label="امسح">امسح</button>` : ''}</td></tr>`);
  return form
    + (rows.length ? `<h3>سعرك قصاد السوق</h3><div class="tablebox"><table><thead><tr><th>الصنف</th><th>سعرك</th><th>أرخص سعر برا</th><th>فين وإمتى</th><th></th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<div class="tablebox"><p class="empty">لسه مفيش أسعار متسجلة لأصنافك.</p></div>')
    + (hist.length ? `<details class="help"><summary>آخر الأسعار المتسجلة</summary><div class="tablebox" style="margin-top:8px"><table><tbody>${hist.join('')}</tbody></table></div></details>` : '')
    + '<p class="note">الأدوية ليها تسعيرة جبرية، فالمقارنة دي للتجميل والمستلزمات أساساً.</p>';
}
async function addPrice(row) {
  await localInsert('market_prices', row);
}
async function submitPrice(e) {
  e.preventDefault();
  const it = findItem($('priceName').value);
  if (!it) { $('priceMsg').textContent = 'اختار الصنف من أصنافك.'; return; }
  const price = Math.round((+$('priceVal').value || 0) * 100) / 100;
  if (!(price > 0)) { $('priceMsg').textContent = 'اكتب السعر.'; return; }
  await addPrice({ code: it.code, price, source: $('priceSrc').value.trim() || null, seen_on: $('priceDate').value || isoDay(TODAY) });
  $('priceMsg').textContent = savedNote();
}

// ----- Patient reminders (owner only) -----
function renderPatients() {
  if (!isOwner()) return '<p class="note">تذكير المرضى بيشوفه صاحب الصيدلية بس.</p>';
  if (!FEATURES_READY) return needUpdate();
  const pOpts = PATIENTS.filter((p) => p.active !== false).map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (…${esc(String(p.phone).slice(-4))})</option>`).join('');
  const next30 = isoDay(addDays(TODAY, 30));
  const form = `<form id="remForm" class="card stack">
    <h3>تذكير جديد على الواتساب</h3>
    <p class="note">البرنامج بيبعت للمريض رسالة في ميعاد الجرعة، أو قبل ما الدوا يخلص بيوم عشان يجدد من عندك.</p>
    <div class="grid2">
      <label>المريض<select id="remPatient"><option value="new">مريض جديد</option>${pOpts}</select></label>
      <span></span>
      <label class="newp">اسم المريض<input id="remName" maxlength="120" placeholder="مثلاً: أم محمد"></label>
      <label class="newp">رقم الواتساب<input id="remPhone" type="tel" inputmode="tel" placeholder="01xxxxxxxxx"></label>
      <label class="newp span2 checkline"><input id="remConsent" type="checkbox"> المريض وافق إنه يستقبل تذكير على الواتساب من الصيدلية</label>
      <label>الدوا<input id="remMed" maxlength="120" required list="itemList" placeholder="مثلاً: جلوكوفاج 1000"></label>
      <label>نوع التذكير<select id="remKind"><option value="dose">مواعيد الجرعات</option><option value="refill">تجديد الدوا قبل ما يخلص</option></select></label>
      <label class="kdose">مواعيد الجرعات<input id="remTimes" placeholder="مثلاً: 9 ص، 9 م"></label>
      <label class="krefill" hidden>العلبة بتكفي كام يوم<input id="remEvery" type="number" min="1" max="365" value="30"></label>
      <label class="krefill" hidden>هيخلص يوم<input id="remNext" type="date" value="${next30}" min="${isoDay(TODAY)}"></label>
    </div>
    <div class="row"><button class="btn primary" type="submit">احفظ التذكير</button><span class="note" id="remMsg" role="status"></span></div>
    ${itemOptions()}</form>`;
  const pName = new Map(PATIENTS.map((p) => [p.id, p.name]));
  const rows = [...REMINDERS].sort((a, b) => String(pName.get(a.patient_id)).localeCompare(String(pName.get(b.patient_id)), 'ar')).map((r) => `<tr class="${r.active === false ? 'off' : ''}">
    <td>${esc(pName.get(r.patient_id) || '—')}${pendingPill(r)}</td><td>${esc(r.medicine)}</td>
    <td>${r.kind === 'dose' ? `الجرعات: <span class="n">${esc((r.dose_times || []).join('، '))}</span>` : `تجديد كل ${fmt(r.refill_every_days)} يوم · الجاي <span class="n">${esc(r.next_refill)}</span>`}</td>
    <td class="muted">${r.last_sent_at ? new Date(r.last_sent_at).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'لسه'}</td>
    <td><button class="btn" data-remtoggle="${esc(r.id)}">${r.active === false ? 'شغّل' : 'وقّف'}</button> <button class="btn" data-remdel="${esc(r.id)}" aria-label="امسح">امسح</button></td></tr>`);
  const plist = PATIENTS.map((p) => `<li>${esc(p.name)} <span class="muted n">…${esc(String(p.phone).slice(-4))}</span> <button class="linkbtn" data-patdel="${esc(p.id)}">امسح المريض وتذكيراته</button></li>`).join('');
  return form
    + (rows.length ? `<div class="tablebox"><table><thead><tr><th>المريض</th><th>الدوا</th><th>التذكير</th><th>آخر رسالة</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<div class="tablebox"><p class="empty">لسه مفيش تذكيرات.</p></div>')
    + (PATIENTS.length ? `<details class="help"><summary>المرضى (${fmt(PATIENTS.length)})</summary><ul class="blist">${plist}</ul></details>` : '')
    + `<p class="note">بيانات المرضى بيشوفها صاحب الصيدلية بس، ومتتحفظش غير بموافقة المريض. الرسايل بتتبعت لما يتفعّل واتساب بيزنس للصيدلية (التفاصيل في README).</p>`;
}
function bindPatients() {
  const sync2 = () => {
    const isNew = $('remPatient').value === 'new';
    document.querySelectorAll('#remForm .newp').forEach((el) => { el.hidden = !isNew; });
    const dose = $('remKind').value === 'dose';
    document.querySelectorAll('#remForm .kdose').forEach((el) => { el.hidden = !dose; });
    document.querySelectorAll('#remForm .krefill').forEach((el) => { el.hidden = dose; });
  };
  $('remPatient').addEventListener('change', sync2);
  $('remKind').addEventListener('change', sync2);
  sync2();
}
async function addReminder(e) {
  e.preventDefault();
  const msg = (t) => { $('remMsg').textContent = t; };
  let patientId = $('remPatient').value;
  const kind = $('remKind').value;
  const medicine = $('remMed').value.trim();
  if (!medicine) return msg('اكتب اسم الدوا.');
  const row = { kind, medicine, active: true };
  if (kind === 'dose') {
    const times = parseTimes($('remTimes').value);
    if (!times.length) return msg('اكتب مواعيد الجرعات، مثلاً: 9 ص، 9 م');
    row.dose_times = times;
  } else {
    row.refill_every_days = Math.max(1, Math.min(365, Math.round(+$('remEvery').value || 30)));
    row.next_refill = $('remNext').value;
    if (!row.next_refill) return msg('اختار اليوم اللي الدوا هيخلص فيه.');
  }
  if (patientId === 'new') {
    const name = $('remName').value.trim();
    const phone = normalizeEgPhone($('remPhone').value);
    if (!name) return msg('اكتب اسم المريض.');
    if (!phone) return msg('رقم الواتساب لازم يبقى رقم موبايل مصري صحيح.');
    if (!$('remConsent').checked) return msg('لازم المريض يوافق الأول على استقبال الرسايل.');
    const existing = PATIENTS.find((p) => p.phone === phone);
    patientId = existing ? existing.id : (await localInsert('patients', { name, phone, consent: true, active: true })).id;
  }
  await localInsert('reminders', { ...row, patient_id: patientId });
  msg(savedNote());
}

// ---------- Offers & calculator ----------
function offerState(r, A) {
  if (!OFFERS.has(r.code)) OFFERS.set(r.code, { on: r.category !== 'دواء', price: suggestOffer(r, A) });
  return OFFERS.get(r.code);
}

function renderOffers(A, rows) {
  const body = rows.map((r) => {
    const o = offerState(r, A);
    const p = profitAt(o.price, r, A);
    const m = MARKET[r.code];
    const why = r.atRisk > 0 ? `<span class="pill ${r.expDays <= 30 ? 'crit' : 'warn'}">ينتهي بعد ${fmt(Math.max(0, r.expDays))} يوم</span>` : '<span class="pill warn">راكد</span>';
    return `<tr class="${o.on ? '' : 'off'}">
      <td><input type="checkbox" data-on="${esc(r.code)}" ${o.on ? 'checked' : ''} aria-label="ضمّن ${esc(r.name)}"></td>
      ${nameCell(r)}<td>${why}</td><td class="n">${fmt(r.price, 2)}</td>
      <td><input class="offer-in n" type="number" min="0" step="0.5" data-price="${esc(r.code)}" value="${o.price}"></td>
      <td><span class="pill ${p.net < 0 ? 'crit' : 'ok'}"><span class="n">${fmt(p.net, 2)}</span> ج</span></td>
      <td>${m ? `<span class="n">${fmt(m, 2)}</span>${o.price > m ? ' <span class="pill warn">أغلى</span>' : ''}` : '<span class="muted">—</span>'}</td></tr>`;
  });
  const t = body.length
    ? `<div class="tablebox"><table><thead><tr><th></th><th>الصنف</th><th>ليه</th><th>السعر الحالي</th><th>سعر العرض</th><th>مكسبك في العلبة</th><th>أرخص سعر برا</th></tr></thead><tbody>${body.join('')}</tbody></table></div>`
    : '<div class="tablebox"><p class="empty">مفيش أصناف محتاجة عروض دلوقتي.</p></div>';
  return `<p>الأصناف اللي قربت تنتهي أو راكدة، وجنب كل واحد سعر عرض مقترح. لو الصنف هينتهي خلال 30 يوم، العرض بيرجّعلك سعر الشراء على الأقل، لأن ده أحسن من إنه يضيع.</p>
  <p class="note">الأدوية مش متعلّم عليها من الأول: الإعلان عن الأدوية للجمهور محتاج موافقة هيئة الدواء، فالأفضل تعرض عليها جوه الصيدلية مش في رسايل.</p>
  ${t}
  <div class="card msg"><h3>رسالة العرض (جاهزة للواتساب)</h3><textarea id="offerMsg" aria-label="رسالة العرض"></textarea>
  <div class="row"><button class="btn primary" id="copyMsg">انسخ الرسالة</button><span class="note" id="copyNote"></span></div></div>`;
}

function bindOffers(rows) {
  const name = $('phName').value.trim() || SESS.pharmacy?.name || 'صيدليتنا';
  const lines = rows.filter((r) => OFFERS.get(r.code)?.on).map((r) => {
    const o = OFFERS.get(r.code);
    const pct = Math.round((1 - o.price / r.price) * 100);
    return `• ${r.name}: بدل ${fmt(r.price)} بـ ${fmt(o.price)} جنيه${pct > 0 ? ` (خصم ${pct}%)` : ''}`;
  });
  $('offerMsg').value = lines.length ? `عروض ${name} 🎁\n\n${lines.join('\n')}\n\nالعرض لحد ما الكمية تخلص. ابعتلنا هنا ونجهزلك طلبك.` : '';
  $('panel').querySelectorAll('[data-on]').forEach((el) => el.addEventListener('change', () => { OFFERS.get(el.dataset.on).on = el.checked; render(); }));
  $('panel').querySelectorAll('[data-price]').forEach((el) => el.addEventListener('change', () => { OFFERS.get(el.dataset.price).price = Math.max(0, +el.value || 0); render(); }));
  $('copyMsg').addEventListener('click', () => copyFrom($('offerMsg'), $('copyNote')));
}

function renderCalc(A, s) {
  const items = [...DATA.items].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  if (!CALC_CODE || !items.some((i) => i.code === CALC_CODE)) CALC_CODE = (items.find((i) => i.category === 'تجميل') || items[0]).code;
  const it = DATA.items.find((i) => i.code === CALC_CODE);
  const isMed = it.category === 'دواء';
  const lo = Math.floor(it.cost * 0.9), hi = Math.ceil(it.price * (isMed ? 1 : 1.25));
  return `<p>اختار صنف وحرّك السعر، والمكسب الصافي يتحسب بعد الضرايب والمصاريف.</p>
  <div class="calc">
    <div class="card">
      <label>الصنف<select id="calcItem">${items.map((i) => `<option value="${esc(i.code)}" ${i.code === CALC_CODE ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></label>
      <label><span>سعر البيع: <b id="pLbl" class="n"></b> ج</span>
        <input id="calcPrice" type="range" min="${lo}" max="${hi}" step="0.5" value="${it.price}">
      </label>
      <label>أرخص سعر شفته برا (اختياري)<input id="market" type="number" min="0" step="0.5" value="${MARKET[it.code] ?? ''}" placeholder="مثلاً ${fmt(it.price * 0.92)}"></label>
      <p class="note">السعر ده بيتحفظ على جهازك، ويظهر في العروض.</p>
      ${isMed ? '<p class="note">ده دواء ليه تسعيرة جبرية. مينفعش تبيع بأعلى من السعر المكتوب، والحاسبة دي تفيدك لو بتفكّر تعمل خصم.</p>' : '<p class="note">مستحضرات التجميل والمستلزمات أسعارها حرة، فتقدر تحرّك السعر زي ما إنت شايف.</p>'}
      <p class="note">${s.expenses > 0 ? `المصاريف ${fmt(s.expenses)} ج في الشهر${s.expensesRecorded ? ' (متوسط المصروفات اللي سجلتها في آخر 3 شهور)' : ' (من التقدير في الإعدادات)'}، يعني ${fmt(A.overheadRate * 100, 1)}% من المبيعات.` : 'مفيش مصاريف متسجلة، فالمكسب ده قبل الإيجار والكهربا والمرتبات. سجّلها من تبويب «المصروفات».'}</p>
    </div>
    <div class="card" id="calcOut"></div>
  </div>`;
}

function bindCalc(A, s) {
  const it = DATA.items.find((i) => i.code === CALC_CODE);
  const update = () => {
    const price = +$('calcPrice').value;
    $('pLbl').textContent = fmt(price, 2);
    const p = profitAt(price, it, A);
    const cls = p.net < 0 ? 'crit' : p.pct < s.target ? 'warn' : 'ok';
    const msg = p.net < 0 ? 'بالسعر ده إنت خسران.' : p.pct < s.target ? `كسبان، بس أقل من الـ ${fmt(s.target)}% اللي حاطتها هدف.` : 'السعر ده كويس.';
    const floor = targetFloor(it, A, s.target);
    const m = +$('market').value;
    let marketMsg = '';
    if (m > 0 && m - 1 > price) {
      marketMsg = `<div class="verdict ok">سعرك أصلاً أرخص من أرخص سعر برا (${fmt(m)} ج). ممكن ترفعه لحد ${fmt(m - 1)} ج وتكسب ${fmt(profitAt(m - 1, it, A).net, 2)} ج في العلبة وتفضل الأرخص.</div>`;
    } else if (m > 0) {
      const pm = profitAt(m - 1, it, A);
      marketMsg = pm.net < 0 ? `<div class="verdict crit">أرخص سعر برا ${fmt(m)} ج. لو نزلت تحته هتخسر، فمتنافسش في الصنف ده واكسب في حاجة تانية.</div>`
        : pm.pct < s.target ? `<div class="verdict warn">تقدر تبيع بـ ${fmt(m - 1)} ج (أقل من أرخص سعر بجنيه) وتكسب ${fmt(pm.net, 2)} ج، بس أقل من هدفك.</div>`
        : `<div class="verdict ok">تقدر تبيع بـ ${fmt(m - 1)} ج (أقل من أرخص سعر برا) وتفضل كسبان ${fmt(pm.net, 2)} ج في العلبة.</div>`;
    }
    const scen = [it.price, it.price * 0.95, it.price * 0.9, floor].filter((x, i, a) => x && a.indexOf(x) === i);
    $('calcOut').innerHTML = `
      <h3>${esc(it.name)}</h3>
      <div class="ledger">
        <div><span>سعر البيع</span><span class="n">${fmt(price, 2)}</span></div>
        <div><span>− سعر الشراء</span><span class="n">${fmt(it.cost, 2)}</span></div>
        <div><span>− الضرايب (${fmt(A.taxRate * 100, 2)}%)</span><span class="n">${fmt(p.tax, 2)}</span></div>
        <div><span>− نصيبها من المصاريف (${fmt(A.overheadRate * 100, 1)}%)</span><span class="n">${fmt(p.over, 2)}</span></div>
        <div class="tot"><span>مكسبك الصافي</span><span class="n">${fmt(p.net, 2)} (${fmt(p.pct, 1)}%)</span></div>
      </div>
      <div class="verdict ${cls}">${msg}</div>
      ${marketMsg}
      <div class="scen">${scen.map((x) => { const q = profitAt(x, it, A); return `<div class="${Math.abs(x - price) < 0.01 ? 'cur' : ''}"><span>لو بعت بـ <span class="n">${fmt(x, 2)}</span>${x === floor ? ' (أقل سعر يحقق هدفك)' : ''}</span><span class="n">${fmt(q.net, 2)} ج</span></div>`; }).join('')}</div>`;
  };
  $('calcItem').addEventListener('change', (e) => { CALC_CODE = e.target.value; render(); });
  $('calcPrice').addEventListener('input', update);
  $('market').addEventListener('input', update);
  $('market').addEventListener('change', () => { setMarket(it.code, +$('market').value); });
  update();
}

// ---------- Branches & data ----------
const snapKey = (k) => `snap:${SESS.pharmacy.id}:${k}`;
const prevKey = (k) => `snapPrev:${SESS.pharmacy.id}:${k}`;

function setView() {
  const parts = BRANCH === 'all' ? BRANCHES.map((b) => SNAP.get(key(b.id))?.data) : [SNAP.get(BRANCH)?.data];
  DATA = mergeBranches(parts.filter(Boolean)) || EMPTY();
  if (!DATA.items) DATA = EMPTY();
  const prevParts = (BRANCH === 'all' ? BRANCHES.map((b) => SNAP.get(key(b.id))?.prev?.data) : [SNAP.get(BRANCH)?.prev?.data]).filter(Boolean);
  PREV_DATA = prevParts.length ? mergeBranches(prevParts) : null;
  OFFERS.clear();
  const shown = BRANCH === 'all' ? BRANCHES.map((b) => SNAP.get(key(b.id))).filter(Boolean) : [SNAP.get(BRANCH)].filter(Boolean);
  if (!shown.length) { $('fileMsg').textContent = ''; return; }
  const latest = shown.reduce((a, b) => (a.at > b.at ? a : b));
  const when = new Date(latest.at).toLocaleString('ar-EG', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const missing = BRANCH === 'all' && multi() ? BRANCHES.filter((b) => !SNAP.has(key(b.id))).map((b) => b.name) : [];
  $('fileMsg').textContent = `${DATA.items.length} صنف · آخر تحديث: ${when}${latest.pending ? ' (مستني النت عشان يترفع)' : ''}${missing.length ? ` · لسه مفيش بيانات لـ: ${missing.join('، ')}` : ''}`;
}

async function loadSnapshots() {
  const online = isOnline();
  for (const b of BRANCHES) {
    const k = key(b.id);
    const cached = await kvGet(snapKey(k));
    const cachedPrev = await kvGet(prevKey(k));
    let fresh = null, freshPrev = null;
    if (online) {
      // The last two uploads: the newest is shown, the one before it shows what changed (prices).
      let q = SESS.client.from('snapshots').select('created_at, data').eq('pharmacy_id', SESS.pharmacy.id);
      if (b.id) q = q.eq('branch_id', b.id);
      const { data, error } = await q.order('created_at', { ascending: false }).limit(2);
      if (!error && data.length) fresh = { at: data[0].created_at, raw: data[0].data };
      if (!error && data.length > 1) freshPrev = { at: data[1].created_at, raw: data[1].data };
      if (error && !/fetch|network/i.test(error.message)) $('fileMsg').innerHTML = `<span class="err">${esc(arabicError(error).message)}</span>`;
    }
    // A local upload still waiting for the connection is newer than anything on the server.
    const local = cached && (cached.pending || !fresh || cached.at >= fresh.at);
    const use = local ? cached : fresh;
    if (!use) continue;
    const prev = local ? cachedPrev : freshPrev;
    SNAP.set(k, { at: use.at, pending: !!use.pending, data: fromExport(use.raw), ...(prev ? { prev: { at: prev.at, data: fromExport(prev.raw) } } : {}) });
    if (!local) { await kvSet(snapKey(k), { at: fresh.at, raw: fresh.raw }); await kvSet(prevKey(k), freshPrev); }
  }
}

function renderBranches() {
  const opts = (multi() ? [['all', 'كل الفروع']] : []).concat(BRANCHES.map((b) => [key(b.id), b.name]));
  if (!opts.some(([v]) => v === BRANCH)) BRANCH = opts[0][0];
  $('branchSel').innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}" ${v === BRANCH ? 'selected' : ''}>${esc(t)}</option>`).join('');
  $('branchWrap').hidden = !multi();
  $('tokenBranch').innerHTML = BRANCHES.map((b) => `<option value="${esc(key(b.id))}" ${key(b.id) === BRANCH ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  $('tokenBranch').closest('label').hidden = !multi();
  $('branchList').innerHTML = `<ul class="blist">${BRANCHES.map((b) => `<li>${esc(b.name)} <span class="muted">${SNAP.has(key(b.id)) ? `· ${fmt(SNAP.get(key(b.id)).data.items.length)} صنف` : '· لسه مفيش بيانات'}</span></li>`).join('')}</ul>`;
  $('branchForm').hidden = !isOwner() || !SESS.branchesReady;
  $('inviteBox').hidden = !isOwner();
  $('uploadBtn').hidden = !isOwner();
  $('uploadBtn').firstChild.textContent = multi() && BRANCH !== 'all' ? `ارفع بيانات «${branchName(BRANCH)}»` : 'ارفع البيانات';
  if (!SESS.branchesReady && isOwner()) $('branchMsg').textContent = 'إضافة فروع محتاجة تحديث قاعدة البيانات.';
}

// ---------- Connection status & sync ----------
async function updateNet(q) {
  q ??= await pending();
  const n = q.length;
  const on = isOnline();
  $('netChip').textContent = on ? (n ? `بيرفع ${n}…` : 'متصل') : `من غير نت${n ? ` · ${n} مستني يترفع` : ''}`;
  $('netChip').className = `chip ${on ? 'real' : ''}`;
}
async function sync() {
  if (SESS.mode !== 'member' || !isOnline()) return updateNet();
  let rejected = false;
  await flush(SESS.client, (entry, err) => {
    rejected = true;
    $('fileMsg').innerHTML = `<span class="err">ماترفعش ${entry.type === 'expense' ? 'مصروف' : entry.type === 'snapshot' ? 'ملف البيانات' : 'تعديل'}: ${esc(err.message)}</span>`;
    if (entry.type === 'expense') { EXPENSES = EXPENSES.filter((e) => e.id !== entry.payload.id); saveExpenseCache(); }
    if (entry.type === 'snapshot') { const k = key(entry.payload.p_branch ?? null); SNAP.delete(k); kvSet(snapKey(k), null); }
    if (entry.type === 'insert' && LISTS[entry.payload.table]) {
      const list = LISTS[entry.payload.table](); const i = list.findIndex((x) => x.id === entry.payload.row.id);
      if (i >= 0) list.splice(i, 1);
      kvSet(cacheKey(entry.payload.table), list);
    }
  });
  // Uploaded items are no longer pending.
  const q = await pending();
  const waiting = new Set(q.filter((e) => e.type === 'expense').map((e) => e.payload.id));
  let changed = false;
  for (const e of EXPENSES) if (e.pending && !waiting.has(e.id)) { e.pending = false; changed = true; }
  const waitingRows = new Set(q.filter((e) => e.type === 'insert').map((e) => e.payload.row.id));
  for (const [table, get] of Object.entries(LISTS)) {
    let touched = false;
    for (const r of get()) if (r.pending && !waitingRows.has(r.id)) { r.pending = false; touched = true; }
    if (touched) { changed = true; await kvSet(cacheKey(table), get()); }
  }
  for (const [k, s] of SNAP) {
    if (s.pending && !q.some((e) => e.type === 'snapshot' && key(e.payload.p_branch ?? null) === k)) {
      s.pending = false; changed = true;
      const c = await kvGet(snapKey(k)); if (c) await kvSet(snapKey(k), { ...c, pending: false });
    }
  }
  if (changed || rejected) {
    await saveExpenseCache();
    const msg = $('fileMsg').innerHTML;
    setView(); render();
    if (rejected) $('fileMsg').innerHTML = msg;
  }
  updateNet(q);
}
onOutboxChange((q) => updateNet(q));
addEventListener('online', sync);
addEventListener('offline', () => updateNet());

// ---------- Boot: sign-in first, then the dashboard ----------
function showGate() { $('gate').hidden = false; $('app').hidden = true; }
function showApp() { $('gate').hidden = true; $('app').hidden = false; }

async function boot() {
  showGate();
  try { SESS = await getSession(); } catch (err) { $('auth').innerHTML = `<p class="err">${esc(err.message)}</p><button class="btn" onclick="location.reload()">جرّب تاني</button>`; return; }
  if (SESS.mode === 'local') { $('auth').innerHTML = '<h2>البرنامج مش متوصل بقاعدة البيانات</h2><p class="note">لازم يتضاف <code>SUPABASE_URL</code> و<code>SUPABASE_PUBLISHABLE_KEY</code> في إعدادات Vercel، وبعدها تقدر تسجّل دخول.</p>'; return; }
  if (SESS.mode === 'signed-out') return renderSignIn($('auth'), boot);
  if (SESS.mode === 'no-pharmacy') return renderPharmacyChoice($('auth'), boot);

  showApp();
  $('phTitle').textContent = SESS.pharmacy.name;
  $('whoLine').textContent = `${SESS.user.email} · ${ROLE_LABEL[SESS.role]}`;
  if (SESS.role === 'device') {
    document.querySelectorAll('#app > *:not(header)').forEach((el) => { el.hidden = true; });
    const box = document.createElement('section'); box.className = 'card';
    box.innerHTML = '<p>الحساب ده لجهاز الصيدلية: الكاشير وتسجيل الحضور.</p><div class="row"><a class="btn primary" href="./cashier.html">افتح الكاشير</a><a class="btn" href="./attendance.html">شاشة الحضور</a></div>';
    $('app').append(box);
    return;
  }
  BRANCHES = SESS.branchesReady && SESS.branches.length ? SESS.branches.map(({ id, name }) => ({ id, name })) : [{ id: null, name: 'الفرع الرئيسي' }];
  BRANCH = store.get('saydaliti-branch-v1', 'all');

  const saved = store.get(SKEY, {});
  const st = { ...saved, ...(SESS.pharmacy.settings || {}) };
  fields.forEach((f) => { if (st[f] !== undefined) $(f).value = st[f]; });
  if (!isOwner()) {
    fields.forEach((f) => { $(f).disabled = true; });
    $('settingsMsg').textContent = `الإعدادات بيحددها صاحب الصيدلية. إنت داخل كـ${ROLE_LABEL[SESS.role]}.`;
  }
  $('connectorBox').hidden = !isOwner();
  $('toCashier').hidden = !isOwner();
  if (SESS.offline) $('fileMsg').textContent = 'إنت من غير نت. بتشوف آخر بيانات اتحفظت على الجهاز.';

  renderBranches();
  render();
  await Promise.all([loadSnapshots(), loadExpenses(), loadFeatures()]);
  renderBranches(); setView(); render();
  sync();
}

// ---------- Events ----------
$('panel').addEventListener('change', (e) => {
  if (e.target.id === 'periodSel') { PERIOD = e.target.value; render(); }
  if (e.target.id === 'expPeriodSel') { EXP_PERIOD = e.target.value; render(); }
  if (e.target.id === 'posPeriodSel') { POS_PERIOD = e.target.value; render(); }
  if (e.target.matches('select[data-supfor]')) chooseSupplier(e.target.dataset.supfor, e.target.value);
});
$('panel').addEventListener('toggle', (e) => { if (e.target.id === 'supBox') SUP_OPEN = e.target.open; }, true);
$('panel').addEventListener('submit', (e) => {
  if (e.target.id === 'expForm') addExpense(e);
  if (e.target.id === 'shortForm') addShortage(e);
  if (e.target.id === 'priceForm') submitPrice(e);
  if (e.target.id === 'remForm') addReminder(e);
  if (e.target.id === 'supForm') saveSupplier(e);
});
$('panel').addEventListener('click', (e) => {
  const c = e.target.closest('[data-calc]'); if (c) { CALC_CODE = c.dataset.calc; TAB = 'calc'; render(); }
  const d = e.target.closest('[data-delexp]'); if (d) deleteExpense(d.dataset.delexp);
  const ed = e.target.closest('[data-editexp]'); if (ed) { EDIT_EXP = ed.dataset.editexp; render(); $('expForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  if (e.target.id === 'expCancel') { EDIT_EXP = null; render(); }
  if (e.target.id === 'addFixed') addFixedExpenses();
  const es = e.target.closest('[data-editsup]'); if (es) { EDIT_SUP = es.dataset.editsup; render(); $('supForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  const ds = e.target.closest('[data-delsup]'); if (ds) deleteSupplier(ds.dataset.delsup);
  if (e.target.id === 'supCancel') { EDIT_SUP = null; render(); }
  const wa = e.target.closest('[data-wa]');
  if (wa) {
    const text = $(`orderMsg${wa.dataset.wa}`).value;
    window.open(`https://wa.me/${wa.dataset.phone}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }
  const co = e.target.closest('[data-copyorder]'); if (co) copyFrom($(`orderMsg${co.dataset.copyorder}`), $(`orderNote${co.dataset.copyorder}`));
  const t = (k) => e.target.closest(`[data-${k}]`)?.dataset[k];
  if (t('shortok')) localUpdate('shortages', t('shortok'), { status: 'resolved', resolved_at: new Date().toISOString() });
  if (t('shortdel') && confirm('تمسح الصنف ده من النواقص؟')) localDelete('shortages', t('shortdel'));
  if (t('pricedel') && confirm('تمسح السعر ده؟')) localDelete('market_prices', t('pricedel'));
  if (t('remtoggle')) { const r = REMINDERS.find((x) => x.id === t('remtoggle')); if (r) localUpdate('reminders', r.id, { active: r.active === false }); }
  if (t('remdel') && confirm('تمسح التذكير ده؟')) localDelete('reminders', t('remdel'));
  if (t('patdel') && confirm('تمسح المريض ده وكل تذكيراته؟')) localDelete('patients', t('patdel'));
  if (e.target.id === 'copyMorning') copyFrom($('morningMsg'), $('copyMorningNote'));
});
$('ownerSel').addEventListener('change', (e) => { OWNER = e.target.value; render(); });
$('branchSel').addEventListener('change', (e) => { BRANCH = e.target.value; store.set('saydaliti-branch-v1', BRANCH); renderBranches(); setView(); render(); });
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) { TAB = b.dataset.tab; render(); } });
$('sections').addEventListener('click', (e) => {
  const b = e.target.closest('.sec'); if (!b) return;
  const sec = SECTIONS.find(([id]) => id === b.dataset.sec);
  TAB = LAST_TAB[sec[0]] ?? sec[2][0][0];
  render();
});
$('logout').addEventListener('click', async () => {
  if (SESS.mode === 'member' && isOnline()) await sync();
  const left = (await pending()).length + (await stuck()).length;
  const warn = left
    ? `فيه ${left} حاجة لسه ماترفعتش (مستنية النت). لو خرجت دلوقتي هتضيع. تخرج برضه؟`
    : 'الخروج هيمسح بيانات الصيدلية المحفوظة على الجهاز ده، وهتنزل تاني لما تدخل. تخرج؟';
  if (!confirm(warn)) return;
  await signOut();
  location.reload();
});

// Invite codes (partners see the numbers only; the pharmacy device only records attendance).
let INVITE = null;
$('inviteBox').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-invite]'); if (!b) return;
  const role = b.dataset.invite;
  if (!isOnline()) { $('branchMsg').textContent = 'كود الدعوة محتاج نت.'; return; }
  $('branchMsg').textContent = 'لحظة…';
  const { data, error } = await SESS.client.rpc('create_invite', { p_pharmacy: SESS.pharmacy.id, p_role: role });
  if (error) { $('branchMsg').textContent = arabicError(error).message; return; }
  $('branchMsg').textContent = '';
  INVITE = { code: data, role };
  $('inviteText').innerHTML = `الكود: <b class="n" style="font-size:1.2rem">${esc(data)}</b> (${role === 'device' ? 'لجهاز الصيدلية' : 'لشريك'})`;
  $('inviteOut').hidden = false;
});
$('inviteShare').addEventListener('click', () => {
  if (!INVITE) return;
  const site = location.origin + location.pathname;
  const text = `اتفضل كود الدخول على «صيدليتي» لـ${SESS.pharmacy.name}: ${INVITE.code}\nافتح ${site} واعمل حساب بإيميلك، وبعدين اكتب الكود. الكود بيشتغل مرة واحدة لمدة 7 أيام.`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
});

$('branchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('branchName').value.trim();
  if (!name) { $('branchMsg').textContent = 'اكتب اسم الفرع.'; return; }
  if (!isOnline()) { $('branchMsg').textContent = 'إضافة فرع محتاجة نت.'; return; }
  const { data, error } = await SESS.client.rpc('add_branch', { p_pharmacy: SESS.pharmacy.id, p_name: name });
  if (error) { $('branchMsg').textContent = arabicError(error).message; return; }
  BRANCHES.push({ id: data, name });
  $('branchName').value = '';
  $('branchMsg').textContent = `اتضاف «${name}». اختاره من فوق وارفع بياناته، أو اعمله كود وصلة.`;
  renderBranches(); render();
});

let saveTimer = null;
fields.forEach((f) => $(f).addEventListener('input', () => {
  const values = Object.fromEntries(fields.map((x) => [x, $(x).value]));
  store.set(SKEY, values);
  render();
  if (!isOwner()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveShared(values);
    $('settingsMsg').textContent = isOnline() ? 'الإعدادات اتحفظت، والشركاء هيشوفوها.' : 'اتحفظت على الجهاز، وهتترفع أول ما النت يرجع.';
  }, 800);
}));

$('file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  if (multi() && BRANCH === 'all') { $('fileMsg').innerHTML = '<span class="err">اختار الفرع من فوق الأول، وبعدين ارفع بياناته.</span>'; return; }
  $('fileMsg').textContent = 'بقرا الملفات…';
  try {
    const data = await readFiles(files);
    const k = BRANCH === 'all' ? key(BRANCHES[0].id) : BRANCH;
    const raw = toExport(data);
    const at = new Date().toISOString();
    const before = await kvGet(snapKey(k));
    if (before) await kvSet(prevKey(k), { at: before.at, raw: before.raw });
    const old = SNAP.get(k);
    SNAP.set(k, { at, pending: true, data: fromExport(raw), ...(old ? { prev: { at: old.at, data: old.data } } : {}) });
    await kvSet(snapKey(k), { at, raw, pending: true });
    const bid = BRANCHES.find((b) => key(b.id) === k)?.id;
    await enqueue('snapshot', { p_pharmacy: SESS.pharmacy.id, p_data: raw, ...(bid ? { p_branch: bid } : {}) });
    setView(); renderBranches(); render();
    if (!data.sales.length) $('fileMsg').innerHTML = '<span class="err">اتقرت الأصناف، بس ملقتش مبيعات، فالطلبيات والراكد مش هيطلعوا صح. ارفع ملف المبيعات كمان.</span>';
    else $('fileMsg').textContent = isOnline() ? 'اتقرت وبتتحفظ… الشركاء هيشوفوا نفس الأرقام.' : 'اتقرت واتحفظت على الجهاز، وهتترفع أول ما النت يرجع.';
    await sync();
    if (data.sales.length && isOnline() && !SNAP.get(k)?.pending) $('fileMsg').textContent = `اتحفظت${multi() ? ` في «${branchName(k)}»` : ''} (${data.items.length} صنف). الشركاء هيشوفوا نفس الأرقام.`;
  } catch (err) {
    $('fileMsg').innerHTML = `<span class="err">${esc(err.message)}</span>`;
  }
});

function copyFrom(textarea, note) {
  const fallback = () => { textarea.select(); note.textContent = 'حدّدتلك النص، انسخه من القائمة.'; };
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(textarea.value).then(() => { note.textContent = 'اتنسخ.'; }, fallback);
}
$('tokenBtn').addEventListener('click', async () => {
  if (!isOnline()) { $('tokenMsg').textContent = 'الكود محتاج نت.'; return; }
  $('tokenMsg').textContent = 'لحظة…';
  const k = $('tokenBranch').value || key(BRANCHES[0].id);
  const bid = BRANCHES.find((b) => key(b.id) === k)?.id;
  const { data, error } = await SESS.client.rpc('create_connector_token', { p_pharmacy: SESS.pharmacy.id, ...(bid ? { p_branch: bid } : {}) });
  if (error) { $('tokenMsg').textContent = arabicError(error).message; return; }
  $('tokenMsg').textContent = `اتعمل كود جديد${multi() ? ` لـ«${branchName(k)}»` : ''}، وأي كود قديم للفرع ده بطل.`;
  $('tokenJson').value = JSON.stringify({ supabaseUrl: SESS.config.url, publishableKey: SESS.config.key, token: data,
    server: '.\\SQLEXPRESS', database: 'SaydalitiCopy', sqlUser: '', sqlPassword: '' }, null, 2);
  $('tokenOut').hidden = false;
});
$('copyToken').addEventListener('click', () => copyFrom($('tokenJson'), $('copyTokenMsg')));
$('copyMap').addEventListener('click', () => copyFrom($('mapJson'), $('copyMapMsg')));
$('schemaFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const { mapping, summary, notes } = suggestMapping(JSON.parse((await f.text()).replace(/^﻿/, '')));
    const label = { items: 'الأصناف', batches: 'التشغيلات والصلاحية', sales: 'المبيعات' };
    const cls = (c) => (c === 'متأكد' ? 'ok' : c === 'ملقتش' ? 'crit' : 'warn');
    $('mapSummary').innerHTML = `<div class="row">${Object.entries(summary).map(([k, v]) => `<span class="pill ${cls(v.confidence)}">${label[k]}: ${esc(v.table ?? '—')} · ${esc(v.confidence)}</span>`).join('')}</div>
      ${notes.length ? `<ul>${notes.map((n) => `<li class="note">${esc(n)}</li>`).join('')}</ul>` : ''}`;
    $('mapJson').value = JSON.stringify(mapping, null, 2);
    $('mapOut').hidden = false; $('mapOut').closest('details').open = true;
  } catch { $('mapSummary').innerHTML = '<p class="err">الملف ده مش schema.json صحيح.</p>'; $('mapOut').hidden = false; }
  e.target.value = '';
});

// Install as an app (Android / desktop Chrome). iPhone: Share → Add to Home Screen.
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('installBtn').hidden = false; });
$('installBtn').addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('installBtn').hidden = true; });
addEventListener('appinstalled', () => { $('installBtn').hidden = true; });

registerServiceWorker();
updateNet();
boot();
