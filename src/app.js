import { analyze, profitAt, targetFloor, suggestOffer, parseSheet, startOfDay, addDays, partnerSummary, ownersOf, ledger, fromExport, toExport, settingsFromSaved } from './core.js';
import { mergeBranches, expenseTotals, monthlyFromRecorded, EXPENSE_KINDS, kindLabel } from './branches-expenses.js';
import { pickSupplier, ordersBySupplier, orderMessage, priceChanges, recurringSuggestions, itemKind } from './ordering.js';
import { getSession, signOut, renderSignIn, renderPharmacyChoice, ROLE_LABEL, rememberSettings } from './session.js';
import { arabicError } from './supabase-store.js';
import { morningReport } from './report.js';
import { suggestMapping } from './mapping.js';
import { shortagePlan, cheapestSeen, priceCompare, parseTimes } from './features.js';
import { normalizeEgPhone } from './report.js';
import { kvGet, kvSet, enqueue, flush, pending, stuck, onOutboxChange, isOnline, registerServiceWorker, clearLocal } from './offline.js';
import { daySummary, PAYMENTS, normalize, lookup } from './pos.js';
import { CUSTOMER_KINDS, customerBalances, statement, claims, profitByPeriod } from './accounts.js';
import { liveData, purchaseTotal, supplierBalances, newItemCode, MOVE_KINDS, moveLabel, countDifferences, expiredOnShelf } from './inventory.js';

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
  ['stock', 'المخزون', [['items', 'كل الأصناف'], ['adjust', 'جرد وتالف'], ['reorder', 'اطلب إيه'], ['expiry', 'قرب ينتهي'], ['dead', 'راكد'], ['shortages', 'نواقص السوق'], ['movers', 'الأكتر سحباً'], ['morning', 'تقرير الصبح']]],
  ['buy', 'المشتريات', [['receive', 'طلبية وصلت'], ['invoices', 'فواتير الشراء'], ['supaccounts', 'حسابات الموردين']]],
  ['customers', 'العملاء', [['customers', 'حسابات العملاء'], ['claims', 'مطالبات التأمين']]],
  ['money', 'الفلوس', [['profit', 'الأرباح'], ['pos', 'مبيعات الكاشير'], ['expenses', 'المصروفات'], ['books', 'الحسابات'], ['partners', 'الشركاء'], ['calc', 'حاسبة المكسب']]],
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
  if (TAB === 'items') html = renderItems();
  else if (TAB === 'adjust') html = renderAdjust();
  else if (TAB === 'customers') html = renderCustomers();
  else if (TAB === 'claims') html = renderClaims();
  else if (TAB === 'profit') html = renderProfit();
  else if (TAB === 'receive') html = renderReceive();
  else if (TAB === 'invoices') html = renderInvoices();
  else if (TAB === 'supaccounts') html = renderSupplierAccounts();
  else if (TAB === 'expenses') html = renderExpenses();
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
  if (TAB === 'receive' && $('rcvForm')) receiveTotals();
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
const LISTS = { shortages: () => SHORTAGES, market_prices: () => PRICES, patients: () => PATIENTS, reminders: () => REMINDERS, pos_sales: () => POS_SALES,
  customers: () => CUSTOMERS, customer_payments: () => CUST_PAYMENTS,
  catalog_items: () => CATALOG, purchases: () => PURCHASES, supplier_payments: () => SUP_PAYMENTS, stock_moves: () => MOVES };
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
    // The server sends at most 1000 rows at a time: read page by page (stock needs every row).
    let all = [], error = null;
    for (let from = 0; from < 50000; from += 1000) {
      const res = await SESS.client.from(table).select(cols).eq('pharmacy_id', SESS.pharmacy.id).order(order, { ascending: false }).range(from, from + 999);
      if (res.error) { error = res.error; break; }
      all.push(...res.data);
      if (res.data.length < 1000) break;
    }
    if (error && !/fetch|network/i.test(error.message)) throw Object.assign(new Error(error.message), { missing: true });
    if (!error) rows = all;
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
    // Customer columns arrived with 011; an older database is read without them.
    try { POS_SALES = await loadTable('pos_sales', 'id, branch_id, number, sold_at, kind, lines, total, discount, paid, payment, customer_id, credit, claim_no', 'sold_at'); POS_READY = true; } catch (e) {
      try { POS_SALES = await loadTable('pos_sales', 'id, branch_id, number, sold_at, kind, lines, total, discount, paid, payment', 'sold_at'); POS_READY = true; } catch (e2) { if (e2.missing) POS_READY = false; }
    }
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
  refreshDerived(); if (STOCK_TABLES.has(table)) setView(); render(); sync();
  return full;
}
async function localUpdate(table, id, patch) {
  const r = LISTS[table]().find((x) => x.id === id);
  if (r) Object.assign(r, patch);
  await kvSet(cacheKey(table), LISTS[table]());
  await enqueue('update', { table, id, patch });
  refreshDerived(); if (STOCK_TABLES.has(table)) setView(); render(); sync();
}
async function localDelete(table, id) {
  const list = LISTS[table]();
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
  if (table === 'patients') REMINDERS = REMINDERS.filter((r) => r.patient_id !== id); // the database removes them too
  await kvSet(cacheKey(table), list);
  if (table === 'patients') await kvSet(cacheKey('reminders'), REMINDERS);
  await enqueue('delete', { table, id });
  refreshDerived(); if (STOCK_TABLES.has(table)) setView(); render(); sync();
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

// ---------- Stock kept here: all items, received orders, supplier accounts (migration 010) ----------
let CATALOG = [], PURCHASES = [], SUP_PAYMENTS = [], MOVES = [], LEARNED = [];
let INV_READY = true;
const STOCK_TABLES = new Set(['catalog_items', 'purchases', 'stock_moves', 'pos_sales']);
const needInv = () => '<div class="card emptybox"><h3>الجزء ده محتاج تحديث قاعدة البيانات</h3><p>التحديث <code>010</code> بيضيف الأصناف والطلبيات وحسابات الموردين. بعد ما يتطبق، الصفحة دي هتشتغل على طول.</p></div>';
const CATEGORIES = ['دواء', 'تجميل', 'مستلزمات', 'غير محدد'];
const mainBranchId = () => BRANCHES[0]?.id ?? null;
const inBranch = (b) => (r) => (r.branch_id ?? mainBranchId()) === (b?.id ?? null);
const branchOfView = () => (BRANCH === 'all' ? mainBranchId() : BRANCH_ID());
// Barcode → item code: barcodes saved on items here, and the ones the cashier learned.
const barcodeMap = () => new Map([...LEARNED.map((r) => [r.barcode, r.code]), ...CATALOG.filter((c) => c.barcode).map((c) => [c.barcode, c.code])]);
const dayText = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const expText = (d) => (d ? d.toLocaleDateString('ar-EG', { month: 'short', year: 'numeric' }) : '—');

async function loadInventory() {
  try {
    [CATALOG, PURCHASES, MOVES] = await Promise.all([
      loadTable('catalog_items', 'id, code, name, category, price, cost, barcode, created_at, updated_at'),
      loadTable('purchases', 'id, branch_id, supplier_id, supplier_name, invoice_no, received_on, lines, total, paid, note, created_at', 'received_on'),
      loadTable('stock_moves', 'id, branch_id, code, qty, kind, expiry, cost, ref, note, happened_at, created_at', 'happened_at'),
    ]);
    SUP_PAYMENTS = SESS.role === 'device' ? [] : await loadTable('supplier_payments', 'id, supplier_id, supplier_name, paid_on, amount, note, created_at', 'paid_on');
    INV_READY = true;
  } catch (e) { if (e.missing) INV_READY = false; }
  try { LEARNED = await loadTable('pos_barcodes', 'id, barcode, code, created_at'); } catch { /* 009 not applied */ }
}

// ----- All items -----
let ITEMS_Q = '';
let ITEM_FORM = null;
let ITEM_NOTE = ''; // null, or { code?, name, barcode, category, cost, price, forReceive }

function itemMatches(q) {
  const n = normalize(q);
  const bc = barcodeMap();
  const list = !n ? DATA.items : DATA.items.filter((i) => {
    if (String(i.code) === q.trim() || bc.get(q.trim()) === i.code) return true;
    const name = normalize(i.name);
    return n.split(' ').every((w) => name.includes(w)) || String(i.code).startsWith(q.trim());
  });
  return [...list].sort((a, b) => (b.qty > 0) - (a.qty > 0) || a.name.localeCompare(b.name, 'ar'));
}
function itemsRows() {
  const list = itemMatches(ITEMS_Q);
  const rows = list.slice(0, 150).map((i) => `<tr><td class="name">${esc(i.name)}<span class="cat">${esc(i.category)} · <span class="n">${esc(i.code)}</span></span></td>
    <td class="n">${i.qty < 0 ? `<span class="pill crit">${fmt(i.qty)}</span>` : i.qty === 0 ? '<span class="muted">خلصان</span>' : `<b>${fmt(i.qty)}</b>`}</td>
    <td class="n">${fmt(i.cost, 2)}</td><td class="n">${fmt(i.price, 2)}</td><td>${expText(i.expiry)}</td>
    ${isOwner() ? `<td><button class="btn" type="button" data-edititem="${esc(i.code)}">عدّل</button></td>` : ''}</tr>`);
  const more = list.length > 150 ? `<tr><td colspan="6" class="muted">ظاهر أول 150 من ${fmt(list.length)}. اكتب أكتر عشان تلاقي الصنف.</td></tr>` : '';
  return rows.join('') + more || `<tr><td colspan="6" class="empty">${ITEMS_Q ? 'مفيش صنف بالاسم ده.' : 'لسه مفيش أصناف.'}</td></tr>`;
}
function itemForm() {
  const f = ITEM_FORM;
  const editing = !!f.code;
  return `<form id="itemForm" class="card stack">
    <h3>${editing ? `عدّل «${esc(f.name)}»` : 'صنف جديد'}</h3>
    <div class="grid2">
      <label>اسم الصنف<input id="itName" maxlength="160" required value="${esc(f.name || '')}" placeholder="مثلاً: بانادول إكسترا 24 قرص"></label>
      <label>الباركود (اختياري: امسحه بالقارئ)<input id="itBarcode" maxlength="64" inputmode="numeric" value="${esc(f.barcode || '')}"></label>
      <label>النوع<select id="itCat">${CATEGORIES.map((c) => `<option ${c === (f.category || 'دواء') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label>سعر البيع للجمهور<input id="itPrice" type="number" min="0" step="0.25" inputmode="decimal" value="${esc(f.price ?? '')}" required></label>
      <label>سعر الشراء (اختياري)<input id="itCost" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(f.cost ?? '')}"></label>
      ${editing || f.forReceive ? '' : `<label>الكمية اللي عندك دلوقتي (اختياري)<input id="itQty" type="number" min="0" step="1" inputmode="numeric"></label>
      <label>الصلاحية (اختياري)<input id="itExp" type="month"></label>`}
    </div>
    <div class="row"><button class="btn primary" type="submit">${editing ? 'احفظ' : f.forReceive ? 'ضيفه وكمّل الطلبية' : 'ضيف الصنف'}</button><button class="btn" type="button" id="itemCancel">إلغاء</button><span class="note" id="itemMsg" role="status"></span></div>
  </form>`;
}
function renderItems() {
  if (!INV_READY) return needInv();
  return `<p>كل أصناف الصيدلية، حتى اللي رصيدها صفر. الرصيد = آخر ملف اترفع + الطلبيات اللي وصلت − مبيعات الكاشير.</p>
    <div class="row"><input id="itemsQ" type="search" autocomplete="off" placeholder="دوّر بالاسم أو الكود أو الباركود…" value="${esc(ITEMS_Q)}" style="flex:1;min-width:0" aria-label="دوّر على صنف">
      ${isOwner() ? '<button class="btn primary" type="button" id="newItemBtn">+ صنف جديد</button>' : ''}</div>
    ${ITEM_NOTE ? `<p class="note" role="status">${esc(ITEM_NOTE)}</p>` : ''}
    ${ITEM_FORM && !ITEM_FORM.forReceive ? itemForm() : ''}
    <div class="tablebox"><table><thead><tr><th>الصنف</th><th>الرصيد</th><th>سعر الشراء</th><th>سعر البيع</th><th>أقرب صلاحية</th>${isOwner() ? '<th></th>' : ''}</tr></thead><tbody id="itemsBody">${itemsRows()}</tbody></table></div>`;
}

async function saveItem(e) {
  e.preventDefault();
  const f = ITEM_FORM;
  const msg = (t) => { $('itemMsg').textContent = t; };
  const name = $('itName').value.trim();
  const barcode = $('itBarcode').value.trim();
  const price = +$('itPrice').value;
  const cost = $('itCost').value === '' ? null : +$('itCost').value;
  if (!name) return msg('اكتب اسم الصنف.');
  if (!(price >= 0) || $('itPrice').value === '') return msg('اكتب سعر البيع.');
  const owner = barcode && barcodeMap().get(barcode);
  if (barcode && owner && owner !== f.code) return msg(`الباركود ده متسجل لـ«${DATA.items.find((i) => i.code === owner)?.name ?? owner}».`);
  if (!f.code && DATA.items.some((i) => i.name.trim() === name)) return msg('فيه صنف بنفس الاسم. دوّر عليه وعدّله بدل ما تضيفه تاني.');
  const fields = { name, category: $('itCat').value, price, ...(cost !== null ? { cost } : {}), barcode: barcode || null };
  const qty = +($('itQty')?.value || 0), exp = $('itExp')?.value;
  ITEM_FORM = null;
  let code = f.code;
  if (code) {
    const row = CATALOG.find((c) => c.code === code);
    if (row) await localUpdate('catalog_items', row.id, { ...fields, updated_at: new Date().toISOString() });
    else await localInsert('catalog_items', { code, ...fields });
  } else {
    code = newItemCode(barcode, new Set(DATA.items.map((i) => i.code)));
    await localInsert('catalog_items', { code, ...fields });
    if (qty > 0) await localInsert('stock_moves', { code, qty, kind: 'count', branch_id: branchOfView(), expiry: exp ? `${exp}-01` : null, happened_at: new Date().toISOString(), note: 'رصيد أول مدة' });
  }
  if (f.forReceive) { addReceiveLine(DATA.items.find((i) => i.code === code)); return; }
  ITEM_NOTE = `${f.code ? 'اتحفظ التعديل.' : `اتضاف «${name}».`}${isOnline() ? '' : ' هيترفع أول ما النت يرجع.'}`;
  render();
}

// ----- A delivery arrived (purchase invoice) -----
const RKEY = 'saydaliti-receive-draft-v1';
const blankReceive = () => ({ supplier: '', supplierName: '', invoice: '', date: isoDay(TODAY), branch: BRANCH === 'all' ? key(mainBranchId()) : BRANCH, lines: [], paid: '', note: '' });
let RCV = store.get(RKEY, null) || blankReceive();
let RCV_NOTE = ''; // result of the last save, kept across re-renders
const saveDraft = () => store.set(RKEY, RCV);

function receiveLinesHtml() {
  return RCV.lines.map((l, i) => `<tr><td class="name">${esc(l.name)}<span class="cat n">${esc(l.code)}</span></td>
    <td><input class="disc n" type="number" min="0" step="1" data-l="${i}" data-f="qty" value="${esc(l.qty)}" aria-label="الكمية"></td>
    <td><input class="disc n" type="number" min="0" step="1" data-l="${i}" data-f="bonus" value="${esc(l.bonus)}" aria-label="بونص"></td>
    <td><input class="disc n" type="number" min="0" step="0.01" data-l="${i}" data-f="cost" value="${esc(l.cost)}" aria-label="سعر الشراء"></td>
    <td><input class="disc n" type="number" min="0" step="0.25" data-l="${i}" data-f="price" value="${esc(l.price)}" aria-label="سعر البيع"></td>
    <td><input type="month" data-l="${i}" data-f="expiry" value="${esc(l.expiry)}" aria-label="الصلاحية" style="min-width:130px"></td>
    <td class="n" id="rl${i}">${fmt((+l.qty || 0) * (+l.cost || 0), 2)}</td>
    <td><button class="btn" type="button" data-rcvdel="${i}" aria-label="شيل السطر">✕</button></td></tr>`).join('');
}
function receiveTotals() {
  const total = purchaseTotal(RCV.lines);
  if ($('rcvTotal')) $('rcvTotal').textContent = fmt(total, 2);
  const paid = +RCV.paid || 0;
  if ($('rcvDue')) $('rcvDue').textContent = fmt(Math.max(0, total - paid), 2);
  RCV.lines.forEach((l, i) => { const c = $(`rl${i}`); if (c) c.textContent = fmt((+l.qty || 0) * (+l.cost || 0), 2); });
}
function renderReceive() {
  if (!INV_READY) return needInv();
  if (!isOwner()) return '<div class="card emptybox"><h3>تسجيل الطلبيات لصاحب الصيدلية</h3><p>تقدر تشوف الفواتير المتسجلة في تبويب «فواتير الشراء».</p></div>';
  const sup = SUPPLIERS();
  return `<p>وصلت طلبية؟ اختار المورد، وامسح باركود كل صنف أو اكتب اسمه، واكتب الكمية والبونص وسعر الشراء والصلاحية. أول ما تسجّلها، الرصيد بيزيد وبتتحسب على المورد.</p>
  ${ITEM_FORM?.forReceive ? itemForm() : ''}
  <form id="rcvForm" class="card stack" novalidate>
    <div class="grid2">
      <label>المورد<select id="rcvSup">${`<option value="">— اختار المورد —</option>${sup.map((x) => `<option value="${esc(x.id)}" ${x.id === RCV.supplier ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}<option value="__new" ${RCV.supplier === '__new' ? 'selected' : ''}>مورد مش في القايمة…</option>`}</select></label>
      <label ${RCV.supplier === '__new' ? '' : 'hidden'} id="rcvSupNameWrap">اسم المورد الجديد<input id="rcvSupName" maxlength="80" value="${esc(RCV.supplierName)}"></label>
      <label>رقم فاتورة المورد (اختياري)<input id="rcvNo" maxlength="60" value="${esc(RCV.invoice)}"></label>
      <label>اتاستلمت يوم<input id="rcvDate" type="date" max="${isoDay(TODAY)}" value="${esc(RCV.date)}"></label>
      ${multi() ? `<label>الفرع اللي استلم<select id="rcvBranch">${BRANCHES.map((b) => `<option value="${esc(key(b.id))}" ${key(b.id) === RCV.branch ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>` : ''}
    </div>
    <div class="pos-search"><input id="rcvQ" type="search" autocomplete="off" placeholder="امسح باركود الصنف أو اكتب اسمه… (Enter)" aria-label="ضيف صنف للطلبية"><div id="rcvResults" class="results" role="listbox" hidden></div></div>
    <div class="tablebox cart"><table><thead><tr><th>الصنف</th><th>الكمية</th><th>بونص</th><th>سعر الشراء للعلبة</th><th>سعر البيع</th><th>الصلاحية</th><th>الإجمالي</th><th></th></tr></thead>
      <tbody id="rcvLines">${receiveLinesHtml()}</tbody></table>${RCV.lines.length ? '' : '<p class="empty">امسح أول صنف في الطلبية.</p>'}</div>
    <div class="grid2">
      <label>دفعت كام للمورد دلوقتي<input id="rcvPaid" type="number" min="0" step="0.5" inputmode="decimal" value="${esc(RCV.paid)}" placeholder="0 لو آجل"></label>
      <label>ملاحظة (اختياري)<input id="rcvNote" maxlength="300" value="${esc(RCV.note)}"></label>
    </div>
    <div class="ledger"><div class="tot"><span>إجمالي الفاتورة</span><span class="n" id="rcvTotal">0.00</span></div><div><span>الباقي عليك للمورد</span><span class="n" id="rcvDue">0.00</span></div></div>
    <div class="row"><button class="btn primary" type="submit">سجّل الطلبية</button><button class="btn" type="button" id="rcvClear">ابدأ من الأول</button><span class="note" id="rcvMsg" role="status">${esc(RCV_NOTE)}</span></div>
  </form>`;
}
function rerenderReceiveLines() {
  $('rcvLines').innerHTML = receiveLinesHtml();
  const empty = $('rcvLines').closest('.tablebox').querySelector('.empty');
  if (RCV.lines.length && empty) empty.remove();
  receiveTotals(); saveDraft();
}
function addReceiveLine(it) {
  if (!it) return;
  if (TAB !== 'receive') { TAB = 'receive'; }
  const same = RCV.lines.find((l) => l.code === it.code);
  if (same) same.qty = (+same.qty || 0) + 1;
  else RCV.lines.push({ code: it.code, name: it.name, qty: 1, bonus: 0, cost: it.cost || '', price: it.price || '', expiry: '' });
  saveDraft();
  render();
  receiveTotals();
  const i = RCV.lines.findIndex((l) => l.code === it.code);
  document.querySelector(`[data-l="${i}"][data-f="qty"]`)?.select();
}
function receiveSearch(enter) {
  const q = $('rcvQ').value;
  const box = $('rcvResults');
  if (!q.trim()) { box.hidden = true; return; }
  const r = lookup(q, DATA.items, barcodeMap());
  if (r.item && enter) { $('rcvQ').value = ''; box.hidden = true; addReceiveLine(r.item); return; }
  const list = r.item ? [r.item] : r.matches.slice(0, 8);
  if (enter && list.length === 1) { $('rcvQ').value = ''; box.hidden = true; addReceiveLine(list[0]); return; }
  box.hidden = false;
  box.innerHTML = list.map((it, i) => `<button type="button" class="res ${i === 0 ? 'first' : ''}" data-rcvpick="${esc(it.code)}"><span>${esc(it.name)}</span><span class="muted n">رصيد ${fmt(it.qty)} · ${fmt(it.price, 2)} ج</span></button>`).join('')
    + `<button type="button" class="res" data-rcvnew="1"><span>➕ ضيف «${esc(q.trim())}» كصنف جديد</span></button>`;
  if (enter && list.length > 1) { $('rcvQ').value = ''; box.hidden = true; addReceiveLine(list[0]); }
}

async function saveReceive(e) {
  e.preventDefault();
  const msg = (t) => { RCV_NOTE = ''; $('rcvMsg').textContent = t; };
  if (!RCV.lines.length) return msg('ضيف الأصناف اللي وصلت الأول.');
  const lines = RCV.lines.map((l) => ({ code: l.code, name: l.name, qty: +l.qty || 0, bonus: +l.bonus || 0, cost: +l.cost || 0, price: +l.price || 0, expiry: l.expiry ? `${l.expiry}-01` : null }));
  const bad = lines.find((l) => l.qty + l.bonus <= 0);
  if (bad) return msg(`اكتب كمية «${bad.name}».`);
  let supId = RCV.supplier, supName = '';
  if (supId === '__new') {
    supName = RCV.supplierName.trim();
    if (!supName) return msg('اكتب اسم المورد.');
    const exists = SUPPLIERS().find((x) => x.name === supName);
    if (exists) supId = exists.id;
    else { supId = crypto.randomUUID().slice(0, 8); await saveShared({ suppliers: [...SUPPLIERS(), { id: supId, name: supName, phone: '', discounts: { all: 0 } }] }); }
  } else if (supId) supName = SUPPLIERS().find((x) => x.id === supId)?.name || '';
  else return msg('اختار المورد.');
  if (!RCV.date || RCV.date > isoDay(TODAY)) return msg('اختار تاريخ الاستلام (النهارده أو قبله).');
  const total = purchaseTotal(lines);
  const paid = Math.max(0, +RCV.paid || 0);
  const bid = BRANCHES.find((b) => key(b.id) === RCV.branch)?.id ?? mainBranchId();
  await localInsert('purchases', { branch_id: bid, supplier_id: supId, supplier_name: supName, invoice_no: RCV.invoice.trim() || null, received_on: RCV.date, lines, total, paid, note: RCV.note.trim() || null });
  const n = lines.length;
  RCV = blankReceive(); saveDraft();
  RCV_NOTE = `اتسجلت الطلبية (${n} صنف بـ ${fmt(total, 2)} ج)، والرصيد زاد.${paid < total ? ` الباقي للمورد ${fmt(total - paid, 2)} ج.` : ''}${isOnline() ? '' : ' هتترفع أول ما النت يرجع.'}`;
  render();
}

// ----- Purchase invoices -----
function renderInvoices() {
  if (!INV_READY) return needInv();
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  const list = PURCHASES.filter((p) => bid === 'all' || inBranch({ id: bid })(p))
    .sort((a, b) => String(b.received_on).localeCompare(String(a.received_on)) || String(b.created_at).localeCompare(String(a.created_at)));
  if (!list.length) return `<div class="card emptybox"><h3>لسه مفيش طلبيات متسجلة</h3><p>سجّل أول طلبية من تبويب «طلبية وصلت».</p></div>`;
  const tot = list.reduce((a, p) => ({ t: a.t + +p.total, p: a.p + +p.paid }), { t: 0, p: 0 });
  return `<div class="ledger card"><div><span>عدد الفواتير</span><span class="n">${fmt(list.length)}</span></div><div><span>إجماليها</span><span class="n">${fmt(tot.t, 2)}</span></div><div><span>اتدفع وقت الاستلام</span><span class="n">${fmt(tot.p, 2)}</span></div></div>
  ${list.map((p) => `<details class="help"><summary>${dayText(p.received_on)} · <b>${esc(p.supplier_name || 'من غير مورد')}</b>${p.invoice_no ? ` · فاتورة <span class="n">${esc(p.invoice_no)}</span>` : ''} · <span class="n">${fmt(p.lines.length)}</span> صنف · <b class="n">${fmt(+p.total, 2)}</b> ج${+p.paid < +p.total ? ` · <span class="pill warn">باقي <span class="n">${fmt(+p.total - +p.paid, 2)}</span></span>` : ' · <span class="pill ok">مدفوعة</span>'}${multi() ? ` · ${esc(BRANCHES.find((b) => b.id === (p.branch_id ?? mainBranchId()))?.name || '')}` : ''}${pendingPill(p)}</summary>
    <div class="tablebox"><table><thead><tr><th>الصنف</th><th>الكمية</th><th>بونص</th><th>سعر الشراء</th><th>سعر البيع</th><th>الصلاحية</th><th>الإجمالي</th></tr></thead><tbody>
    ${p.lines.map((l) => `<tr><td class="name">${esc(l.name || l.code)}</td><td class="n">${fmt(l.qty)}</td><td class="n">${fmt(l.bonus || 0)}</td><td class="n">${fmt(l.cost, 2)}</td><td class="n">${l.price ? fmt(l.price, 2) : '—'}</td><td>${l.expiry ? expText(new Date(`${l.expiry}T00:00:00`)) : '—'}</td><td class="n">${fmt(l.qty * l.cost, 2)}</td></tr>`).join('')}
    </tbody></table></div>${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
    ${isOwner() ? `<div class="row"><button class="btn" type="button" data-delpurchase="${esc(p.id)}">امسح الفاتورة دي</button><span class="note">لو اتسجلت غلط. الرصيد هيقل بكمياتها.</span></div>` : ''}</details>`).join('')}`;
}

// ----- Supplier accounts -----
function renderSupplierAccounts() {
  if (!INV_READY) return needInv();
  const bal = supplierBalances(PURCHASES, SUP_PAYMENTS);
  const sup = SUPPLIERS();
  const names = [...new Map([...sup.map((x) => [x.id, x.name]), ...bal.filter((b) => b.id).map((b) => [b.id, b.name])]).entries()];
  const form = isOwner() && names.length ? `<form id="payForm" class="card stack"><h3>دفعت لمورد</h3><div class="grid2">
      <label>المورد<select id="paySup" required>${names.map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('')}</select></label>
      <label>المبلغ<input id="payAmount" type="number" min="0.5" step="0.5" inputmode="decimal" required></label>
      <label>يوم<input id="payDate" type="date" max="${isoDay(TODAY)}" value="${isoDay(TODAY)}"></label>
      <label>ملاحظة (اختياري)<input id="payNote" maxlength="300" placeholder="مثلاً: كاش مع المندوب"></label></div>
      <div class="row"><button class="btn primary" type="submit">سجّل الدفعة</button><span class="note" id="payMsg" role="status"></span></div></form>` : '';
  const pays = [...SUP_PAYMENTS].sort((a, b) => String(b.paid_on).localeCompare(String(a.paid_on))).slice(0, 30);
  return `<p>الحساب مع كل مورد: إجمالي الفواتير، واللي اتدفع، والباقي عليك.</p>`
    + table(['المورد', 'فواتير', 'إجمالي البضاعة', 'اتدفع', 'الباقي عليك', 'آخر طلبية'],
      bal.map((b) => `<tr><td><b>${esc(b.name)}</b></td><td class="n">${fmt(b.invoices)}</td><td>${egp(b.bought)}</td><td>${egp(b.paid)}</td><td>${b.due > 0.005 ? `<span class="pill warn"><span class="n">${fmt(b.due, 2)}</span> ج</span>` : b.due < -0.005 ? `<span class="pill ok">ليك <span class="n">${fmt(-b.due, 2)}</span> ج</span>` : '<span class="pill ok">خالص</span>'}</td><td>${dayText(b.last)}</td></tr>`))
    + form
    + (pays.length ? `<h3>آخر الدفعات</h3>` + table(['يوم', 'المورد', 'المبلغ', 'ملاحظة', ''], pays.map((x) => `<tr><td>${dayText(x.paid_on)}</td><td>${esc(x.supplier_name)}</td><td>${egp(+x.amount)}</td><td>${esc(x.note || '')}</td><td>${isOwner() ? `<button class="btn" type="button" data-delpay="${esc(x.id)}">امسح</button>` : ''}${pendingPill(x)}</td></tr>`)) : '');
}
async function savePayment(e) {
  e.preventDefault();
  const amount = +$('payAmount').value;
  if (!(amount > 0)) { $('payMsg').textContent = 'اكتب المبلغ.'; return; }
  const id = $('paySup').value;
  const name = $('paySup').selectedOptions[0]?.textContent || '';
  await localInsert('supplier_payments', { supplier_id: id, supplier_name: name, amount, paid_on: $('payDate').value || isoDay(TODAY), note: $('payNote').value.trim() || null });
  $('payMsg') && ($('payMsg').textContent = savedNote());
}

// ----- Stock count, damaged / expired, returns to the supplier -----
const CKEY = 'saydaliti-count-draft-v1';
let COUNTS = store.get(CKEY, {});       // code -> boxes counted on the shelf (kept until saved)
let COUNT_Q = '';
let ADJ = { code: null, kind: 'damaged', qty: '', supplier: '', cost: '', note: '' };
let ADJ_NOTE = '';
const viewItem = (code) => DATA.items.find((i) => i.code === code);
const needBranch = () => multi() && BRANCH === 'all';

function adjustForm() {
  const it = ADJ.code ? viewItem(ADJ.code) : null;
  const sup = SUPPLIERS();
  const kinds = MOVE_KINDS.filter(([k]) => k !== 'count' && (k !== 'transfer' || multi()));
  const here = BRANCH === 'all' ? key(mainBranchId()) : BRANCH;
  return `<form id="adjForm" class="card stack" novalidate>
    <h3>شيل بضاعة من الرصيد${multi() ? ' أو حوّلها لفرع تاني' : ''}</h3>
    <div class="row">${kinds.map(([k, t]) => `<button type="button" class="btn ${ADJ.kind === k ? 'sel' : ''}" data-adjkind="${k}" aria-pressed="${ADJ.kind === k}">${t}</button>`).join('')}</div>
    ${it ? `<div class="row" style="justify-content:space-between"><b>${esc(it.name)}</b><span class="muted">الرصيد دلوقتي <b class="n">${fmt(it.qty)}</b></span><button type="button" class="btn" id="adjChange">صنف تاني</button></div>`
      : `<div class="pos-search"><input id="adjQ" type="search" autocomplete="off" placeholder="امسح باركود الصنف أو اكتب اسمه…" aria-label="الصنف"><div id="adjResults" class="results" hidden></div></div>`}
    <div class="grid2">
      <label>الكمية<input id="adjQty" type="number" min="1" step="1" inputmode="numeric" value="${esc(ADJ.qty)}"></label>
      ${ADJ.kind === 'transfer' ? `<label>حوّلها لفرع<select id="adjTo">${BRANCHES.filter((b) => key(b.id) !== here).map((b) => `<option value="${esc(key(b.id))}">${esc(b.name)}</option>`).join('')}</select></label>` : ''}
      ${ADJ.kind === 'supplier_return' ? `<label>رجّعتها لمين<select id="adjSup">${sup.map((x) => `<option value="${esc(x.id)}" ${x.id === ADJ.supplier ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label>سعر الشراء للعلبة (بيتخصم من حساب المورد)<input id="adjCost" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(ADJ.cost || it?.cost || '')}"></label>` : ''}
      <label>ملاحظة (اختياري)<input id="adjNote" maxlength="300" value="${esc(ADJ.note)}"></label>
    </div>
    ${ADJ.kind === 'supplier_return' && !sup.length ? '<p class="note">ضيف الموردين الأول من «اطلب إيه».</p>' : ''}
    <div class="row"><button class="btn primary" type="submit">سجّل</button><span class="note" id="adjMsg" role="status">${esc(ADJ_NOTE)}</span></div>
  </form>`;
}

function countRows() {
  const list = itemMatches(COUNT_Q);
  return list.slice(0, 120).map((i) => {
    const v = COUNTS[i.code] ?? '';
    const diff = v === '' ? null : +v - i.qty;
    return `<tr><td class="name">${esc(i.name)}<span class="cat n">${esc(i.code)}</span></td><td class="n">${fmt(i.qty)}</td>
      <td><input class="disc n" type="number" min="0" step="1" inputmode="numeric" data-count="${esc(i.code)}" value="${esc(v)}" aria-label="العدد على الرف"></td>
      <td class="n" data-diff="${esc(i.code)}">${diff === null ? '' : diff === 0 ? '<span class="pill ok">مظبوط</span>' : `<span class="pill ${diff < 0 ? 'crit' : 'warn'}">${diff > 0 ? '+' : ''}${fmt(diff)}</span>`}</td></tr>`;
  }).join('') + (list.length > 120 ? `<tr><td colspan="4" class="muted">ظاهر أول 120 من ${fmt(list.length)}. دوّر عشان تلاقي الباقي.</td></tr>` : '');
}
const countedN = () => Object.values(COUNTS).filter((v) => v !== '' && v !== null).length;

function renderAdjust() {
  if (!INV_READY) return needInv();
  if (needBranch()) return '<div class="card emptybox"><h3>اختار الفرع من فوق الأول</h3><p>الجرد والتالف بيتسجلوا على فرع معين.</p></div>';
  const expired = expiredOnShelf(DATA.items, TODAY);
  const bid = BRANCH === 'all' ? mainBranchId() : BRANCH_ID();
  const hist = MOVES.filter(inBranch({ id: bid })).sort((a, b) => String(b.happened_at).localeCompare(String(a.happened_at))).slice(0, 100);
  const exp = expired.length ? `<div class="card"><h3>علب منتهية لسه في الرصيد (${fmt(expired.length)} صنف)</h3>
    <p class="note">لو شلتها من الرف فعلاً، دوس «شيلها» وهتتسجل خسارة منتهي الصلاحية.</p>
    ${table(['الصنف', 'منتهي من', 'الكمية', 'قيمتها', ''], expired.map((x) => `<tr><td class="name">${esc(x.name)}</td><td>${expText(x.expiry)}</td><td class="n">${fmt(x.qty)}</td><td>${egp(x.qty * x.cost)}</td><td>${isOwner() ? `<button class="btn" type="button" data-expout="${esc(x.code)}" data-expqty="${x.qty}">شيلها</button>` : ''}</td></tr>`))}</div>` : '';
  const count = `<details class="help" id="countBox" ${countedN() || COUNT_Q ? 'open' : ''}><summary>جرد الرف (اكتب العدد الفعلي لكل صنف)</summary>
    <p class="note">اكتب اللي لقيته على الرف قدام كل صنف، حتى لو صفر. اللي بتكتبه بيتحفظ على الجهاز لحد ما تسجّل الجرد، فتقدر تجرد على كذا مرة.</p>
    <input id="countQ" type="search" autocomplete="off" placeholder="دوّر على صنف…" value="${esc(COUNT_Q)}" aria-label="دوّر في الجرد">
    <div class="tablebox"><table><thead><tr><th>الصنف</th><th>الرصيد المسجل</th><th>لقيت على الرف</th><th>الفرق</th></tr></thead><tbody id="countBody">${countRows()}</tbody></table></div>
    ${isOwner() ? `<div class="row"><button class="btn primary" type="button" id="countSave">سجّل الجرد (<span id="countN">${countedN()}</span> صنف)</button><button class="btn" type="button" id="countClear">امسح اللي كتبته</button><span class="note" id="countMsg" role="status"></span></div>` : ''}
  </details>`;
  const history = hist.length ? `<h3>آخر التعديلات</h3>` + table(['يوم', 'الصنف', 'النوع', 'الكمية', 'ملاحظة', ''],
    hist.map((m) => `<tr><td>${dayText(m.happened_at)}</td><td class="name">${esc(viewItem(m.code)?.name ?? m.code)}</td><td>${moveLabel(m.kind)}</td>
      <td class="n"><span class="pill ${+m.qty < 0 ? 'crit' : 'ok'}">${+m.qty > 0 ? '+' : ''}${fmt(+m.qty)}</span></td><td>${esc(m.note || '')}</td>
      <td>${isOwner() ? `<button class="btn" type="button" data-delmove="${esc(m.id)}">امسح</button>` : ''}${pendingPill(m)}</td></tr>`)) : '';
  return `<p>الجرد بيظبط الرصيد على اللي موجود فعلاً، والتالف والمنتهي بيتشالوا من الرصيد ويتحسبوا خسارة في «الحسابات»، والمرتجع للمورد بيتخصم من حسابه.</p>
    ${isOwner() ? adjustForm() : ''}${exp}${count}${history}`;
}

function adjustSearch(enter) {
  const q = $('adjQ').value;
  const box = $('adjResults');
  if (!q.trim()) { box.hidden = true; return; }
  const r = lookup(q, DATA.items, barcodeMap());
  const list = r.item ? [r.item] : r.matches.slice(0, 8);
  if (enter && list.length) { pickAdjust(list[0].code); return; }
  box.hidden = !list.length;
  box.innerHTML = list.map((it, i) => `<button type="button" class="res ${i === 0 ? 'first' : ''}" data-adjpick="${esc(it.code)}"><span>${esc(it.name)}</span><span class="muted n">رصيد ${fmt(it.qty)}</span></button>`).join('');
}
function pickAdjust(code) {
  ADJ.code = code; ADJ.cost = ''; ADJ_NOTE = '';
  render();
  $('adjQty')?.focus();
}

async function saveAdjust(e) {
  e.preventDefault();
  const m = (t) => { ADJ_NOTE = ''; $('adjMsg').textContent = t; };
  const it = ADJ.code && viewItem(ADJ.code);
  if (!it) return m('اختار الصنف الأول.');
  const qty = Math.round(+$('adjQty').value || 0);
  if (qty <= 0) return m('اكتب الكمية.');
  const note = $('adjNote').value.trim();
  const bid = BRANCH === 'all' ? mainBranchId() : BRANCH_ID();
  const row = { code: it.code, qty: -qty, kind: ADJ.kind, branch_id: bid, happened_at: new Date().toISOString(), note: note || null };
  if (ADJ.kind === 'transfer') {
    const to = BRANCHES.find((b) => key(b.id) === $('adjTo')?.value);
    if (!to) return m('اختار الفرع اللي هتحوّل له.');
    if (qty > it.qty && !confirm(`رصيد «${it.name}» هنا ${fmt(it.qty)} بس. تحوّل ${qty} برضه؟`)) return;
    const ref = crypto.randomUUID();
    const expiry = it.batches?.find((b) => b.expiry && b.qty > 0)?.expiry ?? it.expiry;
    const from = BRANCHES.find((b) => b.id === bid)?.name ?? '';
    await localInsert('stock_moves', { ...row, ref, cost: it.cost || null, note: [`لـ${to.name}`, note].filter(Boolean).join(' · ') });
    await localInsert('stock_moves', { code: it.code, qty, kind: 'transfer', branch_id: to.id, ref, cost: it.cost || null, expiry: expiry ? isoDay(expiry) : null, happened_at: row.happened_at, note: [`من ${from}`, note].filter(Boolean).join(' · ') });
    ADJ_NOTE = `اتحوّل ${qty} من «${it.name}» لـ«${to.name}».${isOnline() ? '' : ' هيترفع أول ما النت يرجع.'}`;
    ADJ = { ...ADJ, code: null, qty: '', note: '' };
    render();
    return;
  }
  if (ADJ.kind === 'supplier_return') {
    const s = SUPPLIERS().find((x) => x.id === $('adjSup')?.value);
    if (!s) return m('اختار المورد.');
    const cost = Math.max(0, +$('adjCost').value || 0);
    const pay = cost > 0 ? await localInsert('supplier_payments', { supplier_id: s.id, supplier_name: s.name, amount: Math.round(qty * cost * 100) / 100, paid_on: isoDay(TODAY), note: `مرتجع بضاعة: ${qty} × ${it.name}` }) : null;
    Object.assign(row, { cost, note: [`لـ${s.name}`, note].filter(Boolean).join(' · '), ...(pay ? { ref: pay.id } : {}) });
  } else row.cost = it.cost || null;
  await localInsert('stock_moves', row);
  ADJ_NOTE = `اتسجل: ${moveLabel(ADJ.kind)} ${qty} من «${it.name}».${isOnline() ? '' : ' هيترفع أول ما النت يرجع.'}`;
  ADJ = { code: null, kind: ADJ.kind, qty: '', supplier: ADJ.supplier, cost: '', note: '' };
  render();
  $('adjQ')?.focus();
}

async function saveCount() {
  const list = countDifferences(COUNTS, DATA.items);
  if (!countedN()) { $('countMsg').textContent = 'اكتب العدد قدام الأصناف اللي جردتها.'; return; }
  if (list.length && !confirm(`هيتعدل رصيد ${list.length} صنف على حسب الجرد. تكمّل؟`)) return;
  const bid = BRANCH === 'all' ? mainBranchId() : BRANCH_ID();
  const at = new Date().toISOString();
  for (const x of list) await localInsert('stock_moves', { code: x.code, qty: x.qty, kind: 'count', branch_id: bid, happened_at: at, note: `جرد: كان ${fmt(x.was)} ولقيت ${fmt(x.counted)}` });
  const n = countedN();
  COUNTS = {}; store.set(CKEY, COUNTS); COUNT_Q = '';
  render();
  $('countBox').open = true;
  $('countMsg').textContent = `اتسجل جرد ${n} صنف: ${list.length ? `${list.length} صنف رصيده اتظبط` : 'كله مظبوط'}.`;
}

$('panel').addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'adjQ') adjustSearch(false);
  if (t.id === 'adjQty') ADJ.qty = t.value;
  if (t.id === 'adjNote') ADJ.note = t.value;
  if (t.id === 'adjCost') ADJ.cost = t.value;
  if (t.id === 'countQ') { COUNT_Q = t.value; $('countBody').innerHTML = countRows(); }
  if (t.dataset.count !== undefined) {
    if (t.value === '') delete COUNTS[t.dataset.count]; else COUNTS[t.dataset.count] = t.value;
    store.set(CKEY, COUNTS);
    const it = viewItem(t.dataset.count);
    const cell = document.querySelector(`[data-diff="${CSS.escape(t.dataset.count)}"]`);
    if (cell && it) { const d = t.value === '' ? null : +t.value - it.qty; cell.innerHTML = d === null ? '' : d === 0 ? '<span class="pill ok">مظبوط</span>' : `<span class="pill ${d < 0 ? 'crit' : 'warn'}">${d > 0 ? '+' : ''}${fmt(d)}</span>`; }
    if ($('countN')) $('countN').textContent = countedN();
  }
});
$('panel').addEventListener('change', (e) => { if (e.target.id === 'adjSup') ADJ.supplier = e.target.value; });
$('panel').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'adjQ') { e.preventDefault(); adjustSearch(true); }
  if (e.target.dataset?.count !== undefined) { e.preventDefault(); const all = [...document.querySelectorAll('[data-count]')]; all[all.indexOf(e.target) + 1]?.focus(); }
});
$('panel').addEventListener('submit', (e) => { if (e.target.id === 'adjForm') saveAdjust(e); });
$('panel').addEventListener('click', async (e) => {
  const t = (k) => e.target.closest(`[data-${k}]`)?.dataset[k];
  if (t('adjkind')) { ADJ.kind = t('adjkind'); ADJ_NOTE = ''; render(); }
  if (t('adjpick')) pickAdjust(t('adjpick'));
  if (e.target.id === 'adjChange') { ADJ.code = null; render(); $('adjQ')?.focus(); }
  if (t('expout')) {
    const it = viewItem(t('expout')); const qty = +e.target.closest('[data-expqty]').dataset.expqty;
    if (it && confirm(`تشيل ${qty} علبة منتهية من «${it.name}» من الرصيد؟`)) await localInsert('stock_moves', { code: it.code, qty: -qty, kind: 'expired', branch_id: BRANCH === 'all' ? mainBranchId() : BRANCH_ID(), cost: it.cost || null, happened_at: new Date().toISOString(), note: 'منتهي على الرف' });
  }
  if (e.target.id === 'countSave') saveCount();
  if (e.target.id === 'countClear' && confirm('تمسح كل اللي كتبته في الجرد؟')) { COUNTS = {}; store.set(CKEY, COUNTS); render(); $('countBox').open = true; }
  if (t('delmove')) {
    const m = MOVES.find((x) => x.id === t('delmove'));
    if (m && confirm(m.kind === 'transfer' ? 'تمسح التحويل ده من الفرعين؟' : 'تمسح التعديل ده؟ الرصيد هيرجع زي ما كان قبله.')) {
      if (m.ref && SUP_PAYMENTS.some((p) => p.id === m.ref)) await localDelete('supplier_payments', m.ref);
      if (m.kind === 'transfer' && m.ref) for (const x of MOVES.filter((y) => y.ref === m.ref && y.id !== m.id)) await localDelete('stock_moves', x.id);
      await localDelete('stock_moves', m.id);
    }
  }
});

$('panel').addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'itemsQ') { ITEMS_Q = t.value; $('itemsBody').innerHTML = itemsRows(); return; }
  if (t.id === 'rcvQ') { receiveSearch(false); return; }
  if (t.dataset.l !== undefined) { RCV.lines[+t.dataset.l][t.dataset.f] = t.value; receiveTotals(); saveDraft(); return; }
  const f = { rcvSupName: 'supplierName', rcvNo: 'invoice', rcvDate: 'date', rcvPaid: 'paid', rcvNote: 'note' }[t.id];
  if (f) { RCV[f] = t.value; if (f === 'paid') receiveTotals(); saveDraft(); }
});
$('panel').addEventListener('change', (e) => {
  if (e.target.id === 'rcvSup') { RCV.supplier = e.target.value; saveDraft(); $('rcvSupNameWrap').hidden = RCV.supplier !== '__new'; if (!$('rcvSupNameWrap').hidden) $('rcvSupName').focus(); }
  if (e.target.id === 'rcvBranch') { RCV.branch = e.target.value; saveDraft(); }
});
$('panel').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'rcvQ') { e.preventDefault(); receiveSearch(true); }
  // A barcode scanner ends with Enter: don't send the form half-filled.
  if (e.target.id === 'itBarcode' || (e.target.closest('#rcvForm') && e.target.type !== 'submit')) { e.preventDefault(); if (e.target.id === 'itBarcode') $('itCat').focus(); }
});
$('panel').addEventListener('submit', (e) => {
  if (e.target.id === 'itemForm') saveItem(e);
  if (e.target.id === 'rcvForm') saveReceive(e);
  if (e.target.id === 'payForm') savePayment(e);
});
$('panel').addEventListener('click', (e) => {
  const t = (k) => e.target.closest(`[data-${k}]`)?.dataset[k];
  if (e.target.id === 'newItemBtn') { ITEM_NOTE = ''; ITEM_FORM = { name: ITEMS_Q && !/^\d+$/.test(ITEMS_Q) ? ITEMS_Q : '', barcode: /^\d{6,}$/.test(ITEMS_Q.trim()) ? ITEMS_Q.trim() : '' }; render(); $('itName')?.focus(); }
  if (t('edititem')) { const i = DATA.items.find((x) => x.code === t('edititem')); const c = CATALOG.find((x) => x.code === i?.code); if (i) { ITEM_FORM = { code: i.code, name: i.name, category: i.category, price: i.price, cost: i.cost, barcode: c?.barcode || '' }; render(); $('itemForm')?.scrollIntoView({ block: 'center' }); } }
  if (e.target.id === 'itemCancel') { ITEM_FORM = null; render(); }
  if (t('rcvpick')) { $('rcvQ').value = ''; $('rcvResults').hidden = true; addReceiveLine(DATA.items.find((i) => i.code === t('rcvpick'))); }
  if (t('rcvnew')) { const q = $('rcvQ').value.trim(); const digits = /^\d{6,}$/.test(q); ITEM_FORM = { forReceive: true, name: digits ? '' : q, barcode: digits ? q : '' }; render(); $(digits ? 'itName' : 'itPrice')?.focus(); }
  if (t('rcvdel') !== undefined) { RCV.lines.splice(+t('rcvdel'), 1); rerenderReceiveLines(); }
  if (e.target.id === 'rcvClear' && (!RCV.lines.length || confirm('تمسح الطلبية اللي بتكتبها وتبدأ من الأول؟'))) { RCV = blankReceive(); saveDraft(); render(); }
  if (t('delpurchase') && confirm('تمسح الفاتورة دي؟ الرصيد هيقل بكمياتها، وحساب المورد هيتعدل.')) localDelete('purchases', t('delpurchase'));
  if (t('delpay') && confirm('تمسح الدفعة دي؟')) localDelete('supplier_payments', t('delpay'));
});

// ---------- Customers on account and insurance (migration 011) ----------
let CUSTOMERS = [], CUST_PAYMENTS = [];
let CUST_READY = true;
let CUST_EDIT = null;   // customer being edited, or 'new'
let CUST_VIEW = null;   // customer whose statement is open
let CUST_NOTE = '';
let CLAIM_PERIOD = 'thisMonth';
const needCust = () => '<div class="card emptybox"><h3>الجزء ده محتاج تحديث قاعدة البيانات</h3><p>التحديث <code>011</code> بيضيف العملاء والآجل والتأمين. بعد ما يتطبق، الصفحة دي هتشتغل على طول.</p></div>';
const custName = (id) => CUSTOMERS.find((c) => c.id === id)?.name ?? '';

async function loadCustomers() {
  try {
    [CUSTOMERS, CUST_PAYMENTS] = await Promise.all([
      loadTable('customers', 'id, name, phone, kind, coverage_pct, credit_limit, note, active, created_at, updated_at'),
      loadTable('customer_payments', 'id, customer_id, amount, paid_on, note, created_at', 'paid_on'),
    ]);
    CUST_READY = true;
  } catch (e) { if (e.missing) CUST_READY = false; }
}

function customerForm() {
  const c = CUST_EDIT === 'new' ? {} : CUSTOMERS.find((x) => x.id === CUST_EDIT) || {};
  return `<form id="custForm" class="card stack" novalidate><h3>${c.id ? `عدّل «${esc(c.name)}»` : 'عميل جديد'}</h3><div class="grid2">
    <label>الاسم<input id="cuName" maxlength="120" value="${esc(c.name || '')}"></label>
    <label>الموبايل (اختياري)<input id="cuPhone" type="tel" inputmode="tel" maxlength="20" value="${esc(c.phone || '')}"></label>
    <label>النوع<select id="cuKind">${CUSTOMER_KINDS.map(([v, t]) => `<option value="${v}" ${v === (c.kind || 'person') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label id="cuCovWrap" ${(c.kind || 'person') === 'insurance' ? '' : 'hidden'}>الشركة بتدفع كام % من الفاتورة<input id="cuCov" type="number" min="0" max="100" step="1" value="${esc(c.coverage_pct ?? 80)}"></label>
    <label>أقصى آجل مسموح (اختياري)<input id="cuLimit" type="number" min="0" step="50" value="${esc(c.credit_limit ?? '')}"></label>
    <label>ملاحظة (اختياري)<input id="cuNote" maxlength="300" value="${esc(c.note || '')}"></label></div>
    <div class="row"><button class="btn primary" type="submit">${c.id ? 'احفظ' : 'ضيف'}</button><button class="btn" type="button" id="cuCancel">إلغاء</button><span class="note" id="cuMsg" role="status"></span></div></form>`;
}

function statementHtml(c) {
  const rows = statement(c.id, POS_SALES, CUST_PAYMENTS);
  const label = { sale: 'فاتورة', return: 'مرتجع', payment: 'دفع' };
  return `<div class="card"><div class="row" style="justify-content:space-between"><h3>كشف حساب ${esc(c.name)}</h3><div class="row">
    ${c.phone ? `<button class="btn" type="button" data-sendstmt="${esc(c.id)}">ابعته واتساب</button>` : ''}<button class="btn" type="button" data-closestmt="1">اقفل</button></div></div>`
    + table(['يوم', 'البيان', 'رقم', 'المبلغ', 'الرصيد'], rows.map((r) => `<tr><td>${dayText(r.at)}</td><td>${label[r.kind]}${r.claim ? ` · موافقة <span class="n">${esc(r.claim)}</span>` : ''}</td><td class="n">${esc(r.ref || '')}</td>
      <td class="n"><span class="pill ${r.amount < 0 ? 'ok' : 'warn'}">${r.amount > 0 ? '+' : ''}${fmt(r.amount, 2)}</span></td><td class="n"><b>${fmt(r.balance, 2)}</b></td></tr>`)) + '</div>';
}
function statementText(c) {
  const rows = statement(c.id, POS_SALES, CUST_PAYMENTS).slice(-25);
  const label = { sale: 'فاتورة', return: 'مرتجع', payment: 'دفعة' };
  const bal = rows.length ? rows[rows.length - 1].balance : 0;
  return [`كشف حساب ${c.name} — ${SESS.pharmacy?.name || 'الصيدلية'}`, ...rows.map((r) => `${dayText(r.at)}: ${label[r.kind]} ${fmt(Math.abs(r.amount), 2)} ج`), `الباقي عليك: ${fmt(bal, 2)} ج`].join('\n');
}

function renderCustomers() {
  if (!CUST_READY) return needCust();
  const bal = customerBalances(CUSTOMERS, POS_SALES, CUST_PAYMENTS);
  const owedAll = bal.reduce((a, c) => a + Math.max(0, c.owed), 0);
  const view = CUST_VIEW && CUSTOMERS.find((c) => c.id === CUST_VIEW);
  const pay = isOwner() && CUSTOMERS.length ? `<form id="cpayForm" class="card stack"><h3>استلمت فلوس من عميل أو شركة تأمين</h3><div class="grid2">
      <label>من مين<select id="cpCust">${bal.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.owed > 0 ? ` (عليه ${fmt(c.owed, 2)})` : ''}</option>`).join('')}</select></label>
      <label>المبلغ<input id="cpAmount" type="number" min="0.5" step="0.5" inputmode="decimal"></label>
      <label>يوم<input id="cpDate" type="date" max="${isoDay(TODAY)}" value="${isoDay(TODAY)}"></label>
      <label>ملاحظة (اختياري)<input id="cpNote" maxlength="300"></label></div>
      <div class="row"><button class="btn primary" type="submit">سجّل</button><span class="note" id="cpMsg" role="status"></span></div></form>` : '';
  return `<p>العملاء اللي بيشتروا آجل وشركات التأمين. الفاتورة اللي عليها عميل في الكاشير بتتسجل على حسابه، والتأمين بيتحسب عليه نصيبه بس. إجمالي اللي ليك برا: <b class="n">${fmt(owedAll, 2)}</b> ج.</p>
    ${CUST_NOTE ? `<p class="note" role="status">${esc(CUST_NOTE)}</p>` : ''}
    ${isOwner() ? (CUST_EDIT ? customerForm() : '<div class="row"><button class="btn primary" type="button" id="cuNew">+ عميل جديد</button></div>') : ''}
    ${view ? statementHtml(view) : ''}`
    + table(['الاسم', 'النوع', 'فواتير', 'على الحساب', 'دفع', 'الباقي عليه', 'آخر شراء', ''],
      bal.map((c) => `<tr><td><b>${esc(c.name)}</b>${c.phone ? `<span class="cat n">${esc(c.phone)}</span>` : ''}${pendingPill(c)}</td>
        <td>${c.kind === 'insurance' ? `تأمين <span class="n">${fmt(+c.coverage_pct)}%</span>` : 'عميل'}</td><td class="n">${fmt(c.bills)}</td><td>${egp(c.onAccount)}</td><td>${egp(c.paid)}</td>
        <td>${c.owed > 0.005 ? `<span class="pill ${+c.credit_limit && c.owed > +c.credit_limit ? 'crit' : 'warn'}"><span class="n">${fmt(c.owed, 2)}</span> ج</span>` : '<span class="pill ok">خالص</span>'}</td>
        <td>${c.last ? dayText(c.last) : '—'}</td>
        <td class="acts"><button class="btn" type="button" data-stmt="${esc(c.id)}">كشف حساب</button>${isOwner() ? ` <button class="btn" type="button" data-editcust="${esc(c.id)}">عدّل</button>` : ''}</td></tr>`))
    + pay;
}

async function saveCustomer(e) {
  e.preventDefault();
  const name = $('cuName').value.trim();
  if (!name) { $('cuMsg').textContent = 'اكتب الاسم.'; return; }
  const kind = $('cuKind').value;
  const fields = { name, phone: $('cuPhone').value.trim() || null, kind, coverage_pct: kind === 'insurance' ? Math.max(0, Math.min(100, +$('cuCov').value || 0)) : 0,
    credit_limit: $('cuLimit').value === '' ? null : Math.max(0, +$('cuLimit').value), note: $('cuNote').value.trim() || null };
  const id = CUST_EDIT;
  CUST_EDIT = null;
  if (id && id !== 'new') await localUpdate('customers', id, { ...fields, updated_at: new Date().toISOString() });
  else {
    if (CUSTOMERS.some((c) => c.name === name)) { CUST_EDIT = 'new'; render(); $('cuMsg').textContent = 'فيه عميل بنفس الاسم.'; return; }
    await localInsert('customers', { ...fields, active: true });
  }
  CUST_NOTE = `${id && id !== 'new' ? 'اتحفظ التعديل' : `اتضاف «${name}»`}.`;
  render();
}
async function saveCustomerPayment(e) {
  e.preventDefault();
  const amount = +$('cpAmount').value;
  if (!(amount > 0)) { $('cpMsg').textContent = 'اكتب المبلغ.'; return; }
  const id = $('cpCust').value;
  await localInsert('customer_payments', { customer_id: id, amount, paid_on: $('cpDate').value || isoDay(TODAY), note: $('cpNote').value.trim() || null });
  CUST_NOTE = `اتسجل ${fmt(amount, 2)} ج من «${custName(id)}». ${savedNote()}`;
  render();
}

function renderClaims() {
  if (!CUST_READY) return needCust();
  const [from, to] = periodRange(CLAIM_PERIOD);
  const list = claims(CUSTOMERS, POS_SALES, from, to);
  const head = `<div class="row">${periodSelect('claimPeriodSel', CLAIM_PERIOD)}</div><p>فواتير شركات التأمين في الفترة دي: رقم الفاتورة، ورقم الموافقة، ونصيب الشركة. انسخها وابعتها للشركة مع المطالبة.</p>`;
  if (!list.length) return head + '<div class="card emptybox"><h3>مفيش فواتير تأمين في الفترة دي</h3><p>في الكاشير، اختار شركة التأمين في خانة العميل قبل الدفع، والبرنامج يحسب نصيبها لوحده.</p></div>';
  return head + list.map((g, i) => `<div class="card"><div class="row" style="justify-content:space-between"><h3>${esc(g.customer.name)} <span class="muted">(${fmt(+g.customer.coverage_pct)}%)</span></h3>
    <span>${fmt(g.bills.length)} فاتورة · الإجمالي <b class="n">${fmt(g.total, 2)}</b> · نصيب الشركة <b class="n">${fmt(g.share, 2)}</b> ج</span></div>`
    + table(['يوم', 'رقم الفاتورة', 'رقم الموافقة', 'الفاتورة', 'نصيب الشركة'], g.bills.map((s) => `<tr><td>${dayText(s.sold_at)}</td><td class="n">${esc(s.number)}</td><td class="n">${esc(s.claim_no || '—')}</td><td class="n">${fmt(+s.total, 2)}</td><td class="n"><b>${fmt(+s.credit, 2)}</b></td></tr>`))
    + `<textarea readonly id="claimMsg${i}" aria-label="المطالبة" style="min-height:120px">${esc([`مطالبة ${SESS.pharmacy?.name || 'الصيدلية'} — ${g.customer.name}`, ...g.bills.map((s) => `${dayText(s.sold_at)} · فاتورة ${s.number}${s.claim_no ? ` · موافقة ${s.claim_no}` : ''} · ${fmt(+s.credit, 2)} ج`), `الإجمالي المطلوب: ${fmt(g.share, 2)} ج (${g.bills.length} فاتورة)`].join('\n'))}</textarea>
    <div class="row"><button class="btn" type="button" data-copyclaim="${i}">انسخ المطالبة</button><span class="note" id="claimNote${i}"></span></div></div>`).join('');
}

// ---------- Profit by day and by month ----------
function renderProfit() {
  const months = profitByPeriod(DATA, 'month', new Date(TODAY.getFullYear(), TODAY.getMonth() - 11, 1), addDays(TODAY, 1));
  const days = profitByPeriod(DATA, 'day', new Date(TODAY.getFullYear(), TODAY.getMonth(), 1), addDays(TODAY, 1));
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  const expOf = (key) => {
    if (!EXP_READY) return null;
    const [y, m] = key.split('-').map(Number);
    return expenseTotals(EXPENSES, new Date(y, m - 1, 1), new Date(y, m, 1), bid);
  };
  const monthName = (key) => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('ar-EG', { month: 'long', year: 'numeric' }); };
  const pill = (v) => `<span class="pill ${v < 0 ? 'crit' : 'ok'}"><span class="n">${fmt(v)}</span> ج</span>`;
  const branchTable = BRANCH === 'all' && multi() ? (() => {
    const from = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
    const rows = BRANCHES.map((b) => ({ b, r: profitByPeriod(branchData(b), 'month', from, addDays(TODAY, 1))[0] }));
    return '<h3>الفروع الشهر ده</h3>' + table(['الفرع', 'المبيعات', 'تكلفة البضاعة', 'المكسب', 'نسبة المكسب'], rows.map(({ b, r }) => `<tr><td><b>${esc(b.name)}</b></td><td>${egp(r?.sales ?? 0)}</td><td>${egp(r?.cogs ?? 0)}</td><td>${pill(r?.gross ?? 0)}</td><td class="n">${fmt(r?.margin ?? 0, 1)}%</td></tr>`));
  })() : '';
  if (!months.length) return '<div class="card emptybox"><h3>لسه مفيش مبيعات</h3><p>الأرباح بتتحسب من مبيعات الكاشير والملفات اللي اترفعت.</p></div>';
  return `<p>المكسب = المبيعات (بعد الخصومات) − تكلفة البضاعة اللي اتباعت بسعر شرائها. والصافي بيطرح كمان التالف والمنتهي والمصروفات المتسجلة.</p>`
    + '<h3>كل شهر</h3>' + table(['الشهر', 'المبيعات', 'تكلفة البضاعة', 'المكسب', 'نسبة المكسب', 'تالف ومنتهي', 'المصروفات', 'الصافي'], months.map((r) => {
      const E = expOf(r.key);
      const net = r.gross - r.lost - (E?.operating ?? 0);
      return `<tr><td><b>${monthName(r.key)}</b></td><td>${egp(r.sales)}</td><td>${egp(r.cogs)}</td><td>${pill(r.gross)}</td><td class="n">${fmt(r.margin, 1)}%</td><td>${r.lost ? egp(r.lost) : '—'}</td><td>${E?.count ? egp(E.operating) : '<span class="muted">—</span>'}</td><td>${pill(net)}</td></tr>`;
    }))
    + branchTable
    + '<h3>كل يوم في الشهر ده</h3>' + table(['اليوم', 'المبيعات', 'تكلفة البضاعة', 'المكسب', 'نسبة المكسب'], days.map((r) => `<tr><td>${new Date(`${r.key}T00:00:00`).toLocaleDateString('ar-EG', { weekday: 'short', day: 'numeric', month: 'short' })}</td><td>${egp(r.sales)}</td><td>${egp(r.cogs)}</td><td>${pill(r.gross)}</td><td class="n">${fmt(r.margin, 1)}%</td></tr>`));
}

$('panel').addEventListener('submit', (e) => {
  if (e.target.id === 'custForm') saveCustomer(e);
  if (e.target.id === 'cpayForm') saveCustomerPayment(e);
});
$('panel').addEventListener('change', (e) => {
  if (e.target.id === 'cuKind') $('cuCovWrap').hidden = e.target.value !== 'insurance';
  if (e.target.id === 'claimPeriodSel') { CLAIM_PERIOD = e.target.value; render(); }
});
$('panel').addEventListener('click', (e) => {
  const t = (k) => e.target.closest(`[data-${k}]`)?.dataset[k];
  if (e.target.id === 'cuNew') { CUST_EDIT = 'new'; CUST_NOTE = ''; render(); $('cuName')?.focus(); }
  if (e.target.id === 'cuCancel') { CUST_EDIT = null; render(); }
  if (t('editcust')) { CUST_EDIT = t('editcust'); CUST_NOTE = ''; render(); $('custForm')?.scrollIntoView({ block: 'center' }); }
  if (t('stmt')) { CUST_VIEW = t('stmt'); render(); $('panel').querySelector('.card h3')?.scrollIntoView({ block: 'start' }); }
  if (t('closestmt')) { CUST_VIEW = null; render(); }
  if (t('sendstmt')) { const c = CUSTOMERS.find((x) => x.id === t('sendstmt')); const phone = normalizeEgPhone(c?.phone || ''); if (c) window.open(`https://wa.me/${phone || ''}?text=${encodeURIComponent(statementText(c))}`, '_blank', 'noopener'); }
  if (t('copyclaim') !== undefined) copyFrom($(`claimMsg${t('copyclaim')}`), $(`claimNote${t('copyclaim')}`));
});

// ---------- Offline desktop version: no accounts, backups to a file ----------
const desktop = () => window.saydalitiDesktop; // provided by the Windows app
function setupLocal() {
  for (const id of ['logout', 'inviteBox', 'connectorBox']) { const el = $(id); if (el) el.hidden = true; }
  $('localBox').hidden = false;
  updateNet();
  $('backupWhere').textContent = desktop() ? 'البرنامج بيعمل نسخة احتياطية لوحده كل يوم في فولدر «Saydaliti» جوه «Documents». احتفظ بنسخة كمان على فلاشة أو على الموبايل.' : 'نزّل نسخة احتياطية كل فترة واحتفظ بيها على فلاشة.';
  autoBackup();
}
async function backupJson() { return JSON.stringify(await SESS.client.exportAll()); }
async function saveBackup(manual) {
  const json = await backupJson();
  const name = `saydaliti-backup-${isoDay(new Date())}.json`;
  if (desktop()?.saveBackup) return desktop().saveBackup(name, json, manual);
  if (!manual) return null;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return name;
}
async function autoBackup() {
  if (!desktop()?.saveBackup) return;
  const last = store.get('saydaliti-last-backup', 0);
  if (Date.now() - last < 20 * 3600 * 1000) return;
  try { await saveBackup(false); store.set('saydaliti-last-backup', Date.now()); } catch { /* try again next time */ }
}
$('backupBtn').addEventListener('click', async () => {
  $('backupMsg').textContent = 'لحظة…';
  try { const where = await saveBackup(true); store.set('saydaliti-last-backup', Date.now()); $('backupMsg').textContent = where ? `اتحفظت: ${where}` : 'اتحفظت.'; } catch (e) { $('backupMsg').textContent = `ماتحفظتش: ${e.message}`; }
});
$('restoreFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!confirm('ترجّع البيانات من النسخة دي؟ كل اللي على الجهاز دلوقتي هيتبدل بيها. (الأحسن تنزّل نسخة احتياطية من الحالي الأول.)')) return;
  try { await SESS.client.importAll(JSON.parse(await f.text())); await clearLocal(); location.reload(); } catch (err) { $('backupMsg').textContent = err.message; }
});

// ---------- Branches & data ----------
const snapKey = (k) => `snap:${SESS.pharmacy.id}:${k}`;
const prevKey = (k) => `snapPrev:${SESS.pharmacy.id}:${k}`;

// One branch's stock: its last upload, plus what was entered here since (items, deliveries, cashier, adjustments).
function branchData(b) {
  const s = SNAP.get(key(b?.id ?? null));
  const mine = inBranch(b);
  return liveData(s?.data, s?.at, { catalog: CATALOG, purchases: PURCHASES.filter(mine), sales: POS_SALES.filter(mine), moves: MOVES.filter(mine) });
}

function setView() {
  const parts = BRANCH === 'all' ? BRANCHES.map(branchData) : [branchData(BRANCHES.find((b) => key(b.id) === BRANCH))];
  DATA = mergeBranches(parts.filter((d) => d.items.length)) || EMPTY();
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
  $('netChip').textContent = SESS.local ? (n ? `بيحفظ ${n}…` : 'محفوظ على الجهاز') : on ? (n ? `بيرفع ${n}…` : 'متصل') : `من غير نت${n ? ` · ${n} مستني يترفع` : ''}`;
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
  try { SESS = await getSession(); } catch (err) {
    $('auth').innerHTML = `<p class="err">${esc(err.message)}</p><button class="btn primary" type="button" id="retryBoot">جرّب تاني</button>`;
    $('retryBoot').addEventListener('click', () => location.reload());
    return;
  }
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
  if (SESS.local) setupLocal();
  $('toCashier').hidden = !isOwner();
  if (SESS.offline) $('fileMsg').textContent = 'إنت من غير نت. بتشوف آخر بيانات اتحفظت على الجهاز.';

  renderBranches();
  render();
  await Promise.all([loadSnapshots(), loadExpenses(), loadFeatures(), loadInventory(), loadCustomers()]);
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
  const k = BRANCH === 'all' ? key(BRANCHES[0].id) : BRANCH;
  // A new file becomes the starting stock: what was entered here before it is assumed to be inside it.
  const b = BRANCHES.find((x) => key(x.id) === k);
  const since = SNAP.get(k)?.at ?? '';
  const later = (r, f) => inBranch(b)(r) && String(r[f]) > String(since);
  const entered = PURCHASES.filter((r) => later(r, 'created_at')).length + MOVES.filter((r) => later(r, 'happened_at')).length + POS_SALES.filter((r) => later(r, 'sold_at')).length;
  if (entered && !confirm(`الملف الجديد هيبقى هو الرصيد من دلوقتي. فيه ${entered} حاجة اتسجلت هنا بعد آخر رفع (طلبيات ومبيعات كاشير وتعديلات)، والبرنامج هيعتبر إنها موجودة في الملف ده. لو الملف من برنامج مبطلتش تستخدمه، دوس «إلغاء». ترفعه برضه؟`)) { $('fileMsg').textContent = ''; return; }
  $('fileMsg').textContent = 'بقرا الملفات…';
  try {
    const data = await readFiles(files);
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
